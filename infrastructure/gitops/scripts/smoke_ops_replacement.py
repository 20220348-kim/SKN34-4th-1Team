"""Replace the disposable Compose endpoints and verify explicit route refresh."""

import json
import subprocess
import time
from uuid import UUID

import fork_cluster
import fork_web
import ops_bridge
import smoke_ops_artifacts as artifacts
from smoke_ops_bridge import execute


def container(identity, project, service, network_name, network_id):
    raw = json.loads(
        execute(
            [
                "docker",
                "inspect",
                "--format",
                (
                    '{"Id":{{json .Id}},"Image":{{json .Image}},"Labels":{{json .Config.Labels}},'
                    '"Running":{{json .State.Running}},"Mounts":{{json .Mounts}},'
                    '"Networks":{{json .NetworkSettings.Networks}}}'
                ),
                identity,
            ]
        )
    )
    assert raw["Id"] == identity and raw["Running"] is True
    labels = raw["Labels"]
    assert labels["com.docker.compose.project"] == project
    assert labels["com.docker.compose.service"] == service
    assert str(labels.get("com.docker.compose.oneoff", "false")).lower() == "false"
    target, volume, writable = {
        "prefect": ("/var/lib/prefect", "prefect-data", True),
        "ops-artifacts": ("/results", "ops-results", False),
    }[service]
    mounts = [mount for mount in raw["Mounts"] if mount["Destination"] == target]
    assert len(mounts) == 1
    mount = mounts[0]
    assert mount["Type"] == "volume" and mount["Name"] == project + "_" + volume
    assert mount["RW"] is writable
    attachment = raw["Networks"][network_name]
    assert attachment["NetworkID"] == network_id and attachment["IPAddress"]
    return {
        "id": identity,
        "image": raw["Image"],
        "volume": mount["Name"],
        "address": attachment["IPAddress"],
    }


def replace_endpoints(compose, env, project, network_name, before):
    def read(identity, service):
        return container(identity, project, service, network_name, before["networkId"])

    old = {
        service: read(identity, service)
        for service, identity in before["containers"].items()
    }
    execute(
        compose
        + [
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--pull",
            "never",
            "--force-recreate",
            "prefect",
        ],
        env=env,
        timeout=180,
    )
    prefect = execute(compose + ["ps", "-q", "prefect"], env=env).split()
    assert len(prefect) == 1
    new = {"prefect": read(prefect[0], "prefect")}
    assert new["prefect"]["id"] != old["prefect"]["id"]
    for key in ("image", "volume"):
        assert new["prefect"][key] == old["prefect"][key]

    # Keep the old read-only endpoint alive until its replacement has a distinct IP.
    # This proves real address churn even when Docker would reuse a released address.
    execute(
        compose
        + [
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--pull",
            "never",
            "--no-recreate",
            "--scale",
            "ops-artifacts=2",
            "ops-artifacts",
        ],
        env=env,
        timeout=120,
    )
    identities = execute(compose + ["ps", "-q", "ops-artifacts"], env=env).split()
    assert len(identities) == 2 and len(set(identities)) == 2
    assert old["ops-artifacts"]["id"] in identities
    replacement = next(
        identity for identity in identities if identity != old["ops-artifacts"]["id"]
    )
    new["ops-artifacts"] = read(replacement, "ops-artifacts")
    for key in ("image", "volume"):
        assert new["ops-artifacts"][key] == old["ops-artifacts"][key]
    assert new["ops-artifacts"]["address"] != old["ops-artifacts"]["address"]
    assert read(old["ops-artifacts"]["id"], "ops-artifacts") == old["ops-artifacts"]
    # Only this verified fixture container is removed; named volumes are preserved.
    execute(["docker", "rm", "--force", old["ops-artifacts"]["id"]], timeout=60)
    assert execute(compose + ["ps", "-q", "ops-artifacts"], env=env).split() == [
        replacement
    ]
    return old, new


def service_identities(nk, settings, project, addresses):
    resources = ops_bridge.existing_resources(
        nk, ops_bridge.manifests(settings, project, addresses)
    )
    return {
        name: {
            "uid": value["metadata"]["uid"],
            "cluster_ip": value["spec"]["clusterIP"],
        }
        for (kind, name), value in resources.items()
        if kind == "Service"
    }


def wait_runtime(nk, run_id):
    run_id = str(UUID(run_id))
    command = nk + [
        "exec",
        "deployment/ops-service",
        "-c",
        "ops-service",
        "--",
        "python",
        "manage.py",
        "check_evaluation_runtime",
        "--run-id",
        run_id,
    ]
    deadline = time.monotonic() + 120
    while True:
        try:
            result = json.loads(execute(command, timeout=30))
        except subprocess.CalledProcessError:
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    "Replacement endpoints did not become ready"
                ) from None
            time.sleep(3)
            continue
        assert result["status"] == "PASS" and result["storage_transport"] == "http"
        assert result["result_artifact_verified"] is True
        assert all(value == "PASS" for value in result["checks"].values())
        return result


def verify(
    state, settings, compose, env, password, expected_run, expected_hash, report
):
    _, nk, _ = fork_cluster.commands(state, settings)
    project = report["compose_project"]
    artifacts.require_disposable(nk, compose, env, project)
    ops_bridge.connect(state, settings, project, check=True)
    before = ops_bridge.topology(settings, project)
    services_before = service_identities(nk, settings, project, before["addresses"])
    assert len(services_before) == 2
    evidence = {"status": "FAIL"}
    report["replacement_recovery"] = evidence
    report["evaluation_phase"] = "compose_endpoint_replacement"
    old, new = replace_endpoints(
        compose, env, project, ops_bridge.network_name(settings), before
    )
    after = ops_bridge.topology(settings, project)
    for key in ("networkId", "subnets", "nodeId", "nodeConnected"):
        assert before[key] == after[key]
    assert after["nodeConnected"] is True
    assert after["containers"] == {service: item["id"] for service, item in new.items()}
    assert after["addresses"] == {
        service: item["address"] for service, item in new.items()
    }
    evidence.update(old_endpoints=old, new_endpoints=new)

    report["evaluation_phase"] = "stale_replacement_route"
    try:
        ops_bridge.connect(state, settings, project, check=True)
    except ValueError as error:
        if "address changed" not in str(error):
            raise
    else:
        raise AssertionError("A real endpoint address change was not rejected")
    # The read-only check must not repair the stale route.
    desired = ops_bridge.manifests(settings, project, before["addresses"])
    resources = ops_bridge.existing_resources(nk, desired)
    for item in desired:
        if item["kind"] == "EndpointSlice":
            assert (
                resources[(item["kind"], item["metadata"]["name"])]["endpoints"]
                == item["endpoints"]
            )

    report["evaluation_phase"] = "replacement_route_refresh"
    ops_bridge.connect(state, settings, project)
    ops_bridge.connect(state, settings, project, check=True)
    assert (
        service_identities(nk, settings, project, after["addresses"]) == services_before
    )
    evidence["runtime"] = wait_runtime(nk, expected_run["id"])
    with fork_web.forwards(nk):
        evidence["old_result_access"] = artifacts.check_access(
            password, expected_run, expected_hash
        )
    evidence.update(
        container_ids_changed=True,
        artifact_address_changed=True,
        stale_check_read_only=True,
        services_preserved=True,
        volumes_preserved=True,
        original_report_sha256=expected_hash,
        routes_recovered=True,
    )
    # The caller runs a new free evaluation and checks its Kubernetes DB record before PASS.
