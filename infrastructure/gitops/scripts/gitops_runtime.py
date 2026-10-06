"""Read existing local overrides before planning default public Argo workloads."""

import copy
import hashlib
import json
import re
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

import connected_runtime
import fork_cluster as cluster
from gitops_service import service_review
import ops_runtime
import yaml


SCOPE = "local_overrides_and_service_runtime"


def chart_inputs():
    chart = cluster.ROOT / "charts/govbiz-service"
    return {
        path.relative_to(chart).as_posix(): path.read_bytes()
        for path in sorted(chart.rglob("*"))
        if path.is_file()
    }


def rendered_defaults(helm, references, chart):
    """Render the captured local inputs, without credentials or cluster access."""
    deployments = {}
    services = {}
    with tempfile.TemporaryDirectory(prefix="govbiz-runtime-review-") as directory:
        root = Path(directory)
        for name, payload in chart.items():
            path = root / "chart" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        for service, (payload, rows) in references.items():
            values = root / f"{service}.yaml"
            values.write_bytes(payload)
            result = subprocess.run(
                [
                    helm,
                    "template",
                    service,
                    str(root / "chart"),
                    "-n",
                    cluster.NAMESPACE,
                    "-f",
                    str(values),
                ],
                capture_output=True,
                check=True,
                timeout=30,
            )
            documents = list(yaml.safe_load_all(result.stdout))
            candidates = [
                item for item in documents if item and item.get("kind") == "Deployment"
            ]
            if (
                len(candidates) != 1
                or candidates[0]["metadata"]["name"] != service
                or candidates[0]["metadata"].get("namespace") != cluster.NAMESPACE
            ):
                raise ValueError("Unexpected local reference Deployment")
            deployment = candidates[0]
            containers = deployment["spec"]["template"]["spec"]["containers"]
            if [item["name"] for item in containers] != [service] or (
                environment_rows(containers[0]["env"]) != environment_rows(rows)
            ):
                raise ValueError("Local reference environment differs from Helm")
            deployments[service] = deployment
            candidates = [
                item for item in documents if item and item.get("kind") == "Service"
            ]
            if (
                len(candidates) != 1
                or candidates[0]["metadata"].get("name") != service
                or candidates[0]["metadata"].get("namespace") != cluster.NAMESPACE
            ):
                raise ValueError("Unexpected local reference Service")
            services[service] = candidates[0]
    return deployments, services


def named_entries(rows):
    """Compare named lists without order differences or duplicate overwrites."""
    result = {}
    for row in rows:
        name = row.get("name")
        if not isinstance(name, str) or name in result:
            raise ValueError("Ambiguous named runtime entries")
        result[name] = row
    return result


def execution_review(actual, expected):
    """Report fixed field names only: commands and storage paths may be sensitive."""
    changed = []
    actual_spec, expected_spec = actual["spec"], expected["spec"]
    for field in ("replicas", "strategy"):
        if actual_spec.get(field) != expected_spec.get(field):
            changed.append(field)
    actual_pod = actual_spec["template"]["spec"]
    expected_pod = expected_spec["template"]["spec"]
    if named_entries(actual_pod.get("volumes", [])) != named_entries(
        expected_pod.get("volumes", [])
    ):
        changed.append("volumes")
    if actual_pod.get("initContainers", []) != expected_pod.get("initContainers", []):
        changed.append("initContainers")
    actual_containers = named_entries(actual_pod["containers"])
    for container in expected_pod["containers"]:
        name = container["name"]
        if name not in actual_containers:
            # Missing/extra containers already have their own blocking report.
            continue
        observed = actual_containers[name]
        for field in ("command", "args", "volumeMounts", "volumeDevices"):
            actual_value, expected_value = (
                observed.get(field, []),
                container.get(field, []),
            )
            if field == "volumeDevices":
                actual_value, expected_value = (
                    named_entries(actual_value),
                    named_entries(expected_value),
                )
            elif field == "volumeMounts":
                # A single volume can be mounted at multiple paths. Preserve all
                # entries, including duplicates, but ignore order for comparison.
                actual_value = sorted(
                    json.dumps(row, sort_keys=True) for row in actual_value
                )
                expected_value = sorted(
                    json.dumps(row, sort_keys=True) for row in expected_value
                )
            if actual_value != expected_value:
                changed.append(f"containers.{name}.{field}")
    return {"changedFields": sorted(changed)}


def probe_settings(probe):
    """Retain the full probe, including handlers/headers, while applying API defaults."""
    if probe is None:
        return None
    result = copy.deepcopy(probe)
    result.setdefault("initialDelaySeconds", 0)
    for field, default in (
        ("timeoutSeconds", 1),
        ("periodSeconds", 10),
        ("successThreshold", 1),
        ("failureThreshold", 3),
    ):
        if result.get(field, 0) == 0:
            result[field] = default
    if "httpGet" in result:
        for field, default in (("scheme", "HTTP"), ("path", "/")):
            if not result["httpGet"].get(field):
                result["httpGet"][field] = default
    return result


def resource_settings(resources):
    """Compare SI/binary/exponent quantities exactly, without float arithmetic.

    This is not a Kubernetes admission validator or its saturation/rounding code.
    Unknown or oversized values fail closed instead of being silently ignored.
    """
    result = copy.deepcopy(resources)
    decimal = {
        "": 0,
        "n": -9,
        "u": -6,
        "m": -3,
        "k": 3,
        "M": 6,
        "G": 9,
        "T": 12,
        "P": 15,
        "E": 18,
    }
    binary = {unit + "i": 10 * exponent for exponent, unit in enumerate("KMGTPE", 1)}
    for field in ("requests", "limits"):
        values = result.setdefault(field, {})
        for name, value in values.items():
            if type(value) not in (str, int, float) or len(str(value)) > 128:
                raise ValueError("Unsupported runtime resource quantity")
            match = re.fullmatch(
                r"([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))"
                r"(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]|[eE][+-]?[0-9]{1,2})?",
                str(value),
            )
            if not match:
                raise ValueError("Unsupported runtime resource quantity")
            number, unit = match.groups()
            unit = unit or ""
            if unit in binary:
                factor = Fraction(2) ** binary[unit]
            elif unit in decimal:
                factor = Fraction(10) ** decimal[unit]
            else:
                factor = Fraction(10) ** int(unit[1:])
            amount = Fraction(number) * factor
            if amount > 2**63 - 1:
                raise ValueError("Unsupported runtime resource quantity")
            values[name] = amount
    return result


def policy_review(actual, expected):
    """Inspect declared health/resources/access settings, not live RBAC or health."""
    actual_pod = actual["spec"]["template"]["spec"]
    expected_pod = expected["spec"]["template"]["spec"]
    changed = []
    for field, default in (
        ("securityContext", {}),
        ("automountServiceAccountToken", None),
        ("serviceAccountName", ""),
        ("serviceAccount", ""),
        ("hostNetwork", False),
        ("hostPID", False),
        ("hostIPC", False),
        ("shareProcessNamespace", False),
        ("dnsPolicy", "ClusterFirst"),
        ("dnsConfig", {}),
        ("hostAliases", []),
        ("terminationGracePeriodSeconds", 30),
    ):
        if actual_pod.get(field, default) != expected_pod.get(field, default):
            changed.append(field)
    if resource_settings(actual_pod.get("resources", {})) != resource_settings(
        expected_pod.get("resources", {})
    ):
        changed.append("resources")
    actual_containers = named_entries(actual_pod["containers"])
    for container in expected_pod["containers"]:
        name = container["name"]
        if name not in actual_containers:
            continue
        observed = actual_containers[name]
        for field in ("startupProbe", "livenessProbe", "readinessProbe"):
            if probe_settings(observed.get(field)) != probe_settings(
                container.get(field)
            ):
                changed.append(f"containers.{name}.{field}")
        for field, default in (("securityContext", {}), ("lifecycle", {})):
            if observed.get(field, default) != container.get(field, default):
                changed.append(f"containers.{name}.{field}")
        if resource_settings(observed.get("resources", {})) != resource_settings(
            container.get("resources", {})
        ):
            changed.append(f"containers.{name}.resources")
        ports = []
        for item in (observed, container):
            ports.append(
                sorted(
                    json.dumps({"protocol": "TCP", **port}, sort_keys=True)
                    for port in item.get("ports", [])
                )
            )
        if ports[0] != ports[1]:
            changed.append(f"containers.{name}.ports")
    return {"changedFields": sorted(changed)}


def portfolio_defaults(service):
    """Local reference only; neither a published release nor an approved overlay."""
    if service not in cluster.SERVICES:
        raise ValueError("Unknown service reference")
    path = cluster.ROOT / f"environments/portfolio/{service}.yaml"
    payload = path.read_bytes()
    values = yaml.safe_load(payload)
    expected = [{"name": name, "value": value} for name, value in values["env"].items()]
    expected.extend(
        {
            "name": name,
            "valueFrom": {"secretKeyRef": {"name": values["secretName"], "key": name}},
        }
        for name in values["secretKeys"]
    )
    return payload, expected


def environment_rows(rows):
    """Keep values internal; reject ambiguity instead of losing duplicate entries."""
    result = {}
    for row in rows:
        name = row.get("name")
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,255}", name)
            or name in result
            or set(row) not in ({"name", "value"}, {"name", "valueFrom"})
            or ("value" in row and not isinstance(row["value"], str))
        ):
            raise ValueError("Ambiguous service environment entries")
        if "valueFrom" in row:
            reference = row["valueFrom"]
            if (
                not isinstance(reference, dict)
                or len(reference) != 1
                or not set(reference)
                <= {"secretKeyRef", "configMapKeyRef", "fieldRef", "resourceFieldRef"}
                or not isinstance(next(iter(reference.values())), dict)
            ):
                raise ValueError("Unknown service environment reference")
        result[name] = row
    return result


def environment_review(service, deployment, reference):
    """Compare declared environments without resolving or reporting their values."""
    payload, rows = reference
    expected = environment_rows(rows)
    containers = deployment["spec"]["template"]["spec"]["containers"]
    names = [item["name"] for item in containers]
    if len(names) != len(set(names)) or any(
        not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name)
        for name in names
    ):
        raise ValueError("Invalid service container names")
    changes = {}
    indirect = []
    for item in containers:
        name = item["name"]
        if item.get("envFrom"):
            indirect.append(name)
        if name != service and not (service == "ops-service" and name == "ops-sync"):
            continue
        actual = environment_rows(item.get("env", []))
        changes[name] = {
            "changed": sorted(
                key
                for key in actual.keys() & expected.keys()
                if actual[key] != expected[key]
            ),
            "runtimeOnly": sorted(actual.keys() - expected.keys()),
            "missing": sorted(expected.keys() - actual.keys()),
        }
    return {
        "reference": (
            "checkout_portfolio_ops_defaults"
            if service == "ops-service"
            else "checkout_portfolio_service_defaults"
        ),
        "referenceSha256": hashlib.sha256(payload).hexdigest(),
        "containers": {
            "runtimeOnly": sorted(set(names) - {service}),
            "missing": sorted({service} - set(names)),
        },
        "environmentChanges": changes,
        "uninspectedEnvFrom": sorted(indirect),
    }


def preservation_review(inputs, deployments, references):
    """List differences for review, never copy live configuration into Argo values."""
    reviews = {
        service: environment_review(service, deployments[service], references[service])
        for service in cluster.SERVICES
    }
    profile = inputs["integration"] or {}
    return {
        # Retain the original Ops fields for report consumers.
        **reviews.pop("ops-service"),
        "scope": "service_configuration_and_saved_integrations",
        "serviceReviews": reviews,
        "integrationFeatures": sorted(profile.get("features", [])),
        "modelSettingNames": sorted(profile.get("modelKeys", [])),
        "connectionRecordConflict": len(
            {record["composeProject"] for record in inputs["connections"].values()}
        )
        > 1,
        "configurationValuesIncluded": False,
        "overlayGenerated": False,
    }


def local_inputs(state, settings):
    records = {}
    for name in (ops_runtime.PROFILE, ops_runtime.BRIDGE):
        path = state / name
        if path.exists() or path.is_symlink():
            records[name] = ops_runtime.read_connection(path, settings)
    images = state / "dev-images.json"
    return {
        "integration": connected_runtime.load_profile(state, settings),
        "connections": records,
        "development_images": images.exists() or images.is_symlink(),
    }


def preflight(state, fork, helm="helm"):
    """Detect local connection conflicts, not migration or deployment readiness."""
    state = Path(state)
    settings = cluster.load_settings(state)
    if settings["repository"].lower() != fork.repository.lower():
        raise ValueError("Runtime state belongs to another repository")
    # Verifies loopback context, owner marker and absence of Argo ownership first.
    cluster.require_dev(state, settings)
    inputs = local_inputs(state, settings)
    _, namespaced, _ = cluster.commands(state, settings)

    def read_resource(kind, service):
        command = namespaced + ["get", kind.lower(), service, "-o", "json"]
        resource = json.loads(cluster.run(command, capture=True, timeout=15))
        meta = resource["metadata"]
        if (
            resource.get("kind") != kind
            or meta.get("name") != service
            or meta.get("namespace") != settings["namespace"]
            or not meta.get("uid")
            or not meta.get("resourceVersion")
            or meta.get("deletionTimestamp")
        ):
            raise ValueError("Missing or unstable runtime resource identity")
        return resource

    deployments = {
        service: read_resource("Deployment", service) for service in cluster.SERVICES
    }
    services = {
        service: read_resource("Service", service) for service in cluster.SERVICES
    }
    references = {service: portfolio_defaults(service) for service in cluster.SERVICES}
    chart = chart_inputs()
    expected, expected_services = rendered_defaults(helm, references, chart)
    containers = deployments["ops-service"]["spec"]["template"]["spec"]["containers"]
    preservation = preservation_review(inputs, deployments, references)
    preservation["runtimeReviews"] = {
        service: execution_review(deployments[service], expected[service])
        for service in cluster.SERVICES
    }
    preservation["policyReviews"] = {
        service: policy_review(deployments[service], expected[service])
        for service in cluster.SERVICES
    }
    preservation["networkReviews"] = {
        service: service_review(
            services[service],
            expected_services[service],
            deployments[service],
            expected[service],
        )
        for service in cluster.SERVICES
    }
    preservation["chartSha256"] = hashlib.sha256(
        json.dumps(
            {
                name: hashlib.sha256(payload).hexdigest()
                for name, payload in chart.items()
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    blockers = []
    if inputs["integration"] is not None:
        blockers.append("local_integration_profile")
    if inputs["development_images"]:
        blockers.append("local_development_images")
    try:
        ops_runtime.require_bootstrap_ops(state, containers)
    except ValueError:
        blockers.append("connected_or_unverified_ops")
    if inputs["connections"] and "connected_or_unverified_ops" not in blockers:
        blockers.append("connected_or_unverified_ops")
    if [item["name"] for item in containers] != ["ops-service"]:
        blockers.append("ops_container_layout_differs")
    if any(
        any(change.values()) for change in preservation["environmentChanges"].values()
    ):
        blockers.append("ops_environment_differs")
    if preservation["uninspectedEnvFrom"]:
        blockers.append("ops_env_from_uninspected")
    service_reviews = preservation["serviceReviews"].values()
    if any(any(review["containers"].values()) for review in service_reviews):
        blockers.append("service_container_layout_differs")
    if any(
        any(change.values())
        for review in service_reviews
        for change in review["environmentChanges"].values()
    ):
        blockers.append("service_environment_differs")
    if any(review["uninspectedEnvFrom"] for review in service_reviews):
        blockers.append("service_env_from_uninspected")
    if any(
        review["changedFields"] for review in preservation["runtimeReviews"].values()
    ):
        blockers.append("service_execution_or_storage_differs")
    if any(
        review["changedFields"] for review in preservation["policyReviews"].values()
    ):
        blockers.append("service_runtime_policy_differs")
    if any(any(review.values()) for review in preservation["networkReviews"].values()):
        blockers.append("service_routing_differs")
    # A result describes only a stable observation, never a reusable approval.
    for kind, resources in (("Deployment", deployments), ("Service", services)):
        for service, resource in resources.items():
            current = read_resource(kind, service)
            if (
                any(
                    current["metadata"][key] != resource["metadata"][key]
                    for key in ("uid", "resourceVersion")
                )
                or current.get("spec") != resource["spec"]
            ):
                raise ValueError("Local runtime changed during preflight")
    for service in cluster.SERVICES:
        if portfolio_defaults(service) != references[service]:
            raise ValueError("Local runtime changed during preflight")
    if (
        cluster.load_settings(state) != settings
        or local_inputs(state, settings) != inputs
        or chart_inputs() != chart
    ):
        raise ValueError("Local runtime changed during preflight")
    cluster.require_dev(state, settings)
    return {
        "schema": "msa-local-runtime-preflight-v1",
        "scope": SCOPE,
        "inspectedServices": list(cluster.SERVICES),
        "status": "BLOCKED" if blockers else "NO_LOCAL_OVERRIDES",
        "stateId": settings["stateId"],
        "blockers": blockers,
        "preservationReview": preservation,
        "servicesChanged": False,
        "databaseChanged": False,
        "deploymentAuthorized": False,
    }
