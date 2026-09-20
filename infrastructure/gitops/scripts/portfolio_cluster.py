"""Historical Mac bootstrap retained for review and offline unit tests.

The CLI is locked in the unified submission: personal GHCR identity, images and
persistent-cluster onboarding have not been migrated. Use smoke_msa.py with
locally built images for isolated validation, not this former Mac bootstrap.
"""
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen

import yaml

from check_msa import ROOT, NAMESPACE, REPOSITORY_ROOT, REPOSITORY_URL, REPOSITORY_BRANCH
from check_portfolio import errors
from gitops_msa import ARGO_INSTALL, ARGO_INSTALL_SHA256

CLUSTER = "govbiz-portfolio"
STATE = ROOT / ".local/portfolio"
RUNTIME_SECRETS = {"core-mysql-runtime", "catalog-mysql-runtime", "ops-mysql-runtime",
                   "core-runtime", "catalog-runtime", "ai-runtime", "ops-runtime"}


def run(command, data=None, capture=False, timeout=600):
    return subprocess.run([str(p) for p in command], input=data, check=True, text=True,
                          capture_output=capture, timeout=timeout).stdout


def read_token(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        raise ValueError("Token must be your regular non-symlink file with mode 0600")
    token = path.read_text().strip()
    if not token or len(token) > 512 or any(c.isspace() for c in token):
        raise ValueError("Malformed token")
    return token


def verify_token(token):
    request = Request("https://api.github.com/user", headers={"Authorization": "Bearer " + token,
                                                           "Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=30) as response:
        scopes = {s.strip() for s in response.headers.get("X-OAuth-Scopes", "").split(",") if s.strip()}
        login = json.load(response).get("login")
    if scopes != {"read:packages"} or login != "ilil1":
        raise ValueError("Historical owner-specific credential check; per-fork bootstrap is not configured")
    return login


def pull_secret(login, token):
    auth = base64.b64encode((login + ":" + token).encode()).decode()
    return {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "ghcr-pull", "namespace": NAMESPACE},
            "type": "kubernetes.io/dockerconfigjson", "stringData": {".dockerconfigjson":
                json.dumps({"auths": {"ghcr.io": {"auth": auth}}})}}


def runtime_secrets():
    passwords = {owner: secrets.token_urlsafe(30) for owner in ("core", "catalog", "ops")}
    catalog, document, assistant = (secrets.token_hex(32) for _ in range(3))
    values = {owner + "-mysql-runtime": {"MYSQL_PASSWORD": password, "MYSQL_ROOT_PASSWORD": secrets.token_urlsafe(30)}
              for owner, password in passwords.items()}
    values.update({
        "core-runtime": {"SPRING_DATASOURCE_PASSWORD": passwords["core"], "ACCOUNT_JWT_SECRET": secrets.token_hex(32),
                         "CATALOG_INTERNAL_TOKEN": catalog, "DOCUMENT_INTERNAL_TOKEN": document, "ASSISTANT_TOOLS_TOKEN": assistant},
        "catalog-runtime": {"SPRING_DATASOURCE_PASSWORD": passwords["catalog"], "CATALOG_INTERNAL_TOKEN": catalog,
                            "DATA_GO_KR_SERVICE_KEY": "disabled", "KSTARTUP_API_KEY": "disabled",
                            "MSIT_API_KEY": "disabled", "CNTRADE_NOTICE_API_KEY": "disabled"},
        "ai-runtime": {"OPENAI_API_KEY": "disabled-no-paid-api", "DOCUMENT_INTERNAL_TOKEN": document, "ASSISTANT_TOOLS_TOKEN": assistant},
        "ops-runtime": {"DJANGO_SECRET_KEY": secrets.token_hex(32), "DB_PASSWORD": passwords["ops"]},
    })
    return [{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": NAMESPACE},
             "type": "Opaque", "stringData": data} for name, data in values.items()]


def commands(state):
    config = state / "kubeconfig"
    kube = ["kubectl", "--kubeconfig", config, "--context", "kind-" + CLUSTER]
    return kube, kube + ["-n", NAMESPACE], kube + ["-n", "argocd"]


def verify_context(kube):
    config = json.loads(run(kube + ["config", "view", "--minify", "-o", "json"], capture=True))
    server = config["clusters"][0]["cluster"]["server"]
    if not server.startswith("https://127.0.0.1:"):
        raise ValueError("Only the dedicated loopback kind cluster is allowed")
    nodes = json.loads(run(kube + ["get", "nodes", "-o", "json"], capture=True))["items"]
    if [n["metadata"]["name"] for n in nodes] != [CLUSTER + "-control-plane"]:
        raise ValueError("Unexpected cluster; refusing credentials and changes")


def prepare(args, state):
    token = read_token(args.token_file) if args.token_file else getpass.getpass("GHCR read-only token (hidden): ").strip()
    login = verify_token(token)
    if errors(helm=args.helm):
        raise ValueError("Portfolio configuration policy failed")
    if "v0.33.0" not in run([args.kind, "version"], capture=True):
        raise ValueError("Use kind v0.33.0")
    platform = run(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], capture=True).strip()
    if platform != "linux/amd64":
        raise ValueError("Current GHCR images are linux/amd64; do not silently emulate another architecture")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    kube, nk, ak = commands(state)
    clusters = run([args.kind, "get", "clusters"], capture=True).splitlines()
    if CLUSTER not in clusters:
        if (state / "kubeconfig").exists():
            raise ValueError("Stale kubeconfig exists; inspect it explicitly before creating a replacement cluster")
        run([args.kind, "create", "cluster", "--name", CLUSTER, "--config", ROOT / "kind/local.yaml",
             "--kubeconfig", state / "kubeconfig", "--wait", "180s"], timeout=300)
    os.chmod(state / "kubeconfig", 0o600)
    verify_context(kube)
    run(["docker", "update", "--restart=unless-stopped", CLUSTER + "-control-plane"])

    def apply(resources):
        # stdin only: never log credentials or create kubectl last-applied copies.
        run(kube + ["apply", "--server-side", "-f", "-"], data=yaml.safe_dump_all(resources))

    apply([{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": n}}
           for n in (NAMESPACE, "argocd")])
    apply([pull_secret(login, token)])
    token = None
    existing = {s["metadata"]["name"] for s in json.loads(run(nk + ["get", "secrets", "-o", "json"], capture=True))["items"]}
    if existing & RUNTIME_SECRETS and not RUNTIME_SECRETS <= existing:
        raise ValueError("Partially initialized runtime secrets: stop rather than rotate DB passwords")
    if not existing & RUNTIME_SECRETS:
        apply(runtime_secrets())
    # Reuse only existing dedicated ES validation image; never publish it.
    es_image = args.elasticsearch_image
    if not es_image.startswith("govbiz-elasticsearch:msa-"):
        raise ValueError("Use a dedicated govbiz-elasticsearch:msa-* image")
    run(["docker", "image", "inspect", es_image, "--format", "{{.Id}}"], capture=True)
    with tempfile.TemporaryDirectory(prefix="govbiz-portfolio-data-") as directory:
        archive = Path(directory) / "elasticsearch.tar"
        run(["docker", "image", "save", "--platform", "linux/amd64", "-o", archive, es_image])
        run([args.kind, "load", "image-archive", archive, "--name", CLUSTER])
    data = run([args.helm, "template", "portfolio-data", ROOT / "charts/govbiz-local-data", "-n", NAMESPACE,
                "--set", "allowDisposableData=true", "--set-string", "stores.elasticsearch.image=" + es_image], capture=True)
    run(kube + ["apply", "--server-side", "-f", "-"], data=data)
    for name in ("core-mysql", "catalog-mysql", "ops-mysql", "redis", "qdrant", "elasticsearch"):
        run(nk + ["rollout", "status", "statefulset/" + name, "--timeout=450s"])
    with urlopen(ARGO_INSTALL, timeout=60) as response:
        payload = response.read()
    if hashlib.sha256(payload).hexdigest() != ARGO_INSTALL_SHA256:
        raise ValueError("Pinned Argo CD Core manifest checksum mismatch")
    run(ak + ["apply", "--server-side", "-f", "-"], data=payload.decode())
    run(ak + ["patch", "configmap", "argocd-cm", "--type=merge", "-p", json.dumps({"data": {
        "application.resourceTrackingMethod": "annotation", "application.instanceLabelKey": "argocd.argoproj.io/instance",
        "timeout.reconciliation": "120s", "timeout.reconciliation.jitter": "30s"}})])
    workloads = json.loads(run(ak + ["get", "deployments,statefulsets", "-o", "json"], capture=True))["items"]
    for item in workloads:
        run(ak + ["rollout", "status", item["kind"].lower() + "/" + item["metadata"]["name"], "--timeout=450s"])
    print("Prepared dedicated cluster, private pull authentication, isolated data and Argo CD Core.")
    print("Applications not activated. Commit/push verified config, then run activate.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "activate", "status"))
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--kind", default="kind")
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--elasticsearch-image", default="govbiz-elasticsearch:msa-20260920-001")
    args = parser.parse_args()
    parser.error(
        "Persistent portfolio bootstrap is not configured for the unified repository. "
        "No token was read and no cluster was changed. Use scripts/smoke_msa.py for "
        "local-image validation; see docs/portfolio-gitops.md for the pending fork setup."
    )
    state = args.state_dir.resolve()
    if state == Path.home() or state == Path("/"):
        parser.error("Use a dedicated state directory")
    if args.action == "prepare":
        if not args.token_file and not sys.stdin.isatty():
            parser.error("Non-interactive prepare requires a 0600 read-only token file")
        prepare(args, state)
        return
    kube, nk, ak = commands(state)
    verify_context(kube)
    if args.action == "activate":
        if errors(helm=args.helm):
            raise ValueError("Portfolio configuration policy failed")
        head = run(["git", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], capture=True).strip()
        remote = run(["git", "-C", REPOSITORY_ROOT, "ls-remote", REPOSITORY_URL, "refs/heads/" + REPOSITORY_BRANCH], capture=True).split()[0]
        dirty = run(["git", "-C", REPOSITORY_ROOT, "status", "--porcelain"], capture=True).strip()
        if head != remote or dirty:
            raise ValueError("Activate only a clean checkout pushed to the configured repository branch")
        run(ak + ["apply", "-f", ROOT / "argocd/portfolio/project.yaml"])
        run(ak + ["apply", "-f", ROOT / "argocd/portfolio/applications.yaml"])
    run(ak + ["get", "applications"])
    run(nk + ["get", "pods"])


if __name__ == "__main__":
    main()
