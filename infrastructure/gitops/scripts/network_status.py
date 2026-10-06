"""Read Service/EndpointSlice/Pod relationships without sending application traffic."""

import ipaddress
import json
import subprocess
from datetime import datetime, timezone

from check_msa import SERVICES
from portfolio_cluster import run


READ_ERRORS = (
    OSError,
    ValueError,
    KeyError,
    TypeError,
    AttributeError,
    subprocess.SubprocessError,
)
SERVICE_LABEL = "kubernetes.io/service-name"


def selects(selector, pod):
    labels = pod["metadata"].get("labels", {})
    return bool(selector) and all(
        labels.get(key) == value for key, value in selector.items()
    )


def read_resources(nk, namespace):
    payload = json.loads(
        run(
            nk + ["get", "services,pods,endpointslices.discovery.k8s.io", "-o", "json"],
            capture=True,
            timeout=15,
        )
    )
    if payload.get("metadata", {}).get("continue") or not isinstance(
        payload["items"], list
    ):
        raise ValueError("Incomplete network observation")
    items = payload["items"]
    services = [
        item
        for item in items
        if item["kind"] == "Service" and item["metadata"]["name"] in SERVICES
    ]
    resources = {}
    identities = set()
    for item in items:
        kind, meta = item["kind"], item["metadata"]
        relevant = (
            kind == "Service"
            and meta["name"] in SERVICES
            or kind == "EndpointSlice"
            and meta.get("labels", {}).get(SERVICE_LABEL) in SERVICES
            or kind == "Pod"
            and any(selects(s["spec"].get("selector", {}), item) for s in services)
        )
        if not relevant:
            continue
        key = (kind, meta["name"])
        if (
            meta.get("namespace") != namespace
            or not meta.get("uid")
            or not meta.get("resourceVersion")
            or key in resources
            or meta["uid"] in identities
        ):
            raise ValueError("Invalid network resource identity")
        resources[key] = item
        identities.add(meta["uid"])
    return resources


def pod_ready(pod):
    return (
        not pod["metadata"].get("deletionTimestamp")
        and pod.get("status", {}).get("phase") == "Running"
        and any(
            c.get("type") == "Ready" and c.get("status") == "True"
            for c in pod.get("status", {}).get("conditions", [])
        )
    )


def target_ports(service, pod):
    """Resolve each Service port against this Pod, retaining name and protocol."""
    resolved = []
    for port in service["spec"]["ports"]:
        protocol = port.get("protocol", "TCP")
        target = port.get("targetPort") or port["port"]
        if isinstance(target, str):
            matches = [
                entry["containerPort"]
                for container in pod["spec"]["containers"]
                for entry in container.get("ports", [])
                if entry.get("name") == target
                and entry.get("protocol", "TCP") == protocol
            ]
            if len(matches) != 1:
                return None
            target = matches[0]
        if type(target) is not int or not 1 <= target <= 65535:
            return None
        resolved.append(
            (port.get("name") or "", protocol, target, port.get("appProtocol"))
        )
    return sorted(resolved)


def service_status(name, resources, namespace):
    report = {
        "service": name,
        "status": "FAIL",
        "issues": [],
        "slice_count": 0,
        "selected_pod_count": 0,
        "ready_pod_count": 0,
        "ready_endpoint_count": 0,
    }
    service = resources.get(("Service", name))
    if service is None:
        report["issues"] = ["SERVICE_MISSING"]
        return report
    issues = set()
    if service["metadata"].get("deletionTimestamp"):
        issues.add("SERVICE_TERMINATING")
    selector = service["spec"].get("selector", {})
    if not selector or service["spec"].get("type") == "ExternalName":
        report["issues"] = sorted(issues | {"POD_SELECTOR_REQUIRED"})
        return report
    ports = service["spec"].get("ports", [])
    if not ports or len({p.get("name") or "" for p in ports}) != len(ports):
        issues.add("SERVICE_PORTS_INVALID")
    families = service["spec"].get("ipFamilies", [])
    if (
        not families
        or len(set(families)) != len(families)
        or not set(families) <= {"IPv4", "IPv6"}
    ):
        raise ValueError("Unknown Service address families")
    pods = {
        pod["metadata"]["uid"]: pod
        for (kind, _), pod in resources.items()
        if kind == "Pod" and selects(selector, pod)
    }
    ready_pods = {uid for uid, pod in pods.items() if pod_ready(pod)}
    report["selected_pod_count"] = len(pods)
    report["ready_pod_count"] = len(ready_pods)
    if not pods:
        issues.add("SELECTED_PODS_MISSING")
    elif len(ready_pods) != len(pods):
        issues.add("SELECTED_PODS_NOT_READY")
    slices = [
        item
        for (kind, _), item in resources.items()
        if kind == "EndpointSlice"
        and item["metadata"].get("labels", {}).get(SERVICE_LABEL) == name
    ]
    report["slice_count"] = len(slices)
    if not slices:
        issues.add("ENDPOINT_SLICES_MISSING")
    covered = set()
    for item in slices:
        meta = item["metadata"]
        if meta.get("deletionTimestamp") or not any(
            owner.get("kind") == "Service"
            and owner.get("apiVersion") == "v1"
            and owner.get("name") == name
            and owner.get("uid") == service["metadata"]["uid"]
            and owner.get("controller") is True
            for owner in meta.get("ownerReferences", [])
        ):
            issues.add("ENDPOINT_SLICE_OWNER_INVALID")
            continue
        family = item["addressType"]
        if family not in families:
            issues.add("ENDPOINT_ADDRESS_FAMILY_MISMATCH")
            continue
        if any(
            type(p.get("port")) is not int or not 1 <= p["port"] <= 65535
            for p in item.get("ports", [])
        ):
            issues.add("ENDPOINT_PORT_MISMATCH")
            continue
        slice_ports = sorted(
            (
                p.get("name") or "",
                p.get("protocol") or "TCP",
                p.get("port"),
                p.get("appProtocol"),
            )
            for p in item.get("ports", [])
        )
        for endpoint in item["endpoints"]:
            reference = endpoint.get("targetRef", {})
            pod = pods.get(reference.get("uid"))
            if (
                pod is None
                or reference.get("kind") != "Pod"
                or reference.get("namespace") != namespace
                or reference.get("name") != pod["metadata"]["name"]
            ):
                issues.add("ENDPOINT_TARGET_MISMATCH")
                continue
            addresses = endpoint.get("addresses", [])
            pod_ips = {p["ip"] for p in pod.get("status", {}).get("podIPs", [])}
            if (
                len(addresses) != 1
                or addresses[0] not in pod_ips
                or "IPv" + str(ipaddress.ip_address(addresses[0]).version) != family
            ):
                issues.add("ENDPOINT_ADDRESS_MISMATCH")
                continue
            expected_ports = target_ports(service, pod)
            if not expected_ports or slice_ports != expected_ports:
                issues.add("ENDPOINT_PORT_MISMATCH")
                continue
            conditions = endpoint.get("conditions", {})
            if any(
                conditions.get(key) is not None and type(conditions[key]) is not bool
                for key in ("ready", "serving", "terminating")
            ):
                raise ValueError("Invalid endpoint conditions")
            # API nil ready/serving means true; still require a live Ready Pod.
            if (
                conditions.get("ready") is False
                or conditions.get("serving") is False
                or conditions.get("terminating") is True
                or not pod_ready(pod)
            ):
                issues.add("ENDPOINT_NOT_READY")
                continue
            # The same endpoint can temporarily appear in multiple slices.
            covered.add((pod["metadata"]["uid"], family))
    report["ready_endpoint_count"] = len(covered)
    if not covered:
        issues.add("NO_READY_ENDPOINTS")
    if covered != {(uid, family) for uid in ready_pods for family in families}:
        issues.add("ENDPOINT_COVERAGE_INCOMPLETE")
    report["issues"] = sorted(issues)
    report["status"] = "FAIL" if issues else "PASS"
    return report


def snapshot(settings, nk):
    """Caller verifies the dedicated context/owner before any reads here."""
    report = {
        "schema_version": 1,
        "scope": "service_endpoint_snapshot",
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "status": "UNKNOWN",
        "issues": [],
        "services": [],
        "traffic_verified": False,
        "network_policy_verified": False,
        "services_changed": False,
    }
    try:
        resources = read_resources(nk, settings["namespace"])
        report["services"] = [
            service_status(name, resources, settings["namespace"]) for name in SERVICES
        ]
        after = read_resources(nk, settings["namespace"])
        if resources != after:
            report["issues"].append("NETWORK_CHANGED_DURING_CHECK")
            # Earlier per-service results must not look like current evidence.
            for service in report["services"]:
                service["status"] = "UNKNOWN"
            return report
        report["status"] = (
            "PASS" if all(s["status"] == "PASS" for s in report["services"]) else "FAIL"
        )
    except READ_ERRORS:
        report["issues"].append("NETWORK_INSPECTION_FAILED")
        for service in report["services"]:
            service["status"] = "UNKNOWN"
    return report
