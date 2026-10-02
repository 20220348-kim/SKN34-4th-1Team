"""Connect one owned development kind node to private Compose HTTP endpoints.

No model calls, application patches, credential reads, host ports or Argo changes.
Run connect again after Compose replaces either container; check detects stale IPs.
"""

import argparse
import ipaddress
import json
import re
import subprocess
from pathlib import Path

from fork_cluster import (
    STATE,
    commands,
    load_settings,
    locked,
    require_dev,
    run,
    write_json,
)

ENDPOINTS = {
    "prefect": ("ops-compose-prefect", 4200),
    "ops-artifacts": ("ops-compose-artifacts", 8010),
}
MANAGER = "govbiz-ops-bridge"
STATE_KEY = "dev.govbiz.state-id"
PROJECT_KEY = "dev.govbiz.compose-project"


def network_name(settings):
    return settings["cluster"] + "-ops-" + settings["stateId"][:12]


def environment(settings):
    return (
        "GOVBIZ_OPS_BRIDGE_NETWORK="
        + network_name(settings)
        + "\n"
        + "GOVBIZ_OPS_BRIDGE_STATE_ID="
        + settings["stateId"]
        + "\n"
    )


def values():
    return {
        "opsSync": {"enabled": True},
        "env": {
            "CORE_API_URL": "http://core-service:8080",
            "DJANGO_COOKIE_SECURE": "false",
            "OPS_WEB_URL": "http://localhost:5173",
            "PREFECT_API_URL": "http://ops-compose-prefect:4200/api",
            "LLMOPS_ARTIFACT_URL": "http://ops-compose-artifacts:8010",
            "LLMOPS_LIVE_ENABLED": "false",
        },
        "secretName": "ops-runtime",
        "secretKeys": ["DJANGO_SECRET_KEY", "DB_PASSWORD", "LLMOPS_ARTIFACT_TOKEN"],
    }


def inspect_container(identity):
    # Project/service labels and addresses suffice; do not retrieve Config.Env.
    template = (
        '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},'
        '"Running":{{json .State.Running}},"Ports":{{json .HostConfig.PortBindings}},'
        '"Networks":{{json .NetworkSettings.Networks}}}'
    )
    return json.loads(
        run(
            [
                "docker",
                "inspect",
                "--type",
                "container",
                "--format",
                template,
                identity,
            ],
            capture=True,
            timeout=15,
        )
    )


def validate_network(settings, project, network, node, containers):
    """Validate the full bridge membership before connecting or publishing routes."""
    labels = network.get("Labels") or {}
    if (
        network.get("Name") != network_name(settings)
        or network.get("Driver") != "bridge"
        or network.get("Scope") != "local"
        or network.get("Internal") is not True
        or labels.get(STATE_KEY) != settings["stateId"]
        or labels.get("com.docker.compose.project") != project
        or labels.get("com.docker.compose.network") != "ops-bridge"
    ):
        raise ValueError(
            "Compose bridge ownership or internal network isolation does not match"
        )
    if (
        node.get("Name") != "/" + settings["cluster"] + "-control-plane"
        or node.get("Running") is not True
        or node.get("Labels", {}).get("io.x-k8s.kind.cluster") != settings["cluster"]
        or node.get("Labels", {}).get("io.x-k8s.kind.role") != "control-plane"
    ):
        raise ValueError("Docker node does not match the owned kind cluster")
    subnets = [
        ipaddress.ip_network(item["Subnet"])
        for item in network.get("IPAM", {}).get("Config", [])
        if "Subnet" in item
    ]
    if not any(net.version == 4 for net in subnets):
        raise ValueError("Bridge requires an IPv4 subnet")
    members = network.get("Containers") or {}
    expected = {node["Id"], *(container["Id"] for container in containers.values())}
    if set(containers) != set(ENDPOINTS) or set(members) - expected:
        raise ValueError("Unexpected participant in the dedicated Compose bridge")
    addresses = {}
    for service, container in containers.items():
        labels = container.get("Labels") or {}
        if (
            container.get("Running") is not True
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service
            or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
        ):
            raise ValueError("Expected one running Compose container for " + service)
        ports = container.get("Ports") or {}
        if service == "ops-artifacts" and ports:
            raise ValueError("Artifacts must not publish host ports")
        if any(
            binding.get("HostIp") != "127.0.0.1"
            for bindings in ports.values()
            for binding in (bindings or [])
        ):
            raise ValueError("Compose HTTP ports must remain loopback-only")
        attachment = container.get("Networks", {}).get(network["Name"], {})
        member = members.get(container["Id"], {})
        address = attachment.get("IPAddress", "")
        try:
            ip = ipaddress.IPv4Address(address)
            valid = (
                ip.is_private
                and not (
                    ip.is_loopback
                    or ip.is_link_local
                    or ip.is_unspecified
                    or ip.is_multicast
                )
                and any(ip in net for net in subnets if net.version == 4)
            )
            member_ip = ipaddress.ip_interface(member.get("IPv4Address", "")).ip
        except ValueError:
            valid, member_ip = False, None
        if not valid or member_ip != ip or attachment.get("NetworkID") != network["Id"]:
            raise ValueError(
                "Container is not attached to the expected private bridge: " + service
            )
        addresses[service] = address
    if len(set(addresses.values())) != len(ENDPOINTS):
        raise ValueError("Compose endpoint addresses overlap")
    return addresses


def topology(settings, project):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project):
        raise ValueError("Invalid Compose project name")
    network = json.loads(
        run(
            ["docker", "network", "inspect", network_name(settings)],
            capture=True,
            timeout=15,
        )
    )[0]
    node = inspect_container(settings["cluster"] + "-control-plane")
    containers = {}
    for service in ENDPOINTS:
        identities = run(
            [
                "docker",
                "ps",
                "--filter",
                "label=com.docker.compose.project=" + project,
                "--filter",
                "label=com.docker.compose.service=" + service,
                "--format",
                "{{.ID}}",
            ],
            capture=True,
            timeout=15,
        ).split()
        if len(identities) != 1:
            raise ValueError(
                "Expected exactly one running Compose container for " + service
            )
        containers[service] = inspect_container(identities[0])
    addresses = validate_network(settings, project, network, node, containers)
    return {
        "networkId": network["Id"],
        "subnets": [
            item["Subnet"] for item in network["IPAM"]["Config"] if "Subnet" in item
        ],
        "nodeId": node["Id"],
        "addresses": addresses,
        "containers": {name: container["Id"] for name, container in containers.items()},
        "nodeConnected": node["Id"] in (network.get("Containers") or {}),
    }


def verify_cluster_ranges(kube, snapshot):
    nodes = json.loads(
        run(kube + ["get", "nodes", "-o", "json"], capture=True, timeout=15)
    )["items"]
    services = json.loads(
        run(kube + ["get", "servicecidrs", "-o", "json"], capture=True, timeout=15)
    )["items"]
    pod_ranges = [
        cidr for node in nodes for cidr in node.get("spec", {}).get("podCIDRs", [])
    ]
    service_ranges = [
        cidr for item in services for cidr in item.get("spec", {}).get("cidrs", [])
    ]
    if not pod_ranges or not service_ranges:
        raise ValueError("Cannot establish Pod and Service network ranges")
    for subnet in snapshot["subnets"]:
        network = ipaddress.ip_network(subnet)
        for cidr in pod_ranges + service_ranges:
            other = ipaddress.ip_network(cidr)
            if network.version == other.version and network.overlaps(other):
                raise ValueError(
                    "Compose bridge overlaps a Kubernetes Pod or Service network"
                )


def manifests(settings, project, addresses):
    items = []
    for source, (name, port) in ENDPOINTS.items():
        metadata = {
            "name": name,
            "namespace": settings["namespace"],
            "labels": {"app.kubernetes.io/managed-by": MANAGER},
            "annotations": {STATE_KEY: settings["stateId"], PROJECT_KEY: project},
        }
        items.append(
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": metadata,
                "spec": {
                    "type": "ClusterIP",
                    "ports": [
                        {
                            "name": "http",
                            "port": port,
                            "targetPort": port,
                            "protocol": "TCP",
                        }
                    ],
                },
            }
        )
        items.append(
            {
                "apiVersion": "discovery.k8s.io/v1",
                "kind": "EndpointSlice",
                "metadata": {
                    **metadata,
                    "labels": {
                        **metadata["labels"],
                        "kubernetes.io/service-name": name,
                        "endpointslice.kubernetes.io/managed-by": MANAGER,
                    },
                },
                "addressType": "IPv4",
                "ports": [{"name": "http", "port": port, "protocol": "TCP"}],
                "endpoints": [
                    {"addresses": [addresses[source]], "conditions": {"ready": True}}
                ],
            }
        )
    return items


def existing_resources(nk, desired):
    existing = {}
    for item in desired:
        kind, name = item["kind"], item["metadata"]["name"]
        raw = run(
            nk + ["get", kind, name, "--ignore-not-found", "-o", "json"],
            capture=True,
            timeout=15,
        )
        if not raw.strip():
            continue
        actual = json.loads(raw)
        metadata = actual.get("metadata", {})
        if (
            any(
                metadata.get("annotations", {}).get(key) != value
                for key, value in item["metadata"]["annotations"].items()
            )
            or any(
                metadata.get("labels", {}).get(key) != value
                for key, value in item["metadata"]["labels"].items()
            )
            or any(
                key.startswith("argocd.argoproj.io/")
                for field in ("labels", "annotations")
                for key in metadata.get(field, {})
            )
        ):
            raise ValueError(
                "Bridge resource is not owned by this state and Compose project"
            )
        if kind == "Service":
            spec = actual.get("spec", {})
            if (
                spec.get("type") != "ClusterIP"
                or spec.get("ports") != item["spec"]["ports"]
                or any(
                    spec.get(key) for key in ("selector", "externalName", "externalIPs")
                )
                or spec.get("clusterIP") in (None, "", "None")
            ):
                raise ValueError(
                    "Existing bridge Service contract changed; inspect before connecting"
                )
        existing[(kind, name)] = actual
    for name, _ in ENDPOINTS.values():
        slices = json.loads(
            run(
                nk
                + [
                    "get",
                    "endpointslices",
                    "-l",
                    "kubernetes.io/service-name=" + name,
                    "-o",
                    "json",
                ],
                capture=True,
                timeout=15,
            )
        )["items"]
        if any(
            item["metadata"]["name"] != name or ("EndpointSlice", name) not in existing
            for item in slices
        ):
            raise ValueError(
                "Unexpected EndpointSlice could route traffic to another backend"
            )
    return existing


def connect(state, settings, project, *, check=False):
    require_dev(state, settings)
    kube, nk, _ = commands(state, settings)
    before = topology(settings, project)
    verify_cluster_ranges(kube, before)
    desired = manifests(settings, project, before["addresses"])
    existing = existing_resources(nk, desired)
    if check:
        if not before["nodeConnected"] or len(existing) != len(desired):
            raise ValueError("Bridge is not connected; run connect first")
        for item in desired:
            if item["kind"] == "EndpointSlice":
                actual = existing[(item["kind"], item["metadata"]["name"])]
                if any(
                    actual.get(key) != item[key]
                    for key in ("addressType", "ports", "endpoints")
                ):
                    raise ValueError(
                        "Compose container address changed; run connect again"
                    )
        if topology(settings, project) != before:
            raise ValueError(
                "Compose topology changed during check; rerun check before using Ops"
            )
        print(
            "PASS: current bridge ownership and endpoint addresses (not HTTP or evaluation success)"
        )
        return
    if not before["nodeConnected"]:
        run(
            [
                "docker",
                "network",
                "connect",
                "--gw-priority",
                "-1",
                before["networkId"],
                before["nodeId"],
            ],
            capture=True,
            timeout=60,
        )
    after = topology(settings, project)
    if not after["nodeConnected"] or {**before, "nodeConnected": True} != after:
        raise ValueError(
            "Compose topology changed while connecting; no Kubernetes routes were written"
        )
    require_dev(state, settings)
    # Recheck ownership after Docker mutation. create/replace do not adopt names on races.
    existing = existing_resources(nk, desired)
    for item in desired:
        previous = existing.get((item["kind"], item["metadata"]["name"]))
        if previous and item["kind"] == "Service":
            continue
        if previous:
            item["metadata"]["resourceVersion"] = previous["metadata"][
                "resourceVersion"
            ]
        run(
            nk + ["replace" if previous else "create", "-f", "-"],
            data=json.dumps(item),
            capture=True,
            timeout=60,
        )
    if topology(settings, project) != after:
        raise ValueError(
            "Compose topology changed during route update; rerun connect before using Ops"
        )
    write_json(Path(state) / "ops-bridge-values.json", values())
    from ops_runtime import BRIDGE, connection
    write_json(Path(state) / BRIDGE, connection(settings, project))
    print(
        "Connected private Compose routes. Ops values written to ops-bridge-values.json; Run ops_runtime.py with the private artifact env file to activate local-image Ops."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("env", "connect", "check"))
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--compose-project")
    args = parser.parse_args()
    try:
        settings = load_settings(args.state_dir)
        if args.action == "env":
            print(environment(settings), end="")
        else:
            if not args.compose_project:
                raise ValueError("--compose-project is required")
            with locked(args.state_dir):
                connect(
                    args.state_dir,
                    settings,
                    args.compose_project,
                    check=args.action == "check",
                )
    except subprocess.TimeoutExpired:
        parser.exit(
            1,
            "Ops bridge timed out; inspect Docker/Kubernetes connectivity "
            "and current routes before retrying.\n",
        )
    except (
        ValueError,
        KeyError,
        TypeError,
        OSError,
        subprocess.SubprocessError,
    ) as error:
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.exit(1, "Ops bridge stopped: " + message + "\n")


if __name__ == "__main__":
    main()
