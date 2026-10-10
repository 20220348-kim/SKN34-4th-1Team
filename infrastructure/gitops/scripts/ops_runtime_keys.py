"""Capture only Ops runtime recovery keys into the encrypted storage bundle."""

import base64
import hashlib
import hmac
import json
import re
from pathlib import Path
from uuid import UUID, uuid4

import ops_db_snapshot as database

storage = database.storage
PROBE = Path(__file__).with_name("ops_key_restore_probe.py").read_text(encoding="utf-8")
KEYS = {"django", "database", "mysql_root", "artifact", "budget"}


def validate(value):
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != 1
        or type(value.get("schema_version")) is not int
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", value.get("image", ""))
        or set(value.get("keys", {})) != KEYS
        or type(value.get("ops_budget_configured")) is not bool
    ):
        raise ValueError("Unsupported Ops runtime key bundle")
    for name, key in value["keys"].items():
        if name == "budget" and key == "" and not value["ops_budget_configured"]:
            continue
        if not isinstance(key, str) or not 16 <= len(key) <= 4096 or "\x00" in key:
            raise ValueError("Invalid runtime key")
        if name in {"artifact", "budget"} and not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", key):
            raise ValueError("Invalid service token")
    if "database_accounts" in value:
        database.validate_accounts(value["database_accounts"])
    return value


def capture(namespaced, source, volumes):
    """Caller must hold/recheck the frozen DB and volume source before publication."""
    secrets = {}
    versions = {}
    for name in ("ops-runtime", "ops-mysql-runtime"):
        item = database.read_json(namespaced + ["get", "secret", name, "-o", "json"])
        meta = item["metadata"]
        if (
            meta["name"] != name
            or meta["namespace"] != source["namespace"]
            or not meta.get("uid")
            or not meta.get("resourceVersion")
            or item.get("type") != "Opaque"
            or meta.get("deletionTimestamp")
        ):
            raise ValueError("Unexpected runtime Secret identity")
        secrets[name] = {
            key: base64.b64decode(value, validate=True).decode("utf-8")
            for key, value in item["data"].items()
        }
        versions[name] = {"uid": meta["uid"], "version": meta["resourceVersion"]}
    ops, mysql = secrets["ops-runtime"], secrets["ops-mysql-runtime"]
    if set(ops) - {
        "DJANGO_SECRET_KEY",
        "DB_PASSWORD",
        "LLMOPS_ARTIFACT_TOKEN",
        "LLMOPS_BUDGET_TOKEN",
    } or set(mysql) != {"MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"}:
        raise ValueError("Unknown runtime keys require an explicit recovery scope")
    deployment = database.read_json(namespaced + ["get", "deployment", "ops-service", "-o", "json"])
    if (
        deployment["metadata"]["uid"] != source["deployment_uid"]
        or deployment["metadata"]["resourceVersion"] != source["deployment_version"]
    ):
        raise ValueError("Ops deployment changed")
    containers = deployment["spec"]["template"]["spec"]["containers"]
    if {row["name"] for row in containers} != {"ops-service", "ops-sync"} or len(containers) != 2:
        raise ValueError("Unexpected Ops containers")
    images = set()
    for container in containers:
        env = container.get("env", [])
        mapping = {row["name"]: row for row in env}
        if container.get("envFrom") or len(mapping) != len(env):
            raise ValueError("Indirect or repeated runtime environment")
        if mapping.get("DB_USER") != {"name": "DB_USER", "value": "govbiz_ops"}:
            raise ValueError("Only the dedicated govbiz_ops database account is supported")
        required = {"DJANGO_SECRET_KEY", "DB_PASSWORD", "LLMOPS_ARTIFACT_TOKEN"}
        if ops.get("LLMOPS_BUDGET_TOKEN"):
            required.add("LLMOPS_BUDGET_TOKEN")
        for name in required:
            if mapping.get(name) != {
                "name": name,
                "valueFrom": {"secretKeyRef": {"name": "ops-runtime", "key": name}},
            }:
                raise ValueError("Ops does not reference the captured key")
        if "LLMOPS_BUDGET_TOKEN" not in required and mapping.get("LLMOPS_BUDGET_TOKEN") not in (
            None,
            {"name": "LLMOPS_BUDGET_TOKEN", "value": ""},
        ):
            raise ValueError("Unknown Ops budget token")
        images.add(database.read_json(["docker", "image", "inspect", container["image"]])[0]["Id"])
    if len(images) != 1 or not hmac.compare_digest(ops["DB_PASSWORD"], mysql["MYSQL_PASSWORD"]):
        raise ValueError("Ops image or database credential differs")
    pod = database.read_json(namespaced + ["get", "pod", "ops-mysql-0", "-o", "json"])
    if pod["metadata"]["uid"] != source["pod_uid"]:
        raise ValueError("MySQL source changed")
    mysql_containers = pod["spec"]["containers"]
    if (
        len(mysql_containers) != 1
        or mysql_containers[0]["name"] != "mysql"
        or mysql_containers[0].get("envFrom")
    ):
        raise ValueError("Unexpected MySQL runtime environment")
    mysql_env = mysql_containers[0]["env"]
    if len({row["name"] for row in mysql_env}) != len(mysql_env):
        raise ValueError("Repeated MySQL environment")
    if {"name": "MYSQL_USER", "value": "govbiz_ops"} not in mysql_env:
        raise ValueError("Unexpected source MySQL application user")
    for key in ("MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"):
        if {
            "name": key,
            "valueFrom": {"secretKeyRef": {"name": "ops-mysql-runtime", "key": key}},
        } not in mysql_env:
            raise ValueError("MySQL does not reference the captured key")
    if "evaluation" in source:
        values, evaluation_versions = evaluation_tokens(namespaced, source, images)
        versions.update(evaluation_versions)
    else:
        values = compose_tokens(source, volumes, images)
    if not hmac.compare_digest(ops["LLMOPS_ARTIFACT_TOKEN"], values["artifact"]) or (
        ops.get("LLMOPS_BUDGET_TOKEN")
        and not hmac.compare_digest(ops["LLMOPS_BUDGET_TOKEN"], values["budget"])
    ):
        raise ValueError("Ops and evaluation runtime tokens differ")
    return validate(
        {
            "schema_version": 1,
            "image": images.pop(),
            "sources": versions,
            "database_accounts": database.read_accounts(
                [
                    *namespaced,
                    "exec",
                    "-i",
                    "ops-mysql-0",
                    "-c",
                    "mysql",
                    "--",
                    *storage.AUTH,
                ]
            ),
            "ops_budget_configured": bool(ops.get("LLMOPS_BUDGET_TOKEN")),
            "keys": {
                "django": ops["DJANGO_SECRET_KEY"],
                "database": ops["DB_PASSWORD"],
                "mysql_root": mysql["MYSQL_ROOT_PASSWORD"],
                **values,
            },
        }
    )


def compose_tokens(source, volumes, images):
    artifacts = [
        (identity, row)
        for identity, row in volumes["results"]["consumers"].items()
        if row["service"] == "ops-artifacts"
    ]
    runners = [
        (identity, row)
        for identity, row in source["writers"].items()
        if row["service"] == "evaluation-runner"
    ]
    if len(artifacts) != 1 or len(runners) != 1:
        raise ValueError("One artifact server and runner are required")
    if artifacts[0][1]["image"] not in images:
        raise ValueError("Ops and artifact server images differ")
    values = {}
    for name, (identity, record), token_name in (
        ("artifact", artifacts[0], "LLMOPS_ARTIFACT_TOKEN"),
        ("budget", runners[0], "LLMOPS_BUDGET_TOKEN"),
    ):
        item = storage.inspect(identity)
        labels = item["Config"].get("Labels") or {}
        if (
            item["Id"] != identity
            or item["Image"] != record["image"]
            or labels.get("com.docker.compose.project") != source["compose_project"]
            or labels.get("com.docker.compose.service") != record["service"]
        ):
            raise ValueError("Runtime token consumer changed")
        values[name] = storage.environment(item).get(token_name, "")
    return values


def evaluation_tokens(namespaced, source, images):
    import evaluation_snapshot

    nk = list(namespaced)
    index = nk.index(source["namespace"])
    nk[index] = evaluation_snapshot.NAMESPACE
    values, versions = {}, {}
    for key, component, secret_name, token_name in (
        ("artifact", "ops-artifacts", "llmops-artifacts", "LLMOPS_ARTIFACT_TOKEN"),
        ("budget", "evaluation-runner", "llmops-runner", "LLMOPS_BUDGET_TOKEN"),
    ):
        deployment = database.read_json(nk + ["get", "deployment", component, "-o", "json"])
        expected = source["evaluation"]["deployments"][component]
        if (
            deployment["metadata"]["uid"] != expected["uid"]
            or evaluation_snapshot.fingerprint(deployment["spec"]) != expected["spec_sha256"]
        ):
            raise ValueError("Kubernetes token consumer changed")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        env = container.get("env", [])
        mapping = {row["name"]: row for row in env}
        if (
            container.get("envFrom")
            or len(mapping) != len(env)
            or mapping.get(token_name)
            != {
                "name": token_name,
                "valueFrom": {"secretKeyRef": {"name": secret_name, "key": token_name}},
            }
        ):
            raise ValueError("Evaluation consumer does not reference the captured token")
        if (
            key == "artifact"
            and database.read_json(["docker", "image", "inspect", container["image"]])[0]["Id"]
            not in images
        ):
            raise ValueError("Ops and artifact server images differ")
        item = database.read_json(nk + ["get", "secret", secret_name, "-o", "json"])
        meta = item["metadata"]
        if (
            meta["name"] != secret_name
            or meta["namespace"] != evaluation_snapshot.NAMESPACE
            or not meta.get("uid")
            or not meta.get("resourceVersion")
            or meta.get("deletionTimestamp")
            or item.get("type") != "Opaque"
        ):
            raise ValueError("Unexpected evaluation Secret identity")
        values[key] = base64.b64decode(item["data"][token_name], validate=True).decode("utf-8")
        versions[secret_name] = {"uid": meta["uid"], "version": meta["resourceVersion"]}
    return values, versions


def run_probe(value, action):
    validate(value)
    if action not in {"capture", "verify"}:
        raise ValueError("Unsupported runtime key action")
    storage.run(["docker", "image", "inspect", value["image"]])
    identity = None
    try:
        identity = (
            storage.run(
                [
                    "docker",
                    "create",
                    "--interactive",
                    "--pull=never",
                    "--network=none",
                    "--log-driver=none",
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges:true",
                    "--memory=256m",
                    "--pids-limit=32",
                    "--tmpfs=/tmp:rw,noexec,nosuid,size=16m,mode=1777",
                    "--name",
                    "govbiz-ops-key-verify-" + uuid4().hex,
                    "--entrypoint",
                    "python",
                    value["image"],
                    "-B",
                    "-c",
                    PROBE,
                    action,
                ]
            )
            .decode()
            .strip()
        )
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid key helper identity")
        raw = storage.run(
            ["docker", "start", "--attach", "--interactive", identity],
            data=json.dumps({"keys": value["keys"], "proof": value.get("proof")}).encode(),
        )
        state = database.read_json(["docker", "inspect", "--format", "{{json .State}}", identity])
        if state["Running"] or state["ExitCode"] != 0 or state["OOMKilled"]:
            raise ValueError("Key helper failed")
        result = json.loads(raw)
        if action == "verify" and result != {
            "status": "VERIFIED",
            "django_signature_verified": True,
            "artifact_wsgi_auth_verified": True,
            "key_count": sum(bool(key) for key in value["keys"].values()),
        }:
            raise ValueError("Incomplete key verification")
        if action == "capture" and (
            set(result) != {"nonce", "tags", "django_signature"}
            or not re.fullmatch(r"[a-f0-9]{64}", result["nonce"])
            or not result["django_signature"]
            or set(result["tags"]) != {name for name, key in value["keys"].items() if key}
            or any(not re.fullmatch(r"[a-f0-9]{64}", tag) for tag in result["tags"].values())
        ):
            raise ValueError("Incomplete source key proof")
    finally:
        if identity is not None:
            storage.run(["docker", "rm", "--force", "--volumes", identity])
    return result


def receipt_signatures(entries, token):
    """Authenticate all archived usage receipts; no DB correction or paid call."""
    count = 0

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate receipt key")
            result[key] = value
        return result

    for name, entry in entries.items():
        if "/capture/usage-" not in name or name.endswith("/capture/usage-summary.json"):
            continue
        parts = name.split("/")
        match = re.fullmatch(r"usage-(0|[1-9][0-9]{0,2})\.json", parts[-1])
        if (
            len(parts) != 3
            or parts[1] != "capture"
            or str(UUID(parts[0])) != parts[0]
            or not match
            or int(match[1]) > 511
            or entry["kind"] != "file"
            or not 0 < entry["size"] <= 8192
            or not token
        ):
            raise ValueError("Unsupported signed usage receipt")
        raw = base64.b64decode(entry["data"], validate=True)
        envelope = json.loads(raw, object_pairs_hook=unique)
        payload = envelope["payload"]
        version = payload["version"]
        if (
            set(envelope) != {"payload", "signature"}
            or type(version) is not int
            or version not in {1, 2}
            or payload["run_id"] != parts[0]
            or type(payload["sequence"]) is not int
            or payload["sequence"] != int(match[1])
        ):
            raise ValueError("Usage receipt identity differs")
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(
            token.encode(), f"govbiz-budget-usage-v{version}\n".encode() + canonical, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(signature, envelope["signature"]):
            raise ValueError("Usage receipt signature cannot be recovered")
        count += 1
    return count
