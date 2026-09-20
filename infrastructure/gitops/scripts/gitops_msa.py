"""Opt-in Git revision reconciliation inside smoke_msa's disposable cluster only."""

import hashlib
import json
import re
import subprocess
import time
import urllib.request

import yaml

from check_msa import ROOT, SERVICES

ARGO_VERSION = "v3.5.3"
ARGO_INSTALL = f"https://raw.githubusercontent.com/argoproj/argo-cd/{ARGO_VERSION}/manifests/core-install.yaml"
ARGO_INSTALL_SHA256 = "1a87025d8eb2eae621653fd312fb9ca51df1b4b3b6992a030e3a9ef38e45c448"


def validate_revisions(revisions):
    if len(revisions) != 2 or revisions[0] == revisions[1] or not all(re.fullmatch(r"[0-9a-f]{40}", r) for r in revisions):
        raise ValueError("Pass two distinct, verified and already-pushed full Git SHAs")


def verify(kube, cluster, images, kind, temp, revisions):
    """First manual sync, then automatic A→B→A. B must change only AI's values."""
    validate_revisions(revisions)
    if not re.fullmatch(r"govbiz-msa-smoke-[0-9a-f]{10}", cluster):
        raise ValueError("GitOps verification is limited to a new MSA smoke cluster")

    def run(command, *, data=None, capture=False, timeout=300):
        result = subprocess.run([str(p) for p in command], input=data, check=True, text=True,
                                capture_output=capture, timeout=timeout)
        return result.stdout if capture else None

    ak = kube + ["--namespace", "argocd"]
    nk = kube + ["--namespace", "govbiz-msa"]
    nodes = run([kind, "get", "nodes", "--name", cluster], capture=True).splitlines()
    if nodes != [cluster + "-control-plane"]:
        raise RuntimeError("Expected exactly this disposable cluster's single kind node")
    node = nodes[0]
    aliases = []
    try:
        # Reuse the already verified images inside this disposable node. Do not
        # re-export large layers or create/overwrite aliases in the user's Docker.
        for service in SERVICES:
            alias = "docker.io/library/govbiz-" + service + ":local-k8s"
            run(["docker", "exec", node, "ctr", "--namespace", "k8s.io", "images", "tag",
                 "docker.io/library/" + images[service], alias])
            aliases.append(alias)
        install = temp / "argocd-core-install.yaml"
        with urllib.request.urlopen(ARGO_INSTALL, timeout=60) as response:
            payload = response.read()
        if hashlib.sha256(payload).hexdigest() != ARGO_INSTALL_SHA256:
            raise RuntimeError("Pinned Argo CD Core install manifest checksum changed")
        install.write_bytes(payload)
        namespace = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "argocd"}}
        run(kube + ["apply", "-f", "-"], data=yaml.safe_dump(namespace))
        run(ak + ["apply", "--server-side", "-f", install])
        run(ak + ["patch", "configmap", "argocd-cm", "--type=merge", "-p", json.dumps({"data": {
            "application.resourceTrackingMethod": "annotation", "application.instanceLabelKey": "argocd.argoproj.io/instance"}})])
        workloads = json.loads(run(ak + ["get", "deployments,statefulsets", "-o", "json"], capture=True))["items"]
        for workload in workloads:
            run(ak + ["rollout", "status", workload["kind"].lower() + "/" + workload["metadata"]["name"], "--timeout=400s"], timeout=450)
        run(ak + ["apply", "-f", ROOT / "argocd/local/project.yaml"])
        apps = list(yaml.safe_load_all((ROOT / "argocd/local/applications.yaml").read_text()))

        def apply_apps(revision, automated):
            for app in apps:
                app["spec"]["source"]["targetRevision"] = revision
                if automated:
                    app["spec"]["syncPolicy"]["automated"] = {"enabled": True, "prune": False, "selfHeal": True}
                else:
                    app["spec"]["syncPolicy"].pop("automated", None)
            run(ak + ["apply", "-f", "-"], data=yaml.safe_dump_all(apps))

        def synced(revision):
            deadline = time.monotonic() + 500
            while time.monotonic() < deadline:
                items = json.loads(run(ak + ["get", "applications", "-o", "json"], capture=True))["items"]
                statuses = [a.get("status", {}) for a in items]
                if len(statuses) == 4 and all(s.get("sync", {}).get("revision") == revision
                        and s.get("sync", {}).get("status") == "Synced"
                        and s.get("health", {}).get("status") == "Healthy" for s in statuses):
                    print("PASS: Argo CD fetched and reconciled Git revision " + revision, flush=True)
                    return
                time.sleep(5)
            run(ak + ["get", "applications", "-o", "yaml"])
            raise RuntimeError("Argo CD did not reach the requested Git revision")

        def uids():
            items = json.loads(run(nk + ["get", "pods", "-o", "json"], capture=True))["items"]
            result = {}
            for pod in items:
                name = pod["metadata"].get("labels", {}).get("app.kubernetes.io/name")
                if name in SERVICES and not pod["metadata"].get("deletionTimestamp"):
                    if name in result:
                        raise RuntimeError("Multiple service Pods during settled GitOps verification")
                    result[name] = pod["metadata"]["uid"]
            if set(result) != set(SERVICES):
                raise RuntimeError("Missing application Pod after GitOps sync")
            return result

        apply_apps(revisions[0], False)
        for app in apps:
            run(ak + ["patch", "application", app["metadata"]["name"], "--type=merge", "-p",
                      json.dumps({"operation": {"sync": {"revision": revisions[0], "prune": False}}})])
        synced(revisions[0])
        before = uids()
        apply_apps(revisions[1], True)
        synced(revisions[1])
        after = uids()
        if [name for name in SERVICES if before[name] != after[name]] != ["ai-service"]:
            raise RuntimeError("Git B must roll exactly AI and leave all other Pods unchanged")
        apply_apps(revisions[0], True)
        synced(revisions[0])
        restored = uids()
        if [name for name in SERVICES if after[name] != restored[name]] != ["ai-service"]:
            raise RuntimeError("Git rollback must roll exactly AI")
        return {"status": "passed", "version": ARGO_VERSION, "installSha256": hashlib.sha256(payload).hexdigest(),
                "revisions": [revisions[0], revisions[1], revisions[0]],
                "mode": "Argo CD Core; pinned Git revisions, AI-only config rollout/revert, no image publishing CI"}
    finally:
        for alias in aliases:
            # Only aliases in our disposable node; original loaded images remain.
            subprocess.run(["docker", "exec", node, "ctr", "--namespace", "k8s.io", "images", "rm", alias], check=False)
