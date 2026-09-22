"""Run the existing budget-checked Catalog CLI once in the owned local cluster.

Collection includes paid embeddings. --apply is explicit; failed/unknown runs
are never automatically retried. Receipts live on a dedicated retained PVC.
This per-run guard is not an aggregate daily/monthly AI spending limit.
"""
import argparse
from copy import deepcopy
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
import subprocess

import yaml

from connected_runtime import read_inputs, patch_secret
from fork_cluster import STATE, commands, load_settings, locked, verify_context, run, write_json
from check_msa import NAMESPACE

SOURCE_KEYS = {
    "BIZINFO": "DATA_GO_KR_SERVICE_KEY",
    "KSTARTUP": "KSTARTUP_API_KEY",
    "MSIT": "MSIT_API_KEY",
    "CNTRADE_NOTICE": "CNTRADE_NOTICE_API_KEY",
}
SOURCES = set(SOURCE_KEYS)


def job(deployment, run_id, sources, max_usd, apply):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,35}", run_id):
        raise ValueError("Use a new lowercase run ID (up to 36 characters)")
    if not sources or not set(sources) <= SOURCES or len(sources) != len(set(sources)):
        raise ValueError("Select distinct supported sources")
    try:
        budget = Decimal(max_usd)
    except InvalidOperation:
        raise ValueError("max-usd must be a decimal USD amount") from None
    if not budget.is_finite() or not Decimal(0) < budget <= Decimal(1):
        raise ValueError("max-usd must be positive and at most 1 USD")
    pod = deepcopy(deployment["spec"]["template"]["spec"])
    container = pod["containers"][0]
    env = {entry["name"]: entry.get("value") for entry in container["env"]}
    if any(env.get(source + "_SYNC_ENABLED") != "false" for source in SOURCES) or env.get("SUPPORT_PROGRAM_INDEX_ENABLED") != "false":
        raise ValueError("Stop Catalog scheduled writers before a bounded one-shot run")
    if not re.fullmatch(r"ghcr\.io/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}", container["image"]):
        raise ValueError("Use the currently verified immutable Catalog image")
    for name in ("startupProbe", "readinessProbe", "livenessProbe", "ports"):
        container.pop(name, None)
    container["args"] = ["--spring.profiles.active=catalog-sync-once", "--spring.main.web-application-type=none",
                         "--app.catalog-sync-once.sources=" + ",".join(sources),
                         "--app.catalog-sync-once.max-usd=" + str(budget),
                         "--app.catalog-sync-once.receipt-path=/receipts/" + run_id + ".receipt",
                         "--app.catalog-sync-once.apply=" + str(apply).lower()]
    container["resources"] = {"requests": {"cpu": "100m", "memory": "256Mi"}, "limits": {"cpu": "1", "memory": "768Mi"}}
    pod["restartPolicy"] = "Never"
    pod["volumes"].append({"name": "receipts", **({"persistentVolumeClaim": {"claimName": "catalog-sync-receipts"}} if apply else {"emptyDir": {"sizeLimit": "1Mi"}})})
    container["volumeMounts"].append({"name": "receipts", "mountPath": "/receipts"})
    name = "catalog-once-" + run_id + ("-apply" if apply else "-plan")
    return {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "namespace": NAMESPACE, "labels": {"govbiz-task": "catalog-once"}},
            "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 1800,
                     "template": {"metadata": {"labels": {"govbiz-task": "catalog-once"}}, "spec": pod}}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--sources", default="BIZINFO,KSTARTUP,MSIT,CNTRADE_NOTICE")
    parser.add_argument("--max-usd", required=True)
    parser.add_argument("--env-file", type=Path, action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        settings = load_settings(args.state_dir)
        with locked(args.state_dir):
            kube, nk, _ = commands(args.state_dir, settings)
            verify_context(kube, settings)
            deployment = json.loads(run(nk + ["get", "deployment", "catalog-service", "-o", "json"], capture=True))
            sources = args.sources.split(",")
            resource = job(deployment, args.run_id, sources, args.max_usd, args.apply)
            # A plan only collects public notices and never reaches the AI service.
            # Applying must verify the actual deployed embedding client before writes.
            check = "import asyncio; from app.config import Settings; from app.bootstrap import build_application_container; s=Settings.from_environment(); assert s.openai_embedding_model == 'text-embedding-3-small'; c=build_application_container(s); assert c.openai_client.max_retries == 0; assert str(c.openai_client.base_url)=='https://api.openai.com/v1/'; asyncio.run(c.close()); print('Deployed embedding model/endpoint/retry policy verified without an API request')"
            if args.apply:
                run(nk + ["exec", "deployment/ai-service", "--", "python", "-c", check])
            name = resource["metadata"]["name"]
            ledger = args.state_dir / (name + ".json")
            if ledger.exists() or run(nk + ["get", "job", name, "--ignore-not-found", "-o", "name"], capture=True).strip():
                raise ValueError("This run was already submitted or reserved; inspect it, do not retry automatically")
            running = json.loads(run(nk + ["get", "jobs", "-l", "govbiz-task=catalog-once", "-o", "json"], capture=True))["items"]
            if any(item.get("status", {}).get("active", 0) for item in running):
                raise ValueError("Another Catalog one-shot job is active")
            inputs = read_inputs(args.env_file)
            required_keys = [SOURCE_KEYS[source] for source in sources]
            missing = [key for key in required_keys if not inputs.get(key)]
            if missing:
                raise ValueError("Missing provider key names: " + ", ".join(missing))
            patch_secret(nk, "catalog-runtime", {key: inputs[key] for key in required_keys})
            if args.apply:
                pvc = {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": "catalog-sync-receipts", "namespace": NAMESPACE},
                       "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "1Gi"}}}}
                run(kube + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"], data=yaml.safe_dump(pvc))
            write_json(ledger, {"repository": settings["repository"], "runId": args.run_id, "maxUsd": args.max_usd,
                                "apply": args.apply, "status": "reserved-before-submit"})
            # No shell and no token data in the Job: references to existing service-scoped Secret only.
            run(kube + ["create", "-f", "-"], data=yaml.safe_dump(resource))
            print("Submitted " + name + "; backoffLimit=0; inspect Job status before any further action.")
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, "Catalog job stopped: " + (str(error) if isinstance(error, ValueError) else type(error).__name__) + "\n")


if __name__ == "__main__":
    main()
