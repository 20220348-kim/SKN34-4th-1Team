"""Rehearse existing environment/sync settings with Helm; never export or apply them."""

import re
import subprocess

import gitops_runtime as runtime
import yaml


def reference(service, deployment, original):
    """Translate only environments and the existing Ops sync into current chart values."""
    values = yaml.safe_load(original[0])
    containers = runtime.named_entries(
        deployment["spec"]["template"]["spec"]["containers"]
    )
    allowed = {service, "ops-sync"} if service == "ops-service" else {service}
    if service not in containers or not set(containers) <= allowed:
        raise ValueError("unsupported_container_layout")
    if any(item.get("envFrom") for item in containers.values()):
        raise ValueError("env_from_requires_review")
    primary = containers[service]
    rows = runtime.environment_rows(primary.get("env", []))
    sync = containers.get("ops-sync")
    if sync is not None:
        if runtime.environment_rows(sync.get("env", [])) != rows:
            raise ValueError("ops_sync_environment_differs")
        if sync.get("image") != primary.get("image"):
            raise ValueError("ops_sync_image_differs")
    values["opsSync"] = {"enabled": sync is not None}
    values["env"], values["secretKeys"] = {}, []
    for name, row in sorted(rows.items()):
        if "value" in row:
            if re.search(
                r"(PASSWORD|SECRET|TOKEN|API_KEY|SERVICE_KEY|PRIVATE_KEY)$",
                name,
                re.IGNORECASE,
            ):
                raise ValueError("literal_credential_requires_secret")
            values["env"][name] = row["value"]
        elif row["valueFrom"] == {
            "secretKeyRef": {"name": values["secretName"], "key": name}
        }:
            values["secretKeys"].append(name)
        else:
            # The chart supports one Secret with identical env/key names only.
            # Do not flatten ConfigMap, fieldRef, optional or renamed references.
            raise ValueError("unsupported_environment_reference")
    return yaml.safe_dump(values, sort_keys=True).encode(), list(rows.values())


def review(deployments, services, references, chart, helm="helm"):
    """Return field names only; existing transition blockers remain authoritative."""
    report = {
        "status": "BLOCKED",
        "scope": "environment_sync_execution_policy_and_service_declarations",
        "services": {},
        "configurationValuesIncluded": False,
        "overlayWritten": False,
        "imagesVerified": False,
        "deploymentAuthorized": False,
    }
    candidates = {}
    known_reasons = {
        "unsupported_container_layout",
        "env_from_requires_review",
        "ops_sync_environment_differs",
        "ops_sync_image_differs",
        "literal_credential_requires_secret",
        "unsupported_environment_reference",
    }
    for service in runtime.cluster.SERVICES:
        details = {"status": "NOT_RENDERED", "reasons": []}
        report["services"][service] = details
        try:
            candidates[service] = reference(
                service, deployments[service], references[service]
            )
        except (
            ValueError,
            KeyError,
            TypeError,
            AttributeError,
            yaml.YAMLError,
        ) as error:
            details.update(
                status="BLOCKED",
                reasons=[
                    str(error) if str(error) in known_reasons else "invalid_environment"
                ],
            )
    if len(candidates) != len(runtime.cluster.SERVICES):
        return report
    try:
        expected, expected_services = runtime.rendered_defaults(helm, candidates, chart)
        for service in runtime.cluster.SERVICES:
            actual = deployments[service]
            wanted = expected[service]
            details = report["services"][service]
            execution = runtime.execution_review(actual, wanted)["changedFields"]
            policy = runtime.policy_review(actual, wanted)["changedFields"]
            network = runtime.service_review(
                services[service], expected_services[service], actual, wanted
            )
            differences = {
                "execution": execution,
                "policy": policy,
                "network": network["changedFields"],
                "routing": network["routingErrors"],
            }
            details.update(
                status="BLOCKED"
                if any(differences.values())
                else "MATCHES_INSPECTED_FIELDS",
                differences=differences,
            )
    except (
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        OSError,
        subprocess.SubprocessError,
        yaml.YAMLError,
    ):
        # Helm diagnostics may contain observed env values: never report them.
        report.update(
            status="UNKNOWN", reason="preservation_render_or_comparison_failed"
        )
        for details in report["services"].values():
            details.clear()
            details.update(
                status="UNKNOWN", reasons=["preservation_render_or_comparison_failed"]
            )
        return report
    if all(
        details["status"] == "MATCHES_INSPECTED_FIELDS"
        for details in report["services"].values()
    ):
        report["status"] = "MATCHES_INSPECTED_FIELDS"
    # No candidate values or hashes of potentially secret literals leave this function.
    return report
