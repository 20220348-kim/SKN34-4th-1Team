"""Review Service declarations and Pod routing without testing live traffic."""

import copy
import json


def service_settings(spec):
    """Normalize API defaults; retain unknown fields and every port entry."""
    result = copy.deepcopy(spec)
    for field, default in (
        ("type", "ClusterIP"),
        ("selector", {}),
        ("sessionAffinity", "None"),
        ("publishNotReadyAddresses", False),
        ("externalIPs", []),
        ("loadBalancerSourceRanges", []),
    ):
        result.setdefault(field, default)
    if result["type"] in ("ClusterIP", "NodePort", "LoadBalancer"):
        result.setdefault("internalTrafficPolicy", "Cluster")
        result.setdefault("ipFamilyPolicy", "SingleStack")
    if result["type"] in ("NodePort", "LoadBalancer") or result["externalIPs"]:
        result.setdefault("externalTrafficPolicy", "Cluster")
    if result["type"] == "LoadBalancer":
        result.setdefault("allocateLoadBalancerNodePorts", True)
    if result["sessionAffinity"] == "ClientIP":
        result.setdefault("sessionAffinityConfig", {}).setdefault(
            "clientIP", {}
        ).setdefault("timeoutSeconds", 10800)
    for field in ("externalIPs", "loadBalancerSourceRanges"):
        result[field] = sorted(result[field])
    ports = []
    for port in result.get("ports", []):
        port.setdefault("protocol", "TCP")
        if port.get("targetPort") in (None, "", 0):
            port["targetPort"] = port["port"]
        ports.append(json.dumps(port, sort_keys=True))
    result["ports"] = sorted(ports)
    return result


def service_review(actual, expected, deployment, expected_deployment):
    """Return fixed paths/codes only, never selectors, IPs, names or port values."""
    observed = service_settings(actual["spec"])
    reference = service_settings(expected["spec"])
    changed = set()
    # Ordinary addresses/families are allocated by the cluster when the chart
    # leaves them unspecified. Headless mode still changes routing semantics.
    if (observed.get("clusterIP") == "None") != (reference.get("clusterIP") == "None"):
        changed.add("service.clusterIP")
    for field in ("clusterIP", "clusterIPs", "ipFamilies"):
        if field not in reference:
            observed.pop(field, None)
    known = {
        "type",
        "selector",
        "ports",
        "clusterIP",
        "clusterIPs",
        "ipFamilies",
        "ipFamilyPolicy",
        "sessionAffinity",
        "sessionAffinityConfig",
        "publishNotReadyAddresses",
        "internalTrafficPolicy",
        "externalTrafficPolicy",
        "externalName",
        "externalIPs",
        "loadBalancerIP",
        "loadBalancerClass",
        "loadBalancerSourceRanges",
        "allocateLoadBalancerNodePorts",
        "healthCheckNodePort",
        "trafficDistribution",
    }
    for field in observed.keys() | reference.keys():
        if observed.get(field) != reference.get(field):
            changed.add(f"service.{field}" if field in known else "service.otherFields")
    actual_spec, expected_spec = deployment["spec"], expected_deployment["spec"]
    if actual_spec.get("selector") != expected_spec.get("selector"):
        changed.add("deployment.selector")
    template = actual_spec["template"]
    labels = template.get("metadata", {}).get("labels", {})
    if labels != expected_spec["template"].get("metadata", {}).get("labels", {}):
        changed.add("deployment.podLabels")
    errors = set()
    selector = actual["spec"].get("selector", {})
    if not selector or any(labels.get(key) != value for key, value in selector.items()):
        errors.add("selector_does_not_match_pod")
    for port in actual["spec"].get("ports", []):
        target = port.get("targetPort") or port["port"]
        if isinstance(target, str):
            matches = [
                entry
                for container in template["spec"]["containers"]
                for entry in container.get("ports", [])
                if entry.get("name") == target
                and entry.get("protocol", "TCP") == port.get("protocol", "TCP")
            ]
            if len(matches) != 1:
                errors.add("named_target_port_unresolved_or_ambiguous")
        # Numeric targetPorts need no declared containerPort. This review does
        # not prove that a process listens there, or that endpoints are ready.
    return {"changedFields": sorted(changed), "routingErrors": sorted(errors)}
