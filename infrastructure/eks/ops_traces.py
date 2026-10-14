"""Prepare private, offline patches for the existing Ops trace connection."""

import argparse
import base64
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

LANGFUSE_ORIGIN = "http://langfuse-web.govbiz-observability.svc.cluster.local:3000"
TRACE_KEYS = ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")
TRACE_ENV = [
    {"name": "LANGFUSE_BASE_URL", "value": LANGFUSE_ORIGIN},
    *[
        {
            "name": key,
            "valueFrom": {"secretKeyRef": {"name": "ops-langfuse", "key": key}},
        }
        for key in TRACE_KEYS
    ],
]
TARGETS = {
    ("Deployment", "ops-service"): (0, 1),
    ("Job", "ops-service-release-prepare"): (0,),
    ("Job", "ops-service-release-resume"): (0,),
}
OPS_PEER = {
    "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}},
    "podSelector": {"matchLabels": {"app.kubernetes.io/name": "ops-service"}},
}


def require(condition):
    if not condition:
        raise ValueError("Invalid or unexpected Ops trace repair input")


def resource(value, api_version, kind, namespace, name):
    require(isinstance(value, dict))
    require(value.get("apiVersion") == api_version and value.get("kind") == kind)
    metadata = value.get("metadata")
    require(isinstance(metadata, dict))
    require(metadata.get("namespace") == namespace and metadata.get("name") == name)
    return metadata


def version_test(metadata):
    version = metadata.get("resourceVersion")
    require(isinstance(version, str) and bool(version.strip()))
    return {"op": "test", "path": "/metadata/resourceVersion", "value": version}


def application_patch(application):
    """Repair only the four retained Ops env arrays; guard concurrent Argo changes."""
    metadata = resource(
        application, "argoproj.io/v1alpha1", "Application", "argocd", "govbiz-eks"
    )
    guard = version_test(metadata)
    require(not application.get("operation"))
    status = application.get("status", {})
    require(isinstance(status, dict))
    operation = status.get("operationState", {})
    require(isinstance(operation, dict))
    require(operation.get("phase") in (None, "Succeeded", "Failed", "Error"))
    spec = application.get("spec")
    require(isinstance(spec, dict) and "sources" not in spec)
    source = spec.get("source")
    require(isinstance(source, dict) and isinstance(source.get("kustomize"), dict))
    original = source["kustomize"].get("patches")
    require(isinstance(original, list))
    patches = copy.deepcopy(original)
    found = set()
    trace_names = {entry["name"] for entry in TRACE_ENV}
    for patch in patches:
        require(isinstance(patch, dict) and isinstance(patch.get("target"), dict))
        target = patch["target"]
        # Selector/wildcard patches can also replace Ops env arrays; do not guess their scope.
        require(set(target) == {"kind", "name", "namespace"})
        require(all(isinstance(value, str) and value for value in target.values()))
        require(all(char.isalnum() or char == "-" for char in target["name"]))
        key = (target["kind"], target["name"])
        if target["name"] not in {name for _, name in TARGETS}:
            continue
        require(
            key in TARGETS and target["namespace"] == "govbiz-msa" and key not in found
        )
        found.add(key)
        require(isinstance(patch.get("patch"), str))
        operations = json.loads(patch["patch"])
        require(
            isinstance(operations, list)
            and all(isinstance(op, dict) for op in operations)
        )
        expected_paths = {
            f"/spec/template/spec/containers/{index}/env" for index in TARGETS[key]
        }
        seen = set()
        for op in operations:
            path = op.get("path")
            require(isinstance(path, str))
            if path not in expected_paths:
                require(
                    "/env" not in path
                    and not any(
                        env_path.startswith(path + "/") for env_path in expected_paths
                    )
                )
                require("from" not in op)
                continue
            require(path not in seen and op.get("op") in ("add", "replace"))
            seen.add(path)
            env = op.get("value")
            require(
                isinstance(env, list) and all(isinstance(item, dict) for item in env)
            )
            names = [item.get("name") for item in env]
            require(all(isinstance(name, str) and bool(name) for name in names))
            require(len(set(names)) == len(names))
            # Preserve existing order and values for every unrelated variable.
            if [item for item in env if item["name"] in trace_names] != TRACE_ENV:
                repaired = [
                    copy.deepcopy(item)
                    for item in env
                    if item["name"] not in trace_names
                ]
                repaired.extend(copy.deepcopy(TRACE_ENV))
                op["value"] = repaired
        require(seen == expected_paths)
        if operations != json.loads(patch["patch"]):
            patch["patch"] = json.dumps(operations, ensure_ascii=False)
    require(found == set(TARGETS))
    return [guard] + (
        [
            {
                "op": "replace",
                "path": "/spec/source/kustomize/patches",
                "value": patches,
            }
        ]
        if patches != original
        else []
    )


def network_policy_patch(policy):
    """Append only Ops-to-Langfuse TCP ingress, preserving existing rules."""
    metadata = resource(
        policy,
        "networking.k8s.io/v1",
        "NetworkPolicy",
        "govbiz-observability",
        "langfuse-web-ingress",
    )
    guard = version_test(metadata)
    spec = policy.get("spec")
    require(isinstance(spec, dict))
    require(
        spec.get("podSelector")
        == {"matchLabels": {"app.kubernetes.io/name": "langfuse-web"}}
    )
    require(spec.get("policyTypes") == ["Ingress"])
    ingress = spec.get("ingress")
    require(
        isinstance(ingress, list) and all(isinstance(rule, dict) for rule in ingress)
    )
    for rule in ingress:
        ports, peers = rule.get("ports", []), rule.get("from", [])
        require(isinstance(ports, list) and isinstance(peers, list))
        require(all(isinstance(port, dict) for port in ports))
        require(all(isinstance(peer, dict) for peer in peers))
        if not any(
            port.get("port") == 3000 and port.get("protocol", "TCP") == "TCP"
            for port in ports
        ):
            continue
        for peer in peers:
            if peer == OPS_PEER:
                return [guard]
            # The current chart may already grant the same access with a combined In selector.
            selector = peer.get("podSelector", {})
            expressions = (
                selector.get("matchExpressions", [])
                if isinstance(selector, dict)
                else []
            )
            if (
                set(peer) == {"namespaceSelector", "podSelector"}
                and peer["namespaceSelector"] == OPS_PEER["namespaceSelector"]
                and isinstance(selector, dict)
                and set(selector) == {"matchExpressions"}
                and isinstance(expressions, list)
                and len(expressions) == 1
                and isinstance(expressions[0], dict)
                and set(expressions[0]) == {"key", "operator", "values"}
                and expressions[0]["key"] == "app.kubernetes.io/name"
                and expressions[0]["operator"] == "In"
                and isinstance(expressions[0]["values"], list)
                and "ops-service" in expressions[0]["values"]
            ):
                return [guard]
    rule = {
        "from": [copy.deepcopy(OPS_PEER)],
        "ports": [{"port": 3000, "protocol": "TCP"}],
    }
    return [guard, {"op": "add", "path": "/spec/ingress/-", "value": rule}]


def trace_secret(source):
    """Copy only the two existing project keys into a new dedicated Secret."""
    resource(source, "v1", "Secret", "govbiz-msa", "core-runtime")
    require(source.get("type", "Opaque") == "Opaque" and "stringData" not in source)
    data = source.get("data")
    require(isinstance(data, dict))
    selected = {}
    for key in TRACE_KEYS:
        encoded = data.get(key)
        require(isinstance(encoded, str))
        decoded = base64.b64decode(encoded, validate=True).decode("ascii")
        require(0 < len(decoded) <= 4096)
        require(
            not any(
                char.isspace() or ord(char) < 32 or ord(char) == 127 or char == ":"
                for char in decoded
            )
        )
        selected[key] = encoded
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": {"namespace": "govbiz-msa", "name": "ops-langfuse"},
        "data": selected,
    }


def prepare(application, policy, source, output):
    files = {
        "application.patch.json": application_patch(application),
        "network-policy.patch.json": network_policy_patch(policy),
        "ops-langfuse-secret.json": trace_secret(source),
    }
    output = Path(output)
    output.mkdir(mode=0o700)
    output.chmod(0o700)
    for name, data in files.items():
        fd, temporary = tempfile.mkstemp(prefix=".preparing-", dir=output)
        try:
            with os.fdopen(fd, "w") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            # A complete file becomes visible atomically; an existing target is never replaced.
            os.link(temporary, output / name)
        finally:
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application", required=True, type=Path)
    parser.add_argument("--network-policy", required=True, type=Path)
    parser.add_argument("--source-secret", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        prepare(
            json.loads(args.application.read_text()),
            json.loads(args.network_policy.read_text()),
            json.loads(args.source_secret.read_text()),
            args.output,
        )
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        print(
            "Offline Ops trace repair preparation failed; check inputs and use a new output directory.",
            file=sys.stderr,
        )
        return 1
    print("Prepared three private files. No cluster connection or changes were made.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
