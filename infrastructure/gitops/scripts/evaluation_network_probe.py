"""Exercise NetworkPolicy with disposable HTTP Pods, never evaluation traffic."""

import argparse
import hashlib
import ipaddress
import json
import time
from pathlib import Path
from uuid import uuid4

import evaluation_pvc_restore as pvc
import fork_cluster
import yaml
from check_evaluation import COMPONENTS, render_bundle

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
connection = http.client.HTTPConnection(sys.argv[1], int(sys.argv[3]), timeout=2)
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


def chart_fixture(namespace, ops_namespace, token, node, image, helm):
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
        "langfuseUrl": "http://langfuse.govbiz-observability.svc.cluster.local:3000",
    }
    rendered = render_bundle(values, namespace, helm)
    if set(rendered) != set(COMPONENTS):
        raise ValueError("All three evaluation policy releases are required")
    resources, hashes = [], {}
    for component, rows in rendered.items():
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
        for rule in policy["spec"].get("ingress", []):
            for peer in rule.get("from", []):
                if "namespaceSelector" in peer:
                    if peer["namespaceSelector"] != {
                        "matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}
                    }:
                        raise ValueError("Unexpected chart source namespace selector")
                    peer["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"] = (
                        ops_namespace
                    )
        resources.append(policy)
    pods = []
    for ns, name, component, port in (
        (namespace, "prefect", "prefect", 4200),
        (namespace, "ops-artifacts", "ops-artifacts", 8010),
        (namespace, "evaluation-runner", "evaluation-runner", PORT),
        (namespace, "impostor-ops", "ops-service", PORT),
        (ops_namespace, "ops", "ops-service", PORT),
        (ops_namespace, "foreign-runner", "evaluation-runner", PORT),
    ):
        resource = pod(ns, token, name, component, node, image, port=port)
        resource["metadata"]["labels"]["app.kubernetes.io/name"] = component
        pods.append(resource)
    # Last field is the expected result while policies are present. All routes
    # must be reachable before policy creation and again after policy removal.
    routes = {
        "ops_to_prefect": (ops_namespace, "ops", "prefect", 4200, True),
        "ops_to_artifacts": (ops_namespace, "ops", "ops-artifacts", 8010, True),
        "runner_to_prefect": (namespace, "evaluation-runner", "prefect", 4200, True),
        "runner_to_artifacts": (namespace, "evaluation-runner", "ops-artifacts", 8010, False),
        "impostor_ops_to_prefect": (namespace, "impostor-ops", "prefect", 4200, False),
        "impostor_ops_to_artifacts": (namespace, "impostor-ops", "ops-artifacts", 8010, False),
        "foreign_runner_to_prefect": (ops_namespace, "foreign-runner", "prefect", 4200, False),
        "ops_to_runner": (ops_namespace, "ops", "evaluation-runner", PORT, False),
    }
    servers = [
        (namespace, name, port)
        for name, port in (("prefect", 4200), ("ops-artifacts", 8010), ("evaluation-runner", PORT))
    ]
    return pods, resources, routes, servers, hashes


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


def request(kube, namespace, source, address, token, *, port=PORT):
    ipaddress.ip_address(address)
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
    names = [prefix + token[:12] + suffix for suffix in ("-a", "-b")]
    result = {
        "schema": "evaluation-network-probe-v1",
        "status": "ERROR",
        "scope": "single_node_synthetic_ipv4_tcp",
        "policyProfile": "evaluation_chart" if chart_mode else "cni",
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
            pod_specs, policy_specs, routes, servers, hashes = chart_fixture(
                *names, token, node, image, helm
            )
            result["chartPolicySpecSha256"] = hashes
            result["namespaceRebinding"] = {"govbiz-msa": names[1]}
        else:
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

        def sample():
            return {
                key: request(kube, ns, source, addresses[target], token, port=port)
                for key, (ns, source, target, port, _) in routes.items()
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
        # every attempt; the larger chart matrix has a 120s convergence window.
        deadline = time.monotonic() + (120 if chart_mode else 45)
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
            except Exception as error:  # noqa: BLE001 - attempt both cleanups
                errors.append({"namespace": name, "errorType": type(error).__name__})
        result["cleanupComplete"] = not errors
        if errors:
            result["cleanupErrors"] = errors
            result["status"] = "ERROR"
    result["networkPolicyEnforcementVerified"] = result["status"] == "ENFORCED"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=fork_cluster.STATE)
    parser.add_argument(
        "--evaluation-chart",
        action="store_true",
        help="Test the rendered evaluation ingress policies with synthetic HTTP Pods",
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
