"""Prepare only evaluation Secrets from an authenticated retained backup and its runner.

WSL/Linux only. Default is read-only verification. --create never starts workloads,
changes Ops credentials, rotates an existing Secret, or exports plaintext keys.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
from pathlib import Path

import evaluation_langfuse
import evaluation_pvc_restore as pvc
import fork_cluster
import ops_runtime
import ops_runtime_keys
import ops_state_snapshot as snapshot

NAMESPACE = pvc.MIGRATION_NAMESPACE
LANGFUSE_KEYS = ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")


def live_credentials(kube, settings, source, keys):
    """Read only the bound Ops and original Compose runner; never return raw diagnostics."""
    nk = kube + ["-n", settings["namespace"]]
    secret = pvc.run(nk + ["get", "secret", "ops-runtime", "-o", "json"])
    meta = secret["metadata"]
    if (
        meta.get("name") != "ops-runtime"
        or meta.get("namespace") != settings["namespace"]
        or not meta.get("uid")
        or not meta.get("resourceVersion")
        or meta.get("deletionTimestamp")
        or secret.get("type") != "Opaque"
    ):
        raise ValueError("Unexpected source Secret")
    expected = {
        "LLMOPS_ARTIFACT_TOKEN": keys["keys"]["artifact"],
        "LLMOPS_BUDGET_TOKEN": keys["keys"]["budget"]
        if keys["ops_budget_configured"]
        else "",
    }
    for name, value in expected.items():
        current = base64.b64decode(secret.get("data", {}).get(name, ""), validate=True)
        if not hmac.compare_digest(current, value.encode()):
            raise ValueError("Archived and current Ops tokens differ")
    deployment = pvc.run(nk + ["get", "deployment", "ops-service", "-o", "json"])
    dm = deployment["metadata"]
    if (
        dm.get("name") != "ops-service"
        or dm.get("namespace") != settings["namespace"]
        or dm.get("uid") != source["deployment_uid"]
        or not dm.get("resourceVersion")
        or dm.get("deletionTimestamp")
    ):
        raise ValueError("Source Ops identity changed")
    containers = deployment["spec"]["template"]["spec"]["containers"]
    if len(containers) != 2 or {row["name"] for row in containers} != {
        "ops-service",
        "ops-sync",
    }:
        raise ValueError("Unexpected Ops containers")
    for container in containers:
        rows = container.get("env", [])
        env = {row["name"]: row for row in rows}
        if container.get("envFrom") or len(env) != len(rows):
            raise ValueError("Indirect or duplicate Ops environment")
        for name, value in expected.items():
            wanted = {
                "name": name,
                "valueFrom": {"secretKeyRef": {"name": "ops-runtime", "key": name}},
            }
            if value:
                if env.get(name) != wanted:
                    raise ValueError("Ops does not use the archived token")
            elif env.get(name) not in (None, {"name": name, "value": ""}):
                raise ValueError("Unknown Ops budget configuration")
    runners = [
        (identity, row)
        for identity, row in source["writers"].items()
        if row["service"] == "evaluation-runner"
    ]
    if len(runners) != 1 or not re.fullmatch(r"[a-f0-9]{64}", runners[0][0]):
        raise ValueError("One archived runner identity is required")
    identity, record = runners[0]
    item = snapshot.storage.inspect(identity)
    labels = item["Config"].get("Labels") or {}
    if (
        item["Id"] != identity
        or item["Image"] != record["image"]
        or labels.get("com.docker.compose.project") != source["compose_project"]
        or labels.get("com.docker.compose.service") != "evaluation-runner"
        or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
    ):
        raise ValueError("Archived runner identity changed")
    rows = item["Config"]["Env"]
    env = snapshot.storage.environment(item)
    if len(env) != len(rows) or not hmac.compare_digest(
        env.get("LLMOPS_BUDGET_TOKEN", "").encode(), keys["keys"]["budget"].encode()
    ):
        raise ValueError("Runner budget token differs from the archive")
    for name in LANGFUSE_KEYS:
        value = env.get(name)
        if (
            not isinstance(value, str)
            or not 16 <= len(value) <= 4096
            or any(c.isspace() or c == "\x00" for c in value)
        ):
            raise ValueError("Runner observation credentials are missing or invalid")
    return {
        "credentials": {name: env[name] for name in LANGFUSE_KEYS},
        "sourceIdentity": {
            "opsSecretUid": meta["uid"],
            "opsSecretVersion": meta["resourceVersion"],
            "opsDeploymentUid": dm["uid"],
            "opsDeploymentVersion": dm["resourceVersion"],
            "runnerId": identity,
            "runnerImage": item["Image"],
        },
    }


def require_secret(actual, expected):
    if actual is None:
        raise ValueError("Required evaluation Secret is missing")
    meta, wanted = actual.get("metadata", {}), expected["metadata"]
    if (
        actual.get("apiVersion") != "v1"
        or actual.get("kind") != "Secret"
        or actual.get("type") != "Opaque"
        or actual.get("immutable") is not True
        or any(meta.get(k) != wanted[k] for k in ("name", "namespace"))
        or not meta.get("uid")
        or not meta.get("resourceVersion")
        or meta.get("deletionTimestamp")
        or meta.get("ownerReferences")
        or meta.get("finalizers")
        or any(
            meta.get("annotations", {}).get(k) != v
            for k, v in wanted["annotations"].items()
        )
        or not hmac.compare_digest(
            json.dumps(actual.get("data"), sort_keys=True),
            json.dumps(expected["data"], sort_keys=True),
        )
        or actual.get("stringData")
    ):
        raise ValueError("Existing evaluation Secret differs; no overwrite is allowed")
    return {
        "name": wanted["name"],
        "uid": meta["uid"],
        "resourceVersion": meta["resourceVersion"],
    }


def bound_archive(settings, connection, archive, key_file, report):
    """Authenticate the same archive for initial preparation and dormant rechecks."""
    raw = snapshot.database.read_archive(archive)
    archive_hash = hashlib.sha256(raw).hexdigest()
    if (
        report.get("archive_sha256") != archive_hash
        or report.get("cross_store_business_links_verified") is not True
    ):
        raise ValueError("Restore report belongs to another archive")
    payload = snapshot.validate(
        snapshot.storage.open_payload(raw, snapshot.storage.key_bytes(key_file))
    )
    keys = ops_runtime_keys.validate(payload["runtime_keys"])
    source = payload["database"]["source"]
    if any(
        source.get(key) != value
        for key, value in {
            "repository": settings["repository"],
            "state_id": settings["stateId"],
            "namespace": settings["namespace"],
            "compose_project": connection["composeProject"],
        }.items()
    ):
        raise ValueError("Archive belongs to another source environment")
    return payload, archive_hash, keys, source


def secret_resources(settings, retained, archive_hash, keys, current):
    """The same four credentials and immutable ownership apply before and after sync."""
    annotations = {
        "ai.govbiz/evaluation-namespace-uid": retained["namespace_uid"],
        "ai.govbiz/evaluation-archive-sha256": archive_hash,
        "ai.govbiz/evaluation-state-id": settings["stateId"],
    }
    return [
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "type": "Opaque",
            "immutable": True,
            "metadata": {
                "name": name,
                "namespace": NAMESPACE,
                "annotations": annotations,
            },
            "data": {
                key: base64.b64encode(value.encode()).decode()
                for key, value in values.items()
            },
        }
        for name, values in (
            ("llmops-artifacts", {"LLMOPS_ARTIFACT_TOKEN": keys["keys"]["artifact"]}),
            (
                "llmops-runner",
                {
                    "LLMOPS_BUDGET_TOKEN": keys["keys"]["budget"],
                    **current["credentials"],
                },
            ),
        )
    ]


def verify_handoff(state, archive, key_file, report, retained):
    """Recheck frozen source and existing credentials; caller checks dormant workloads."""
    settings = fork_cluster.load_settings(state)
    if settings["mode"] != "gitops":
        raise ValueError("Use the existing personal GitOps environment")
    connection = ops_runtime.read_connection(Path(state) / ops_runtime.BRIDGE, settings)
    payload, archive_hash, keys, source = bound_archive(
        settings, connection, archive, key_file, report
    )
    snapshot.verify_current_source(state, payload)
    kube, _, _ = fork_cluster.commands(state, settings)
    kube = kube + ["--request-timeout=15s"]
    node = settings["cluster"] + "-control-plane"
    fork_cluster.verify_context(kube, settings, timeout=15)
    if pvc.inspect_retained_storage(kube, node, report) != retained:
        raise ValueError("Retained storage changed before credential verification")
    current = live_credentials(kube, settings, source, keys)
    resources = secret_resources(settings, retained, archive_hash, keys, current)

    def identities():
        return [
            require_secret(
                pvc.run(
                    kube
                    + [
                        "-n",
                        NAMESPACE,
                        "get",
                        "secret",
                        row["metadata"]["name"],
                        "-o",
                        "json",
                    ]
                ),
                row,
            )
            for row in resources
        ]

    found = identities()  # Both Secrets must exist; this path never creates them.
    authentication = evaluation_langfuse.verify(
        source["compose_project"], current["credentials"]
    )
    if (
        fork_cluster.load_settings(state) != settings
        or ops_runtime.read_connection(Path(state) / ops_runtime.BRIDGE, settings)
        != connection
        or pvc.inspect_retained_storage(kube, node, report) != retained
        or live_credentials(kube, settings, source, keys) != current
        or identities() != found
    ):
        raise ValueError("Evaluation handoff source or credentials changed")
    return {
        "archiveSha256": archive_hash,
        "namespaceUid": retained["namespace_uid"],
        "sourceIdentity": current["sourceIdentity"],
        "secretIdentities": found,
        "langfuseAuthentication": authentication,
    }


def prepare(state, archive, key_file, restore_report, *, create=False, progress):
    settings = fork_cluster.load_settings(state)
    if settings["mode"] != "gitops":
        raise ValueError("Use the existing personal GitOps environment")
    connection = ops_runtime.read_connection(Path(state) / ops_runtime.BRIDGE, settings)
    with Path(restore_report).open("rb") as stream:
        raw_report = stream.read(65537)
    if len(raw_report) > 65536:
        raise ValueError("Retained report is too large")
    report = json.loads(raw_report)
    _, archive_hash, keys, source = bound_archive(
        settings, connection, archive, key_file, report
    )
    kube, _, _ = fork_cluster.commands(state, settings)
    node = settings["cluster"] + "-control-plane"
    fork_cluster.verify_context(kube, settings, timeout=15)
    retained = pvc.inspect_retained(kube, node, report)
    current = live_credentials(kube, settings, source, keys)
    resources = secret_resources(settings, retained, archive_hash, keys, current)
    ek = kube + ["-n", NAMESPACE]

    def recheck():
        if (
            fork_cluster.load_settings(state) != settings
            or ops_runtime.read_connection(Path(state) / ops_runtime.BRIDGE, settings)
            != connection
        ):
            raise ValueError("Local source binding changed")
        fork_cluster.verify_context(kube, settings, timeout=15)
        if (
            pvc.inspect_retained(kube, node, report) != retained
            or live_credentials(kube, settings, source, keys) != current
        ):
            raise ValueError("Storage or source credentials changed")

    def existing_secrets():
        found = {}
        for resource in resources:
            name = resource["metadata"]["name"]
            item = pvc.run(
                ek + ["get", "secret", name, "--ignore-not-found", "-o", "json"]
            )
            if item:
                found[name] = require_secret(item, resource)
        return found

    found = existing_secrets()  # Check both names before any write.
    authentication = evaluation_langfuse.verify(
        source["compose_project"], current["credentials"]
    )
    if create:
        for resource in resources:
            recheck()
            observed = existing_secrets()
            if any(observed.get(name) != identity for name, identity in found.items()):
                raise ValueError("Evaluation Secret identity changed")
            found = observed
            name = resource["metadata"]["name"]
            if name not in found:
                progress["creationAttempts"].append(name)
                item = pvc.run(ek + ["create", "-f", "-", "-o", "json"], value=resource)
                progress["created"].append(name)
                found[name] = require_secret(item, resource)
    recheck()
    if existing_secrets() != found:
        raise ValueError("Evaluation Secrets changed before confirmation")
    return {
        "schema": "evaluation-secret-preparation-v1",
        "status": "PREPARED_NOT_ACTIVATED" if create else "VERIFIED_NOT_CREATED",
        "archiveSha256": archive_hash,
        "namespaceUid": retained["namespace_uid"],
        "secretIdentities": list(found.values()),
        "missingSecrets": [
            r["metadata"]["name"]
            for r in resources
            if r["metadata"]["name"] not in found
        ],
        "clusterChanged": bool(progress["created"]),
        "creation": progress,
        "archiveAuthenticated": True,
        "sourceTokensMatched": True,
        "langfuseAuthenticationVerified": True,
        "langfuseAuthentication": authentication,
        "archiveFreshnessVerified": False,
        "sourceQuiescenceVerified": False,
        "runtimeStarted": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=fork_cluster.STATE)
    for name in ("archive", "key-file", "restore-report"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument(
        "--create",
        action="store_true",
        help="Create only the two missing immutable evaluation Secrets",
    )
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run inside WSL/Linux")
    progress = {"creationAttempts": [], "created": []}
    try:
        with fork_cluster.locked(args.state_dir):
            result = prepare(
                args.state_dir,
                args.archive,
                args.key_file,
                args.restore_report,
                create=args.create,
                progress=progress,
            )
    except Exception as error:  # noqa: BLE001 - private archive, kubectl and Docker errors must never escape
        result = {
            "schema": "evaluation-secret-preparation-v1",
            "status": "BLOCKED",
            "errorType": type(error).__name__,
            "creation": progress,
            "clusterChanged": True
            if progress["created"]
            else (None if progress["creationAttempts"] else False),
            "runtimeStarted": False,
        }
    print(json.dumps(result, sort_keys=True))
    return int(result["status"] == "BLOCKED")


if __name__ == "__main__":
    raise SystemExit(main())
