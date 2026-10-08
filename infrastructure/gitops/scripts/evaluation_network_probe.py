"""Exercise NetworkPolicy with disposable HTTP Pods, never evaluation traffic."""

import argparse
import ipaddress
import json
import time
from pathlib import Path
from uuid import uuid4

import evaluation_pvc_restore as pvc
import fork_cluster
import yaml

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
HTTPServer(('0.0.0.0', 8090), Handler).serve_forever()
"""
CLIENT = """
import errno, http.client, json, socket, sys
connection = http.client.HTTPConnection(sys.argv[1], 8090, timeout=2)
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


def pod(namespace, token, name, role, node, image):
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
                    "command": ["python", "-B", "-c", SERVER, token],
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "32Mi"},
                        "limits": {"cpu": "100m", "memory": "64Mi"},
                    },
                    "securityContext": {
                        "readOnlyRootFilesystem": True,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "readinessProbe": {"tcpSocket": {"port": PORT}, "periodSeconds": 2},
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


def request(kube, namespace, source, address, token):
    ipaddress.ip_address(address)
    result = pvc.run(
        kube
        + ["-n", namespace, "exec", source, "--", "python", "-B", "-c", CLIENT, address, token],
        timeout=15,
    )
    if result not in [{"outcome": outcome} for outcome in ("reachable", "timeout", "rejected")]:
        raise ValueError("Unexpected probe response")
    return result["outcome"]


def exercise(kube, node):
    """Internal runner; the CLI validates the dedicated fork before calling this."""
    token = uuid4().hex
    names = ["govbiz-net-probe-" + token[:12] + suffix for suffix in ("-a", "-b")]
    result = {
        "schema": "evaluation-network-probe-v1",
        "status": "ERROR",
        "scope": "single_node_synthetic_ipv4_tcp",
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
        for namespace, name, role in [
            (names[0], "server", "server"),
            (names[0], "allowed", "allowed"),
            (names[0], "denied", "denied"),
            (names[1], "foreign", "allowed"),
        ]:
            pvc.run(
                kube + ["create", "-f", "-", "-o", "json"],
                value=pod(namespace, token, name, role, node, image),
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
        routes = {
            "allowed_ingress_egress": (names[0], "allowed", addresses["server"]),
            "denied_same_namespace_ingress": (names[0], "denied", addresses["server"]),
            "denied_other_namespace_ingress": (names[1], "foreign", addresses["server"]),
            "denied_other_namespace_egress": (names[0], "allowed", addresses["foreign"]),
        }

        def sample():
            return {key: request(kube, *route, token) for key, route in routes.items()}

        result["baseline"] = sample()
        if set(result["baseline"].values()) != {"reachable"}:
            raise ValueError("All baseline routes must be reachable before policies")
        policy_uids = {}
        for policy in policies(names[0], token):
            created = pvc.run(kube + ["create", "-f", "-", "-o", "json"], value=policy)
            name = policy["metadata"]["name"]
            policy_uids[name] = identity(created, name, token)
        # Policy distribution is asynchronous. New HTTP/TCP connections are used on
        # every attempt; three consecutive matching rounds are needed within 45s.
        deadline = time.monotonic() + 45
        consecutive = 0
        while True:
            observed = sample()
            result["policyChecks"] = observed
            matched = all(
                (value == "reachable") == (key == "allowed_ingress_egress")
                for key, value in observed.items()
            )
            consecutive = consecutive + 1 if matched else 0
            if consecutive == 3 or time.monotonic() >= deadline:
                break
            time.sleep(2)
        result["consecutivePassingRounds"] = consecutive
        # A dead destination must not count as egress protection.
        for namespace, name in ((names[0], "server"), (names[1], "foreign")):
            if request(kube, namespace, name, "127.0.0.1", token) != "reachable":
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
            if observed["allowed_ingress_egress"] == "reachable"
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
    args = parser.parse_args()
    try:
        with fork_cluster.locked(args.state_dir):
            settings = fork_cluster.load_settings(args.state_dir)
            kube, _, _ = fork_cluster.commands(args.state_dir, settings)
            fork_cluster.verify_context(kube, settings, timeout=15)
            result = exercise(kube, settings["cluster"] + "-control-plane")
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
