"""Opt-in external integrations for one owned local fork cluster.

Never source an env file, write secrets to Git/Argo values, or rotate DB/JWT keys.
The default shared release remains offline. A private local profile selects the
integration overlay, so future GitOps image promotions retain the user's choice.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import uuid

import yaml

from check_msa import ROOT, SERVICES, NAMESPACE, policy_errors

FEATURES = {"rabbitmq", "ai", "mail", "google", "kakao", "bizno", "collection", "index", "documents", "reports"}
BACKGROUND = {"collection", "index", "documents", "reports"}
KEYS = {
    "ai": ("OPENAI_API_KEY",),
    "mail": ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"),
    "google": ("ACCOUNT_OAUTH_GOOGLE_CLIENT_ID", "ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET"),
    "kakao": ("ACCOUNT_OAUTH_KAKAO_CLIENT_ID", "ACCOUNT_OAUTH_KAKAO_CLIENT_SECRET", "ACCOUNT_OAUTH_KAKAO_ADMIN_KEY"),
    "bizno": ("BIZNO_API_KEY",),
    "collection": ("DATA_GO_KR_SERVICE_KEY", "KSTARTUP_API_KEY", "MSIT_API_KEY", "CNTRADE_NOTICE_API_KEY"),
}
MODEL_KEYS = ("OPENAI_MODEL", "OPENAI_RANKING_MODEL", "OPENAI_RANKING_REASONING_EFFORT",
              "OPENAI_RANKING_SERVICE_TIER", "OPENAI_ASSISTANT_MODEL", "OPENAI_ASSISTANT_AGENT_MODEL")
INPUT_KEYS = {key for group in KEYS.values() for key in group} | set(MODEL_KEYS) | {
    "SMTP_PORT", "ACCOUNT_PASSWORD_RESET_FROM", "DAILY_REPORT_FROM"}
QUEUES = ("DAILY_REPORT_QUEUE_ENABLED", "DAILY_REPORT_DELIVERY_QUEUE_ENABLED", "COMBINATION_REVIEW_QUEUE_ENABLED",
          "APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED", "ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED")


def read_inputs(paths):
    """Read only named integration keys. Shell substitutions are never executed."""
    values = {}
    for path in paths:
        path = Path(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError("Use an owned regular env file that is not group/world writable")
        for line in path.read_text().splitlines():
            match = re.match(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$", line)
            if not match or match[1] not in INPUT_KEYS:
                continue
            key, value = match.groups()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if "$" in value or "`" in value or "\x00" in value or len(value) > 8192:
                raise ValueError("Use literal single-line values for " + key)
            if value:
                values[key] = value
    # The same data.go.kr subscription key can authorize all four providers.
    for key in ("KSTARTUP_API_KEY", "MSIT_API_KEY", "CNTRADE_NOTICE_API_KEY"):
        if key not in values and "DATA_GO_KR_SERVICE_KEY" in values:
            values[key] = values["DATA_GO_KR_SERVICE_KEY"]
    return values


def validate_features(features):
    if not features or not set(features) <= FEATURES or len(features) != len(set(features)):
        raise ValueError("Choose distinct supported integration features")
    if set(features) & BACKGROUND and "ai" not in features:
        raise ValueError("Collection publishes embeddings too; background features require ai")
    if set(features) & {"documents", "reports"} and "rabbitmq" not in features:
        raise ValueError("Documents/reports require rabbitmq")
    if "reports" in features and "mail" not in features:
        raise ValueError("Reports require mail")


def validate_profile(profile):
    allowed = {"schemaVersion", "repository", "stateId", "features", "origin", "revision", "modelKeys"}
    if set(profile) != allowed or profile["schemaVersion"] != 1:
        raise ValueError("Invalid integrations profile")
    validate_features(profile["features"])
    if profile["origin"] not in {"http://127.0.0.1:5173", "http://localhost:5173"}:
        raise ValueError("Only the local web origin is supported; register that exact OAuth callback")
    if not re.fullmatch(r"[a-f0-9]{32}", profile["revision"]):
        raise ValueError("Invalid integration revision")
    if not set(profile["modelKeys"]) <= set(MODEL_KEYS):
        raise ValueError("Unexpected model key")


def load_profile(state, settings):
    path = Path(state) / "integrations.json"
    if not path.exists() and not path.is_symlink():
        return None
    if path.is_symlink():
        raise ValueError("Integration profile must not be a symlink")
    profile = json.loads(path.read_text())
    validate_profile(profile)
    if any(profile[key] != settings[key] for key in ("repository", "stateId")):
        raise ValueError("Integration profile belongs to another local fork")
    return profile


def overrides(profile, root=ROOT):
    if profile is None:
        return {}
    validate_profile(profile)
    features, origin = set(profile["features"]), profile["origin"]
    result = {service: {"env": {"GOVBIZ_INTEGRATION_REVISION": profile["revision"]},
                       "secretKeys": yaml.safe_load((root / f"environments/fork/{service}.yaml").read_text())["secretKeys"]}
              for service in SERVICES if service != "ops-service"}
    core, catalog, ai = (result[name]["env"] for name in ("core-service", "catalog-service", "ai-service"))
    core.update(APP_CORS_ALLOWED_ORIGIN=origin, ACCOUNT_OAUTH_CALLBACK_BASE_URL=origin,
                ACCOUNT_OAUTH_FRONTEND_BASE_URL=origin, ACCOUNT_PASSWORD_RESET_FRONTEND_BASE_URL=origin,
                DAILY_REPORT_FRONTEND_BASE_URL=origin, ACCOUNT_COOKIE_SECURE="false", ACCOUNT_DEV_LOGIN_ENABLED="false")
    if "rabbitmq" in features:
        core.update(RABBITMQ_HOST="rabbitmq", RABBITMQ_PORT="5672", RABBITMQ_USERNAME="govbiz", RABBITMQ_VHOST="govbiz")
        core.update({name: "true" for name in QUEUES})
        result["core-service"]["secretKeys"].append("RABBITMQ_PASSWORD")
    # Saved-program prefetch embeds documents and refreshes them automatically.
    # Broker connectivity alone must not authorize recurring paid work.
    core["ASSISTANT_PREFETCH_QUEUE_ENABLED"] = str({"rabbitmq", "index"} <= features).lower()
    if "ai" in features:
        ai["OPENAI_BASE_URL"] = "https://api.openai.com/v1"
        core["ASSISTANT_AGENT_ENABLED"] = "true"
        result["ai-service"]["secretKeys"] += profile["modelKeys"]
    if "mail" in features:
        core.update(ACCOUNT_PASSWORD_RESET_MAIL_ENABLED="true", ACCOUNT_EMAIL_VERIFICATION_MAIL_ENABLED="true",
                    SMTP_AUTH="true", SMTP_STARTTLS_ENABLED="true", SMTP_SSL_ENABLED="false")
        result["core-service"]["secretKeys"] += list(KEYS["mail"]) + ["SMTP_PORT", "ACCOUNT_PASSWORD_RESET_FROM", "DAILY_REPORT_FROM"]
    for feature in ("google", "kakao", "bizno"):
        if feature in features:
            result["core-service"]["secretKeys"] += list(KEYS[feature])
    if "collection" in features:
        for source in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE"):
            catalog.update({source + "_SYNC_ENABLED": "true", source + "_SYNC_INITIAL_DELAY": "PT30S",
                            source + "_SYNC_FIXED_DELAY": "PT6H"})
    if "index" in features:
        catalog.update(SUPPORT_PROGRAM_INDEX_ENABLED="true", SUPPORT_PROGRAM_INDEX_INITIAL_DELAY="PT5M",
                       SUPPORT_PROGRAM_INDEX_FIXED_DELAY="PT6H")
    if "documents" in features:
        core["APPLICATION_FORM_ANALYSIS_ENABLED"] = "true"
    if "reports" in features:
        core.update(DAILY_REPORT_ENABLED="true", DAILY_REPORT_MAIL_ENABLED="true")
    for value in result.values():
        value["secretKeys"] = sorted(set(value["secretKeys"]))
    return result


def secret_updates(features, inputs):
    missing = sorted({key for feature in features for key in KEYS.get(feature, ()) if not inputs.get(key)})
    if missing:
        raise ValueError("Missing integration keys: " + ", ".join(missing))
    result = {"core-runtime": {}, "catalog-runtime": {}, "ai-runtime": {}}
    for feature in features:
        target = "ai-runtime" if feature == "ai" else "catalog-runtime" if feature == "collection" else "core-runtime"
        result[target].update({key: inputs[key] for key in KEYS.get(feature, ())})
    if "ai" in features:
        result["ai-runtime"].update({key: inputs[key] for key in MODEL_KEYS if key in inputs})
    if "mail" in features:
        if inputs.get("SMTP_PORT", "587") != "587":
            raise ValueError("This local mail profile requires STARTTLS on port 587")
        sender = inputs.get("ACCOUNT_PASSWORD_RESET_FROM", inputs["SMTP_USERNAME"])
        result["core-runtime"].update(SMTP_PORT="587", ACCOUNT_PASSWORD_RESET_FROM=sender,
                                      DAILY_REPORT_FROM=inputs.get("DAILY_REPORT_FROM", sender))
    return result


def quiet(command, data=None):
    """Never echo kubectl diagnostics for commands carrying secret stdin."""
    result = subprocess.run([str(part) for part in command], input=data, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError("Cluster secret operation failed; secret-bearing output was suppressed")
    return result.stdout


def patch_secret(nk, name, values):
    payload = {"data": {key: base64.b64encode(value.encode()).decode() for key, value in values.items()}}
    quiet(nk + ["patch", "secret", name, "--type=merge", "--patch-file=/dev/stdin"], json.dumps(payload))


def configure(args, state, settings):
    from fork_cluster import commands, verify_context, locked, run, write_json, applications
    features = args.features.split(",")
    validate_features(features)
    inputs = read_inputs(args.env_file)
    updates = secret_updates(features, inputs)
    profile = {"schemaVersion": 1, "repository": settings["repository"], "stateId": settings["stateId"],
               "features": sorted(features), "origin": args.origin, "revision": uuid.uuid4().hex,
               "modelKeys": sorted(set(inputs) & set(MODEL_KEYS)) if "ai" in features else []}
    overlay = overrides(profile)
    # Validate exactly what will run, without relaxing base release/ownership checks.
    for service, value in overlay.items():
        rendered = run([args.helm, "template", service, ROOT / "charts/govbiz-service", "-n", NAMESPACE,
                        "-f", ROOT / f"environments/fork/{service}.yaml", "-f", "-"], data=yaml.safe_dump(value), capture=True)
        errors = policy_errors(service, list(yaml.safe_load_all(rendered)))
        if errors:
            raise ValueError("\n".join(errors))
    print("Validated integration plan: " + ", ".join(features), flush=True)
    if not args.apply:
        print("Plan only: no cluster writes or external API calls. No credentials were printed.")
        return
    if set(features) & BACKGROUND and not args.allow_background_paid_work:
        raise ValueError("Background collection also embeds data. Explicit --allow-background-paid-work is required; no USD cap is enforced by this tool")
    with locked(state):
        kube, nk, ak = commands(state, settings)
        verify_context(kube, settings)
        current = applications(kube, ak)
        expected = {"govbiz-fork-" + service for service in SERVICES}
        if settings["mode"] != "gitops" or {app["metadata"]["name"] for app in current} != expected:
            raise ValueError("Configure existing owned four-Application GitOps environment first")
        previous = overrides(load_profile(state, settings))
        for app in current:
            service = app["metadata"]["name"].removeprefix("govbiz-fork-")
            source = app["spec"]["source"]
            if (source["repoURL"] != "https://github.com/" + settings["repository"] + ".git"
                    or source["targetRevision"] != settings["branch"]
                    or source["path"] != "infrastructure/gitops/charts/govbiz-service"
                    or source["helm"].get("valuesObject", {}) != previous.get(service, {})
                    or any(key in source["helm"] for key in ("values", "parameters", "fileParameters"))):
                raise ValueError("Unexpected Argo source/overrides: refusing to overwrite other changes")
            if app.get("operation") or app.get("status", {}).get("operationState", {}).get("phase") in {"Running", "Terminating"}:
                raise ValueError("Wait for current Argo operation to finish before changing integrations")
        # Require original secrets to exist before adding credentials. No implicit DB/JWT reset.
        for name in updates:
            quiet(nk + ["get", "secret", name, "-o", "name"])
        if "rabbitmq" in features:
            raw = quiet(nk + ["get", "secret", "rabbitmq-runtime", "--ignore-not-found", "-o", "json"])
            if raw.strip():
                password = base64.b64decode(json.loads(raw)["data"]["RABBITMQ_PASSWORD"]).decode()
            else:
                if quiet(nk + ["get", "pvc", "data-rabbitmq-0", "--ignore-not-found", "-o", "name"]).strip():
                    raise ValueError("RabbitMQ PVC exists without credentials; refusing to reset the broker password")
                password = secrets.token_urlsafe(32)
                resource = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "rabbitmq-runtime", "namespace": NAMESPACE},
                            "type": "Opaque", "stringData": {"RABBITMQ_PASSWORD": password, "RABBITMQ_ERLANG_COOKIE": secrets.token_hex(32)}}
                quiet(kube + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"], yaml.safe_dump(resource))
            updates["core-runtime"]["RABBITMQ_PASSWORD"] = password
            broker = run([args.helm, "template", "fork-data", ROOT / "charts/govbiz-local-data", "-n", NAMESPACE,
                          "--set", "allowDisposableData=true", "--set", "rabbitmq.enabled=true",
                          "--show-only", "templates/rabbitmq.yaml"], capture=True)
            run(kube + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"], data=broker)
            run(nk + ["rollout", "status", "statefulset/rabbitmq", "--timeout=450s"])
        for name, values in updates.items():
            if values:
                patch_secret(nk, name, values)
        # Record no credentials, only features and variable NAMES; preserve across promotions/re-entry.
        write_json(Path(state) / "integrations.json", profile)
        for service in ("ai-service", "core-service", "catalog-service"):
            patch = {"spec": {"source": {"helm": {"valuesObject": overlay[service]}}}}
            # Replace the entire object (not recursive merge) so a removed feature is actually disabled.
            run(ak + ["patch", "application", "govbiz-fork-" + service, "--type=json", "--patch-file=/dev/stdin"],
                data=json.dumps([{"op": "add", "path": "/spec/source/helm/valuesObject", "value": patch["spec"]["source"]["helm"]["valuesObject"]}]))
        print("Configured. Wait for Argo Synced/Healthy and verify feature endpoints; this is not end-to-end success.")


def main():
    from fork_cluster import STATE, load_settings
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--env-file", type=Path, action="append", default=[])
    parser.add_argument("--features", required=True, help=",".join(sorted(FEATURES)))
    parser.add_argument("--origin", default="http://127.0.0.1:5173")
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--allow-background-paid-work", action="store_true", help="Explicit cost approval; NOT a spending cap")
    args = parser.parse_args()
    try:
        configure(args, args.state_dir, load_settings(args.state_dir))
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        # Do not stringify arbitrary subprocess output, env data or HTTP responses.
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.exit(1, "Integration setup stopped: " + message + "\n")


if __name__ == "__main__":
    main()
