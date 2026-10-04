"""Check rendered Compose JSON from stdin without printing credentials or starting services."""

import json
import re
import sys


def check(config):
    services = config["services"]
    prefect = services["prefect"]
    assert prefect.get("restart") == "unless-stopped", (
        "Prefect must recover after Docker restarts while respecting manual stops"
    )
    health = prefect.get("healthcheck", {})
    assert (
        health.get("test")
        and health["test"][0] in {"CMD", "CMD-SHELL"}
        and not health.get("disable")
    ), "Prefect readiness healthcheck required"
    for name in ("evaluation-runner", "ops-sync"):
        assert (
            services[name].get("depends_on", {}).get("prefect", {}).get("condition")
            == "service_healthy"
        ), "Ops workers must wait for Prefect readiness"
    gateway = services["ops-artifacts"]
    assert not gateway.get("ports"), "Artifact service must not publish host ports"
    assert gateway.get("read_only") is True, "Artifact image must remain read-only"
    assert gateway.get("cap_drop") == ["ALL"], "Artifact capabilities must be dropped"
    assert "no-new-privileges:true" in gateway.get("security_opt", []), (
        "Privilege guard missing"
    )
    assert set(gateway["environment"]) == {
        "LLMOPS_ARTIFACT_TOKEN",
        "LLMOPS_RESULTS_DIR",
        "LLMOPS_EVIDENCE_DIR",
    }, "Storage service must not receive database or model credentials"
    token = gateway["environment"]["LLMOPS_ARTIFACT_TOKEN"]
    assert re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token), (
        "Artifact token is missing or invalid"
    )
    mounts = {item["target"]: item for item in gateway["volumes"]}
    assert set(mounts) == {"/results", "/evaluation-data"}, "Unexpected storage mounts"
    assert all(item.get("read_only") is True for item in mounts.values()), (
        "Read-only mounts required"
    )
    writer = next(
        item
        for item in services["evaluation-runner"]["volumes"]
        if item["target"] == "/results"
    )
    assert writer["type"] == mounts["/results"]["type"] == "volume", (
        "Named results volume required"
    )
    assert writer["source"] == mounts["/results"]["source"], (
        "Reader and writer storage differs"
    )
    assert not writer.get("read_only"), "Runner must retain output write access"
    for name in ("ops-service", "ops-sync"):
        service = services[name]
        assert not service.get("volumes"), (
            "HTTP consumers must not retain filesystem mounts"
        )
        assert (
            service["environment"]["LLMOPS_ARTIFACT_URL"] == "http://ops-artifacts:8010"
        ), "Wrong artifact endpoint"
        assert service["environment"]["LLMOPS_ARTIFACT_TOKEN"] == token, (
            "Artifact token mismatch"
        )
        assert service["environment"]["LLMOPS_LIVE_ENABLED"] == "false", (
            "Paid evaluation forbidden"
        )
        assert service["build"]["context"] == gateway["build"]["context"], (
            "Ops and storage images must match"
        )
    runner = services["evaluation-runner"]["environment"]
    assert runner["LLMOPS_LIVE_ENABLED"] == "false" and not runner.get(
        "OPENAI_API_KEY"
    ), "Paid runner forbidden"

    bridge = config.get("networks", {}).get("ops-bridge")
    if bridge is not None:
        assert bridge.get("internal") is True and bridge.get("driver") == "bridge", (
            "Private Docker bridge required"
        )
        assert not bridge.get("external"), "Compose must own its private bridge"
        state_id = bridge.get("labels", {}).get("dev.govbiz.state-id", "")
        assert re.fullmatch(r"[a-f0-9]{32}", state_id), "Bridge state identity missing"
        assert bridge.get("name", "").endswith("-ops-" + state_id[:12]), (
            "Bridge network identity mismatch"
        )
        members = {
            name
            for name, service in services.items()
            if "ops-bridge" in service.get("networks", {})
        }
        assert members == {"prefect", "ops-artifacts"}, (
            "Only Prefect and artifacts may join the bridge"
        )
        assert all("default" in services[name]["networks"] for name in members), (
            "Compose internal routes must remain"
        )
        assert all(
            port.get("host_ip") == "127.0.0.1"
            for port in services["prefect"].get("ports", [])
        ), "Prefect must remain loopback-only"


if __name__ == "__main__":
    try:
        check(json.load(sys.stdin))
    except (AssertionError, KeyError, TypeError, ValueError) as error:
        message = (
            str(error) if isinstance(error, AssertionError) else "Invalid Compose model"
        )
        raise SystemExit(message) from None
    print(
        "PASS: private read-only artifact server, shared writer volume, unmounted HTTP consumers"
    )
