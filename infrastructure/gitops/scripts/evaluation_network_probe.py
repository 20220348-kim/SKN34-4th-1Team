"""Exercise NetworkPolicy with disposable HTTP Pods, never evaluation traffic."""

import argparse
import hashlib
import ipaddress
import json
import re
import time
from pathlib import Path
from uuid import uuid4

import evaluation_pvc_restore as pvc
import fork_cluster
import yaml
from check_evaluation import COMPONENTS, LANGFUSE_ORIGIN, render_bundle

LABEL = "ai.govbiz.network-probe"
ROLE = "ai.govbiz.probe-role"
PORT = 8090
SERVER = """
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = sys.argv[1].encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
HTTPServer(('0.0.0.0', int(sys.argv[2])), Handler).serve_forever()
"""
CLIENT = """
import errno, http.client, json, socket, sys
address = sys.argv[1]
if sys.argv[4]:
    try:
        resolved = {r[4][0] for r in socket.getaddrinfo(
            address, int(sys.argv[3]), socket.AF_INET, socket.SOCK_STREAM)}
    except OSError:
        print(json.dumps({'outcome': 'dns_error'}))
        sys.exit(0)
    if resolved != {sys.argv[4]}:
        print(json.dumps({'outcome': 'dns_mismatch'}))
        sys.exit(0)
    address = resolved.pop()
connection = http.client.HTTPConnection(address, int(sys.argv[3]), timeout=2)
try:
    connection.request('GET', '/')
    response = connection.getresponse()
    matched = response.status == 200 and response.read(128) == sys.argv[2].encode()
    outcome = 'reachable' if matched else 'unexpected_response'
except (TimeoutError, socket.timeout):
    outcome = 'timeout'
except OSError as error:
    denied = (errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EACCES)
    outcome = 'rejected' if error.errno in denied else 'error'
finally:
    connection.close()
print(json.dumps({'outcome': outcome}))
"""


def pod(namespace, token, name, role, node, image, *, port=PORT):
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": name, "namespace": namespace, "labels": {LABEL: token, ROLE: role}},
        "spec": {
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 600,
            "terminationGracePeriodSeconds": 1,
            "automountServiceAccountToken": False,
            "nodeSelector": {"kubernetes.io/hostname": node},
            "securityContext": {
                "runAsNonRoot": True,
                "runAsUser": 10001,
                "runAsGroup": 10001,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "probe",
                    "image": image,
                    "imagePullPolicy": "IfNotPresent",
                    "command": ["python", "-B", "-c", SERVER, token, str(port)],
                    "ports": [{"name": "http", "containerPort": port}],
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "32Mi"},
                        "limits": {"cpu": "100m", "memory": "64Mi"},
                    },
                    "securityContext": {
                        "readOnlyRootFilesystem": True,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "readinessProbe": {"tcpSocket": {"port": port}, "periodSeconds": 2},
                }
            ],
        },
    }


def policies(namespace, token):
    port = [{"protocol": "TCP", "port": PORT}]
    return [
        {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": {"name": "ingress", "namespace": namespace, "labels": {LABEL: token}},
            "spec": {
                "podSelector": {"matchLabels": {ROLE: "server"}},
                "policyTypes": ["Ingress"],
                "ingress": [
                    {"from": [{"podSelector": {"matchLabels": {ROLE: "allowed"}}}], "ports": port}
                ],
            },
        },
        {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": {"name": "egress", "namespace": namespace, "labels": {LABEL: token}},
            "spec": {
                "podSelector": {"matchLabels": {ROLE: "allowed"}},
                "policyTypes": ["Egress"],
                "egress": [
                    {"to": [{"podSelector": {"matchLabels": {ROLE: "server"}}}], "ports": port}
                ],
            },
        },
    ]


def chart_fixture(namespace, ops_namespace, observation_namespace, token, node, image, helm):
    """Render the real chart, rebinding only namespaces for disposable traffic."""
    # No rendered workload is deployed. Images/claims/endpoints only satisfy the
    # complete chart schema; the synthetic HTTP Pods never use those contracts.
    values = {
        name: {
            "component": name,
            "image": image,
            "storage": {"existingClaim": "fixture-results", "node": node},
        }
        for name in COMPONENTS
    }
    values["prefect"]["storage"]["existingClaim"] = "fixture-prefect"
    values["ops-artifacts"]["evidenceImage"] = image
    values["evaluation-runner"]["runner"] = {
        "opsApiUrl": "http://ops-service.govbiz-msa.svc.cluster.local:8000",
        # Synthetic HTTP only; real Langfuse authentication/score persistence
        # remains a separate runtime CI stage.
        "langfuseUrl": LANGFUSE_ORIGIN,
    }
    rendered = render_bundle(values, namespace, helm)
    if set(rendered) != set(COMPONENTS):
        raise ValueError("All three evaluation policy releases are required")
    resources, hashes, services = [], {}, []
    for component, rows in rendered.items():
        service_rows = [row for row in rows if row["kind"] == "Service"]
        if component == "evaluation-runner":
            if service_rows:
                raise ValueError("Runner must not expose a chart Service")
        else:
            if len(service_rows) != 1:
                raise ValueError("One chart Service per HTTP component is required")
            service = service_rows[0]
            meta, spec = service["metadata"], service["spec"]
            if (
                service["apiVersion"] != "v1"
                or meta.get("name") != component
                or meta.get("namespace") != namespace
                or any(
                    meta.get(key) for key in ("ownerReferences", "finalizers", "deletionTimestamp")
                )
                or set(spec) != {"type", "selector", "ports"}
                or spec["type"] != "ClusterIP"
                or spec["selector"] != {"app.kubernetes.io/name": component}
                or spec["ports"]
                != [
                    {
                        "name": "http",
                        "port": 4200 if component == "prefect" else 8010,
                        "targetPort": "http",
                    }
                ]
            ):
                raise ValueError("Chart Service exceeds the disposable ClusterIP scope")
            meta["labels"] = {LABEL: token}
            services.append(service)
        candidates = [row for row in rows if row["kind"] == "NetworkPolicy"]
        if len(candidates) != 1 or candidates[0]["metadata"]["name"] != component:
            raise ValueError("One chart NetworkPolicy per component is required")
        policy = candidates[0]
        if (
            policy["apiVersion"] != "networking.k8s.io/v1"
            or policy["metadata"].get("namespace") != namespace
            or any(
                policy["metadata"].get(key)
                for key in ("ownerReferences", "finalizers", "deletionTimestamp")
            )
        ):
            raise ValueError("Chart policy exceeds the disposable namespace scope")
        hashes[component] = hashlib.sha256(
            json.dumps(policy["spec"], sort_keys=True).encode()
        ).hexdigest()
        policy["metadata"]["labels"] = {LABEL: token}
        for direction, key in (("ingress", "from"), ("egress", "to")):
            for rule in policy["spec"].get(direction, []):
                for peer in rule.get(key, []):
                    if "namespaceSelector" not in peer:
                        continue
                    selector = peer["namespaceSelector"]
                    if (
                        direction == "egress"
                        and selector
                        == {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}
                        and peer.get("podSelector") == {"matchLabels": {"k8s-app": "kube-dns"}}
                    ):
                        continue
                    if selector == {"matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}}:
                        replacement = ops_namespace
                    elif direction == "egress" and selector == {
                        "matchLabels": {"kubernetes.io/metadata.name": "govbiz-observability"}
                    }:
                        replacement = observation_namespace
                    else:
                        raise ValueError("Unexpected chart peer namespace selector")
                    selector["matchLabels"]["kubernetes.io/metadata.name"] = replacement
        resources.append(policy)
    pods = []
    for ns, name, component, port in (
        (namespace, "prefect", "prefect", 4200),
        (namespace, "ops-artifacts", "ops-artifacts", 8010),
        (namespace, "evaluation-runner", "evaluation-runner", PORT),
        (namespace, "impostor-ops", "ops-service", 8000),
        (ops_namespace, "ops", "ops-service", 8000),
        (ops_namespace, "foreign-runner", "evaluation-runner", 8000),
        (observation_namespace, "langfuse-web", "langfuse-web", 3000),
        (observation_namespace, "wrong-label-langfuse", "other-app", 3000),
        (observation_namespace, "wrong-port-langfuse", "langfuse-web", 3001),
        (namespace, "impostor-langfuse", "langfuse-web", 3000),
    ):
        resource = pod(ns, token, name, name, node, image, port=port)
        resource["metadata"]["labels"]["app.kubernetes.io/name"] = component
        pods.append(resource)
    # This is a synthetic destination Service, not a Langfuse deployment.
    # The role selector excludes the same-label wrong-port server.
    services.append(
        {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": {
                "name": "langfuse-web",
                "namespace": observation_namespace,
                "labels": {LABEL: token},
            },
            "spec": {
                "type": "ClusterIP",
                "selector": {LABEL: token, ROLE: "langfuse-web"},
                "ports": [{"name": "http", "port": 3000, "targetPort": "http"}],
            },
        }
    )
    # Last field is the expected result while policies are present. All routes
    # must be reachable before policy creation and again after policy removal.
    routes = {
        "ops_to_prefect": (ops_namespace, "ops", "prefect", 4200, True),
        "ops_to_artifacts": (ops_namespace, "ops", "ops-artifacts", 8010, True),
        "runner_to_prefect": (namespace, "evaluation-runner", "prefect", 4200, True),
        "runner_to_artifacts": (
            namespace,
            "evaluation-runner",
            "ops-artifacts",
            8010,
            False,
        ),
        "impostor_ops_to_prefect": (namespace, "impostor-ops", "prefect", 4200, False),
        "impostor_ops_to_artifacts": (
            namespace,
            "impostor-ops",
            "ops-artifacts",
            8010,
            False,
        ),
        "foreign_runner_to_prefect": (
            ops_namespace,
            "foreign-runner",
            "prefect",
            4200,
            False,
        ),
        "ops_to_runner": (ops_namespace, "ops", "evaluation-runner", PORT, False),
        "runner_to_ops": (namespace, "evaluation-runner", "ops", 8000, True),
        "runner_to_impostor_ops": (
            namespace,
            "evaluation-runner",
            "impostor-ops",
            8000,
            False,
        ),
        "runner_to_foreign_runner": (
            namespace,
            "evaluation-runner",
            "foreign-runner",
            8000,
            False,
        ),
        "prefect_to_ops": (namespace, "prefect", "ops", 8000, False),
        "artifacts_to_ops": (namespace, "ops-artifacts", "ops", 8000, False),
        "runner_to_langfuse": (
            namespace,
            "evaluation-runner",
            "langfuse-web",
            3000,
            True,
        ),
        "runner_to_impostor_langfuse": (
            namespace,
            "evaluation-runner",
            "impostor-langfuse",
            3000,
            False,
        ),
        "runner_to_wrong_label_langfuse": (
            namespace,
            "evaluation-runner",
            "wrong-label-langfuse",
            3000,
            False,
        ),
        "runner_to_wrong_port_langfuse": (
            namespace,
            "evaluation-runner",
            "wrong-port-langfuse",
            3001,
            False,
        ),
    }
    servers = [
        (namespace, name, port)
        for name, port in (("prefect", 4200), ("ops-artifacts", 8010), ("evaluation-runner", PORT))
    ]
    servers.extend(
        [
            (namespace, "impostor-ops", 8000),
            (ops_namespace, "ops", 8000),
            (ops_namespace, "foreign-runner", 8000),
            (observation_namespace, "langfuse-web", 3000),
            (observation_namespace, "wrong-label-langfuse", 3000),
            (observation_namespace, "wrong-port-langfuse", 3001),
            (namespace, "impostor-langfuse", 3000),
        ]
    )
    return pods, resources, routes, servers, hashes, services


def identity(resource, name, token, uid=None):
    meta = resource["metadata"]
    if (
        meta.get("name") != name
        or meta.get("labels", {}).get(LABEL) != token
        or not meta.get("uid")
        or (uid and meta["uid"] != uid)
    ):
        raise ValueError("Probe resource ownership changed")
    return meta["uid"]


def remove(kube, kind, name, token, *, namespace=None, uid=None):
    """Recover an ambiguous create, then use an API UID precondition for deletion."""
    nk = kube + (["-n", namespace] if namespace else [])
    resource = pvc.run(nk + ["get", kind, name, "--ignore-not-found", "-o", "json"])
    if not resource:
        return
    uid = identity(resource, name, token, uid)
    path = (
        f"/apis/networking.k8s.io/v1/namespaces/{namespace}/networkpolicies/{name}"
        if namespace
        else f"/api/v1/namespaces/{name}"
    )
    pvc.run(
        kube + ["delete", "--raw", path, "-f", "-"],
        value={
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "preconditions": {"uid": uid},
        },
    )
    # wait output is not JSON. Use the same redacting subprocess boundary directly.
    pvc.snapshot.storage.run(
        [str(p) for p in nk + ["wait", "--for=delete", kind + "/" + name, "--timeout=45s"]],
        timeout=50,
    )


def request(kube, namespace, source, address, token, *, port=PORT, dns_expected_ip=None):
    if dns_expected_ip is None:
        ipaddress.ip_address(address)
    elif ipaddress.ip_address(dns_expected_ip).version != 4 or not re.fullmatch(
        r"(?:(?:prefect|ops-artifacts)\.govbiz-evaluation-net-probe-[a-f0-9]{12}-a"
        r"|langfuse-web\.govbiz-evaluation-net-probe-[a-f0-9]{12}-c)"
        r"\.svc\.cluster\.local\.",
        address,
    ):
        raise ValueError("DNS probe must target this fixture's IPv4 ClusterIP Service")
    result = pvc.run(
        kube
        + [
            "-n",
            namespace,
            "exec",
            source,
            "--",
            "python",
            "-B",
            "-c",
            CLIENT,
            address,
            token,
            str(port),
            dns_expected_ip or "",
        ],
        timeout=15,
    )
    if result not in [{"outcome": outcome} for outcome in ("reachable", "timeout", "rejected")]:
        raise ValueError("Unexpected probe response")
    return result["outcome"]


def exercise(kube, node, *, helm=None):
    """Internal runner; the CLI validates the dedicated fork before calling this."""
    token = uuid4().hex
    chart_mode = helm is not None
    prefix = "govbiz-evaluation-net-probe-" if chart_mode else "govbiz-net-probe-"
    names = [
        prefix + token[:12] + suffix
        for suffix in (("-a", "-b", "-c") if chart_mode else ("-a", "-b"))
    ]
    result = {
        "schema": "evaluation-network-probe-v1",
        "status": "ERROR",
        "scope": "single_node_synthetic_ipv4_tcp",
        "policyProfile": "evaluation_chart" if chart_mode else "cni",
        "addressModes": ["pod_ip", "cluster_ip", "service_dns"] if chart_mode else ["pod_ip"],
        "serviceClusterIPVerified": False,
        "serviceDnsVerified": False,
        "node": node,
        "networkPolicyEnforcementVerified": False,
        "evaluationRuntimeVerified": False,
        "productionCutover": False,
        "cleanupComplete": False,
        "namespaces": names,
        "baseline": {},
        "policyChecks": {},
        "recovery": {},
    }
    attempted = []
    namespace_uids = {}
    try:
        observed_node = pvc.run(kube + ["get", "node", node, "-o", "json"])
        if not any(
            c.get("type") == "Ready" and c.get("status") == "True"
            for c in observed_node.get("status", {}).get("conditions", [])
        ):
            raise ValueError("Probe node is not Ready")
        result["nodeUid"] = observed_node["metadata"]["uid"]
        image = yaml.safe_load(pvc.PREFECT_VALUES.read_text(encoding="utf-8"))["image"]
        if chart_mode:
            pod_specs, policy_specs, routes, servers, hashes, service_specs = chart_fixture(
                *names, token, node, image, helm
            )
            result["chartPolicySpecSha256"] = hashes
            result["namespaceRebinding"] = {
                "govbiz-msa": names[1],
                "govbiz-observability": names[2],
            }
        else:
            service_specs = []
            pod_specs = [
                pod(ns, token, name, role, node, image)
                for ns, name, role in (
                    (names[0], "server", "server"),
                    (names[0], "allowed", "allowed"),
                    (names[0], "denied", "denied"),
                    (names[1], "foreign", "allowed"),
                )
            ]
            policy_specs = policies(names[0], token)
            routes = {
                "allowed_ingress_egress": (names[0], "allowed", "server", PORT, True),
                "denied_same_namespace_ingress": (names[0], "denied", "server", PORT, False),
                "denied_other_namespace_ingress": (names[1], "foreign", "server", PORT, False),
                "denied_other_namespace_egress": (names[0], "allowed", "foreign", PORT, False),
            }
            servers = [(names[0], "server", PORT), (names[1], "foreign", PORT)]
        result["expectedReachability"] = {key: route[-1] for key, route in routes.items()}
        for name in names:
            # Never adopt a pre-existing namespace, including after a name collision.
            if pvc.run(kube + ["get", "namespace", name, "--ignore-not-found", "-o", "json"]):
                raise ValueError("Probe namespace already exists")
            attempted.append(name)
            created = pvc.run(
                kube + ["create", "-f", "-", "-o", "json"],
                value={
                    "apiVersion": "v1",
                    "kind": "Namespace",
                    "metadata": {
                        "name": name,
                        "labels": {
                            LABEL: token,
                            "pod-security.kubernetes.io/enforce": "restricted",
                        },
                    },
                },
            )
            namespace_uids[name] = identity(created, name, token)
        addresses = {}
        for resource in pod_specs:
            namespace, name = resource["metadata"]["namespace"], resource["metadata"]["name"]
            pvc.run(
                kube + ["create", "-f", "-", "-o", "json"],
                value=resource,
            )
            pvc.snapshot.storage.run(
                [
                    str(p)
                    for p in kube
                    + [
                        "-n",
                        namespace,
                        "wait",
                        "--for=condition=Ready",
                        "pod/" + name,
                        "--timeout=60s",
                    ]
                ],
                timeout=65,
            )
            current = pvc.run(kube + ["-n", namespace, "get", "pod", name, "-o", "json"])
            identity(current, name, token)
            address = ipaddress.ip_address(current["status"]["podIP"])
            if address.version != 4 or current["spec"]["nodeName"] != node:
                raise ValueError("This probe requires the selected single IPv4 node")
            addresses[name] = str(address)

        service_ips = {}
        service_namespaces = {}
        for resource in service_specs:
            created = pvc.run(kube + ["create", "-f", "-", "-o", "json"], value=resource)
            name = resource["metadata"]["name"]
            identity(created, name, token)
            address = ipaddress.ip_address(created["spec"]["clusterIP"])
            if address.version != 4:
                raise ValueError("This probe requires IPv4 ClusterIP Services")
            service_ips[name] = str(address)
            service_namespaces[name] = resource["metadata"]["namespace"]
        # Keep the original Pod IP route keys. Only HTTP component destinations
        # have Services; impostors and wrong-port servers remain Pod IP checks.
        destinations = {key: (addresses[route[2]], None) for key, route in routes.items()}
        for key, route in list(routes.items()):
            target = route[2]
            if target in service_ips:
                for suffix, address, expected_ip in (
                    ("cluster_ip", service_ips[target], None),
                    (
                        "service_dns",
                        f"{target}.{service_namespaces[target]}.svc.cluster.local.",
                        service_ips[target],
                    ),
                ):
                    routes[key + "__" + suffix] = route
                    destinations[key + "__" + suffix] = (address, expected_ip)
        result["expectedReachability"] = {key: route[-1] for key, route in routes.items()}

        def sample():
            return {
                key: request(
                    kube,
                    ns,
                    source,
                    destinations[key][0],
                    token,
                    port=port,
                    dns_expected_ip=destinations[key][1],
                )
                for key, (ns, source, _target, port, _) in routes.items()
            }

        result["baseline"] = sample()
        if set(result["baseline"].values()) != {"reachable"}:
            raise ValueError("All baseline routes must be reachable before policies")
        policy_uids = {}
        for policy in policy_specs:
            created = pvc.run(kube + ["create", "-f", "-", "-o", "json"], value=policy)
            name = policy["metadata"]["name"]
            policy_uids[name] = identity(created, name, token)
        # Policy distribution is asynchronous. New HTTP/TCP connections are used on
        # every attempt; 33 chart routes include separate DNS resolution and
        # Service translation. Allow 240s for three complete matching rounds.
        deadline = time.monotonic() + (240 if chart_mode else 45)
        consecutive = 0
        while True:
            observed = sample()
            result["policyChecks"] = observed
            matched = all(
                (value == "reachable") == result["expectedReachability"][key]
                for key, value in observed.items()
            )
            consecutive = consecutive + 1 if matched else 0
            if consecutive == 3 or time.monotonic() >= deadline:
                break
            time.sleep(2)
        result["consecutivePassingRounds"] = consecutive
        # A dead destination must not count as egress protection.
        for namespace, name, port in servers:
            if request(kube, namespace, name, "127.0.0.1", token, port=port) != "reachable":
                raise ValueError("Probe server stopped during policy verification")
        for name, uid in policy_uids.items():
            remove(kube, "networkpolicy", name, token, namespace=names[0], uid=uid)
        deadline = time.monotonic() + 30
        while True:
            result["recovery"] = sample()
            if set(result["recovery"].values()) == {"reachable"}:
                break
            if time.monotonic() >= deadline:
                raise ValueError("Baseline connectivity did not recover")
            time.sleep(2)
        if (
            pvc.run(kube + ["get", "node", node, "-o", "json"])["metadata"]["uid"]
            != result["nodeUid"]
        ):
            raise ValueError("Node changed during probe")
        result["status"] = (
            "ENFORCED"
            if consecutive == 3
            else "NOT_ENFORCED"
            if all(
                observed[key] == "reachable"
                for key, allowed in result["expectedReachability"].items()
                if allowed
            )
            else "INCONCLUSIVE"
        )
    except Exception as error:  # noqa: BLE001 - never include raw kubectl diagnostics
        result["status"] = "ERROR"
        result["errorType"] = type(error).__name__
    finally:
        errors = []
        for name in reversed(attempted):
            try:
                remove(kube, "namespace", name, token, uid=namespace_uids.get(name))
            except Exception as error:  # noqa: BLE001 - attempt every cleanup
                errors.append({"namespace": name, "errorType": type(error).__name__})
        result["cleanupComplete"] = not errors
        if errors:
            result["cleanupErrors"] = errors
            result["status"] = "ERROR"
    result["networkPolicyEnforcementVerified"] = result["status"] == "ENFORCED"
    result["serviceClusterIPVerified"] = chart_mode and result["status"] == "ENFORCED"
    result["serviceDnsVerified"] = chart_mode and result["status"] == "ENFORCED"
    result["runnerClusterEgressVerified"] = chart_mode and result["status"] == "ENFORCED"
    result["langfuseClusterEgressVerified"] = chart_mode and result["status"] == "ENFORCED"
    # No real Langfuse authentication, API or Compose IP egress is exercised.
    result["langfuseEgressVerified"] = False
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=fork_cluster.STATE)
    parser.add_argument(
        "--evaluation-chart",
        action="store_true",
        help="Test evaluation ingress and runner cluster egress with synthetic HTTP Pods",
    )
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    try:
        with fork_cluster.locked(args.state_dir):
            settings = fork_cluster.load_settings(args.state_dir)
            kube, _, _ = fork_cluster.commands(args.state_dir, settings)
            fork_cluster.verify_context(kube, settings, timeout=15)
            result = exercise(
                kube,
                settings["cluster"] + "-control-plane",
                helm=args.helm if args.evaluation_chart else None,
            )
    except Exception as error:  # noqa: BLE001 - sanitized output on failed preflight
        result = {
            "status": "ERROR",
            "errorType": type(error).__name__,
            "networkPolicyEnforcementVerified": False,
        }
    print(json.dumps(result, sort_keys=True))
    return int(result["status"] != "ENFORCED")


if __name__ == "__main__":
    raise SystemExit(main())
