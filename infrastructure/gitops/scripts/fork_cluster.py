"""Per-fork kind development/GitOps bootstrap (Intel Mac or x64 Windows WSL2).

No default kube context, credential files, shared registry or existing cluster is
adopted. Init/doctor are read-only outside the ignored local state directory.
"""
import argparse
from contextlib import contextmanager
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlencode
from urllib.error import URLError
from urllib.request import Request, urlopen
import uuid

import yaml

from check_msa import ROOT, REPOSITORY_ROOT, SERVICES, NAMESPACE, CHART_PATH, policy_errors
from check_portfolio import free_runtime_errors
from gitops_msa import ARGO_INSTALL, ARGO_INSTALL_SHA256
from portfolio_cluster import RUNTIME_SECRETS, read_token, pull_secret, runtime_secrets, run

sys.path.insert(0, str(REPOSITORY_ROOT / "infrastructure/release"))
from repository import Fork, from_origin  # noqa: E402

STATE = ROOT / ".local/fork"


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".settings-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def initial_settings(fork):
    return {"schemaVersion": 1, "repository": fork.repository, "branch": fork.branch,
            "cluster": "govbiz-" + hashlib.sha256(fork.repository.lower().encode()).hexdigest()[:10],
            "namespace": NAMESPACE, "mode": "dev", "platform": "linux/amd64", "stateId": uuid.uuid4().hex}


def load_settings(state=STATE):
    state = Path(state)
    if state.is_symlink() or (state / "settings.json").is_symlink():
        raise ValueError("Local state must not be a symlink")
    data = json.loads((state / "settings.json").read_text())
    fork = Fork(data["repository"], data["branch"])
    expected = initial_settings(fork)
    if (data.get("schemaVersion") != 1 or data.get("mode") not in ("dev", "gitops")
            or any(data.get(key) != expected[key] for key in ("cluster", "namespace", "platform"))
            or not re.fullmatch(r"[a-f0-9]{32}", data.get("stateId", ""))):
        raise ValueError("Invalid dedicated fork state; do not edit cluster identity manually")
    actual = from_origin(REPOSITORY_ROOT, branch=fork.branch)
    if actual.repository.lower() != fork.repository.lower():
        raise ValueError("origin changed: use a separate state directory; existing cluster is not adopted")
    return data


def commands(state, settings):
    config = Path(state) / "kubeconfig"
    if config.is_symlink():
        raise ValueError("Dedicated kubeconfig must not be a symlink")
    kube = ["kubectl", "--kubeconfig", config, "--context", "kind-" + settings["cluster"]]
    return kube, kube + ["-n", NAMESPACE], kube + ["-n", "argocd"]


def verify_context(kube, settings, *, owner=True):
    config = json.loads(run(kube + ["config", "view", "--minify", "-o", "json"], capture=True))
    server = config["clusters"][0]["cluster"]["server"]
    if not re.fullmatch(r"https://127\.0\.0\.1:[0-9]+", server):
        raise ValueError("Only a dedicated loopback kind cluster is allowed")
    nodes = json.loads(run(kube + ["get", "nodes", "-o", "json"], capture=True))["items"]
    if [item["metadata"]["name"] for item in nodes] != [settings["cluster"] + "-control-plane"]:
        raise ValueError("Unexpected cluster nodes: refusing credentials and mutations")
    if owner:
        marker = json.loads(run(kube + ["-n", "kube-system", "get", "configmap", "govbiz-owner", "-o", "json"], capture=True))
        if marker.get("data") != {"repository": settings["repository"], "stateId": settings["stateId"]}:
            raise ValueError("Cluster ownership marker does not match this checkout's initialized state")


def applications(kube, ak):
    crd = run(kube + ["get", "crd", "applications.argoproj.io", "--ignore-not-found", "-o", "name"], capture=True).strip()
    return json.loads(run(ak + ["get", "applications", "-o", "json"], capture=True))["items"] if crd else []


def require_dev(state, settings):
    if settings["mode"] != "dev":
        raise ValueError("GitOps owns the services; run fork_cluster.py dev before local development")
    kube, _, ak = commands(state, settings)
    verify_context(kube, settings)
    if applications(kube, ak):
        raise ValueError("Argo Applications still exist: refusing local changes that self-heal could undo")


def verify_token(token, fork):
    if not token or len(token) > 512 or any(c.isspace() for c in token):
        raise ValueError("Malformed GHCR token")
    request = Request("https://api.github.com/user", headers={"Authorization": "Bearer " + token,
                                                           "Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=30) as response:
        scopes = {s.strip() for s in response.headers.get("X-OAuth-Scopes", "").split(",") if s.strip()}
        login = json.load(response).get("login", "")
    if scopes != {"read:packages"} or login.lower() != fork.owner.lower():
        raise ValueError("Use this personal fork owner's classic token with only read:packages")
    return login


def verify_pull_rights(login, token, record):
    """HEAD each immutable manifest; public mode requests an anonymous scoped bearer."""
    if (login is None) != (token is None):
        raise ValueError("Both private credentials or neither must be supplied")
    for image in record["images"].values():
        repository, digest = image.removeprefix("ghcr.io/").split("@")
        headers = {}
        if token is not None:
            authorization = base64.b64encode((login + ":" + token).encode()).decode()
            headers["Authorization"] = "Basic " + authorization
        request = Request("https://ghcr.io/token?" + urlencode({"service": "ghcr.io", "scope": "repository:" + repository + ":pull"}),
                          headers=headers)
        with urlopen(request, timeout=30) as response:
            bearer = json.load(response)["token"]
        request = Request("https://ghcr.io/v2/" + repository + "/manifests/" + digest, method="HEAD",
                          headers={"Authorization": "Bearer " + bearer, "Accept":
                                   "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
        with urlopen(request, timeout=30) as response:
            if response.headers.get("Docker-Content-Digest") != digest:
                raise ValueError("Registry returned a different digest; do not use unverified images")


def checked_release(settings, helm="helm"):
    from check_portfolio import fork_errors
    fork = Fork(settings["repository"], settings["branch"])
    problems = fork_errors(fork, helm=helm)
    if problems:
        raise ValueError("\n".join(problems))
    return json.loads((ROOT / "environments/fork/release.json").read_text())


def authenticate(args, settings, record):
    if record.get("visibility", "private") == "public":
        raise ValueError("Public images do not require a PAT; use the anonymous pull check")
    if not args.token_file and not sys.stdin.isatty():
        raise ValueError("Use --token-file with your 0600 file, or run interactively for a hidden prompt")
    token = read_token(args.token_file) if args.token_file else getpass.getpass("GHCR read:packages token (hidden): ").strip()
    login = verify_token(token, Fork(settings["repository"], settings["branch"]))
    verify_pull_rights(login, token, record)
    return pull_secret(login, token)


def apply(kube, resources):
    # Never use client-side last-applied annotations for secrets or write them to disk.
    run(kube + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"], data=yaml.safe_dump_all(resources))


def doctor(args, settings):
    if platform.system() == "Windows":
        raise ValueError("Use Ubuntu on Windows WSL2 with Docker Desktop Linux integration, not native Windows Python")
    if platform.system() not in ("Darwin", "Linux"):
        raise ValueError("Supported hosts: Intel Mac or x64 Linux/WSL2")
    for executable in ("docker", "kubectl", args.kind, args.helm):
        if not shutil.which(executable):
            raise ValueError("Missing tool: " + executable)
    docker_platform = run(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], capture=True).strip()
    if docker_platform != settings["platform"]:
        raise ValueError("Current published/tested images require Docker linux/amd64; ARM emulation is not silently enabled")
    if "v0.33.0" not in run([args.kind, "version"], capture=True):
        raise ValueError("Use kind v0.33.0 (pinned node image in kind/local.yaml)")
    print("PASS: tools and Docker linux/amd64; registry authentication and Windows runtime still need actual verification")


def local_images(path):
    manifest = json.loads(Path(path).read_text())
    if "images" in manifest:
        names = set(SERVICES) | {"elasticsearch"}
        images = {name: manifest["images"][name] for name in names}
        for name, image in images.items():
            if "imageIds" not in manifest:
                raise ValueError("Build manifests must include imageIds")
            observed = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True).strip()
            if observed != manifest["imageIds"][name]:
                raise ValueError("Local image ID changed since the manifest was built")
    else:
        images = manifest
    if set(images) != set(SERVICES) | {"elasticsearch"}:
        raise ValueError("--local-images must contain exactly four service images and elasticsearch")
    for service, image in images.items():
        if not re.fullmatch(r"govbiz-" + re.escape(service) + r":[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", image) or image.endswith(":latest"):
            raise ValueError("Local-only validation requires distinct govbiz-<service>:<tag> images, not registries or latest")
    return images


def node_image_id(settings, image):
    command = ["docker", "exec", settings["cluster"] + "-control-plane", "crictl", "inspecti", image]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode == 1 and any(text in result.stderr.lower() for text in ("not found", "no such image")):
        return None
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, command)
    identity = json.loads(result.stdout).get("status", {}).get("id", "")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
        raise ValueError("Unexpected kind image identity; refusing to treat the tag as a cache hit")
    return identity


def load_image(args, settings, image, state=None):
    identity = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True).strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
        raise ValueError("Unexpected local Docker image identity")
    ledger = {"schemaVersion": 1, "repository": settings["repository"], "cluster": settings["cluster"],
              "stateId": settings["stateId"], "images": {}}
    path = Path(state) / "loaded-images.json" if state else None
    if path and (path.exists() or path.is_symlink()):
        if path.is_symlink() or not path.is_file():
            raise ValueError("Image cache ledger must be a regular non-symlink file")
        stored = json.loads(path.read_text())
        if (any(stored.get(key) != ledger[key] for key in ("schemaVersion", "repository", "cluster", "stateId"))
                or not isinstance(stored.get("images"), dict)):
            raise ValueError("Image cache ledger does not belong to this initialized fork cluster")
        ledger = stored
    existing = node_image_id(settings, image)
    # Docker may identify an OCI index/manifest while CRI identifies its config.
    # Compare each side only with its own previously recorded successful import.
    cached = ledger["images"].get(image, {})
    if existing and cached == {"dockerId": identity, "criId": existing}:
        print("Reusing exact local image in kind: " + image, flush=True)
        return
    print("Loading local image into kind: " + image, flush=True)
    with tempfile.TemporaryDirectory(prefix="govbiz-fork-image-") as directory:
        archive = Path(directory) / "image.tar"
        run(["docker", "image", "save", "--platform", settings["platform"], "-o", archive, image])
        run([args.kind, "load", "image-archive", archive, "--name", settings["cluster"]])
    imported = node_image_id(settings, image)
    if imported is None:
        raise ValueError("kind image is missing after loading the local archive")
    after = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True).strip()
    if after != identity:
        raise ValueError("Local Docker image changed during import; its cache entry was not recorded")
    if path:
        ledger["images"][image] = {"dockerId": identity, "criId": imported}
        write_json(path, ledger)


def render_services(helm, images=None, root=ROOT, overlay=None):
    """Preflight every free-runtime contract and exact Helm command before writes."""
    rendered = {}
    for service in SERVICES:
        values = root / (f"environments/portfolio/{service}.yaml" if images else f"environments/fork/{service}.yaml")
        safety = free_runtime_errors(service, yaml.safe_load(values.read_text()))
        if safety:
            raise ValueError("\n".join(safety))
        extra = []
        if images:
            repository, tag = images[service].split(":")
            extra = ["--set", "localMode=true", "--set-json", "imagePullSecrets=[]", "--set-string", "image.repository=" + repository,
                     "--set-string", "image.tag=" + tag, "--set-string", "image.digest=", "--set-string", "image.pullPolicy=Never"]
        override = (overlay or {}).get(service)
        output = run([helm, "template", service, root / "charts/govbiz-service", "-n", NAMESPACE, "-f", values, *extra,
                      *(["-f", "-"] if override else [])],
                     **({"data": yaml.safe_dump(override)} if override else {}), capture=True)
        problems = policy_errors(service, list(yaml.safe_load_all(output)))
        if problems:
            raise ValueError("\n".join(problems))
        rendered[service] = output
    return rendered


def elasticsearch_image(args, settings, images, state=None):
    if images:
        image = images["elasticsearch"]
    else:
        context = REPOSITORY_ROOT / "infrastructure/elasticsearch"
        source = hashlib.sha256(b"".join(p.read_bytes() for p in sorted(context.rglob("*")) if p.is_file())).hexdigest()[:16]
        image = "govbiz-elasticsearch:fork-" + source
        result = subprocess.run(["docker", "image", "inspect", image], capture_output=True, text=True, timeout=30)
        if result.returncode:
            run(["docker", "build", "--platform", settings["platform"], "-t", image, context], timeout=1800)
    load_image(args, settings, image, state)
    return image


@contextmanager
def locked(state):
    """One exclusive file lock shared by bootstrap actions and the dev watcher.

    Never infer that a PID is stale or take over its lock. Keep the descriptor
    open and remove only our own inode, including when an operation fails.
    """
    path = Path(state) / "dev.lock"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise ValueError("Another development or bootstrap command may be running. Inspect, do not automatically delete: " + str(path)) from error
    with os.fdopen(fd, "w") as stream:
        stream.write(str(os.getpid()) + "\n")
        stream.flush()
        identity = os.fstat(stream.fileno())
        try:
            yield
        finally:
            try:
                current = path.lstat()
            except FileNotFoundError:
                raise ValueError("Local operation lock disappeared; inspect state before starting another command") from None
            if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
                raise ValueError("Local operation lock was replaced; its replacement was not removed")
            path.unlink()


def up(args, state, settings):
    with locked(state):
        _up(args, state, settings)


def _up(args, state, settings):
    if (state / "dev-images.json").exists():
        raise ValueError("Local development images exist; dev.py --restore must finish before up changes the baseline")
    if settings["mode"] != "dev":
        raise ValueError("up is development initialization only; GitOps mode must use status/dev")
    doctor(args, settings)
    images = local_images(args.local_images) if args.local_images else None
    record = None if images else checked_release(settings, args.helm)
    from connected_runtime import load_profile, overrides
    rendered_services = render_services(args.helm, images, overlay=overrides(load_profile(state, settings)))
    print("PASS: four service Helm manifests and free-runtime policy preflight", flush=True)
    kube, nk, _ = commands(state, settings)
    clusters = run([args.kind, "get", "clusters"], capture=True).splitlines()
    if settings["cluster"] in clusters:
        if not (state / "kubeconfig").is_file():
            raise ValueError("Named cluster already exists without this state kubeconfig; refusing adoption")
        require_dev(state, settings)
    elif (state / "kubeconfig").exists():
        raise ValueError("Stale kubeconfig: inspect it manually before creating a replacement cluster")
    credential = None
    if not images:
        if record.get("visibility", "private") == "public":
            if args.token_file:
                raise ValueError("Public images do not require --token-file")
            verify_pull_rights(None, None, record)
        else:
            secret_exists = settings["cluster"] in clusters and bool(run(nk + ["get", "secret", "ghcr-pull", "--ignore-not-found", "-o", "name"], capture=True).strip())
            if args.token_file or not secret_exists:
                credential = authenticate(args, settings, record)
    if settings["cluster"] not in clusters:
        run([args.kind, "create", "cluster", "--name", settings["cluster"], "--config", ROOT / "kind/local.yaml",
             "--kubeconfig", state / "kubeconfig", "--wait", "180s"], timeout=300)
        os.chmod(state / "kubeconfig", 0o600)
        verify_context(kube, settings, owner=False)
        apply(kube, [{"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "govbiz-owner", "namespace": "kube-system"},
                      "data": {"repository": settings["repository"], "stateId": settings["stateId"]}}])
    verify_context(kube, settings)
    run(["docker", "update", "--restart=unless-stopped", settings["cluster"] + "-control-plane"], capture=True)
    apply(kube, [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": NAMESPACE}}])
    if credential:
        apply(kube, [credential])
    existing = set(run(nk + ["get", "secrets", "-o", "custom-columns=:metadata.name", "--no-headers"], capture=True).split())
    if existing & RUNTIME_SECRETS and not RUNTIME_SECRETS <= existing:
        raise ValueError("Partial runtime secrets: refusing to rotate existing database passwords")
    if not existing & RUNTIME_SECRETS:
        apply(kube, runtime_secrets())
    es_image = elasticsearch_image(args, settings, images, state)
    data = run([args.helm, "template", "fork-data", ROOT / "charts/govbiz-local-data", "-n", NAMESPACE,
                "--set", "allowDisposableData=true", "--set-string", "stores.elasticsearch.image=" + es_image], capture=True)
    run(kube + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"], data=data)
    for name in ("core-mysql", "catalog-mysql", "ops-mysql", "redis", "qdrant", "elasticsearch"):
        run(nk + ["rollout", "status", "statefulset/" + name, "--timeout=450s"])
    for service in SERVICES:
        if images:
            load_image(args, settings, images[service], state)
        run(kube + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"], data=rendered_services[service])
    for service in SERVICES:
        run(nk + ["rollout", "status", "deployment/" + service, "--timeout=600s"])
    write_json(state / "baseline.json", {"source": "local" if images else "ghcr", "images": images or record["images"]})
    print("Ready: isolated development services; Argo CD does not own these workloads.")
    if images:
        print("LOCAL IMAGE VALIDATION ONLY: private GHCR authentication/pull was not tested.")


def argo_resources(settings, profile=None):
    fork = Fork(settings["repository"], settings["branch"])
    destination = {"server": "https://kubernetes.default.svc", "namespace": NAMESPACE}
    project = {"apiVersion": "argoproj.io/v1alpha1", "kind": "AppProject", "metadata": {"name": "govbiz-fork", "namespace": "argocd"},
               "spec": {"sourceRepos": [fork.url], "destinations": [destination], "clusterResourceWhitelist": [],
                        "namespaceResourceWhitelist": [{"group": "apps", "kind": "Deployment"}, {"group": "", "kind": "Service"}]}}
    apps = [{"apiVersion": "argoproj.io/v1alpha1", "kind": "Application", "metadata": {"name": "govbiz-fork-" + service, "namespace": "argocd"},
             "spec": {"project": "govbiz-fork", "source": {"repoURL": fork.url, "targetRevision": fork.branch,
                      "path": CHART_PATH, "helm": {"releaseName": service, "valueFiles": [f"../../environments/fork/{service}.yaml"]}},
                      "destination": destination, "syncPolicy": {"automated": {"enabled": True, "prune": False, "selfHeal": True},
                      "syncOptions": ["FailOnSharedResource=true"], "retry": {"limit": 5, "backoff": {"duration": "10s", "factor": 2, "maxDuration": "3m"}}}}}
            for service in SERVICES]
    if profile:
        from connected_runtime import overrides
        for app in apps:
            service = app["metadata"]["name"].removeprefix("govbiz-fork-")
            value = overrides(profile).get(service)
            if value:
                app["spec"]["source"]["helm"]["valuesObject"] = value
    return [project, *apps]


def gitops(args, state, settings):
    with locked(state):
        _gitops(args, state, settings)


def _gitops(args, state, settings):
    if (state / "dev-images.json").exists():
        raise ValueError("Local development images exist; restore them explicitly with dev.py --restore first")
    record = checked_release(settings, args.helm)
    fork = Fork(settings["repository"], settings["branch"])
    head = run(["git", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], capture=True).strip()
    remote = run(["git", "-C", REPOSITORY_ROOT, "ls-remote", fork.url, "refs/heads/" + fork.branch], capture=True).split()
    if not remote or head != remote[0] or run(["git", "-C", REPOSITORY_ROOT, "status", "--porcelain"], capture=True).strip():
        raise ValueError("GitOps requires a clean checkout pushed to this fork branch; commit/push is never automatic")
    kube, nk, ak = commands(state, settings)
    verify_context(kube, settings)
    if record.get("visibility", "private") == "public":
        verify_pull_rights(None, None, record)
    elif not run(nk + ["get", "secret", "ghcr-pull", "--ignore-not-found", "-o", "name"], capture=True).strip():
        raise ValueError("Private GHCR read credentials are missing; run credentials first")
    existing = applications(kube, ak)
    if any(a["metadata"]["name"] not in {"govbiz-fork-" + s for s in SERVICES} for a in existing):
        raise ValueError("Unexpected Argo Application: refusing to widen ownership")
    apply(kube, [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "argocd"}}])
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
    from connected_runtime import load_profile
    apply(ak, argo_resources(settings, load_profile(state, settings)))
    settings["mode"] = "gitops"
    write_json(state / "settings.json", settings)
    print("GitOps enabled for this fork only. Inspect status until all four Applications are Synced/Healthy.")


def development(state, settings):
    with locked(state):
        _development(state, settings)


def _development(state, settings):
    kube, nk, ak = commands(state, settings)
    verify_context(kube, settings)
    apps = applications(kube, ak)
    expected = {"govbiz-fork-" + s for s in SERVICES}
    if any(a["metadata"]["name"] not in expected or a["metadata"].get("finalizers") for a in apps):
        raise ValueError("Unexpected/finalized Applications: refusing automatic ownership changes")
    for app in apps:
        name = app["metadata"]["name"]
        run(ak + ["patch", "application", name, "--type=merge", "-p", '{"spec":{"syncPolicy":{"automated":{"enabled":false}}}}'])
    # Disabling auto-sync does not cancel an already queued/running operation.
    # Keep GitOps ownership until it settles; never race a controller image write.
    settled = applications(kube, ak)
    if any(app.get("operation") is not None or app.get("status", {}).get("operationState", {}).get("phase") in {"Running", "Terminating"}
           for app in settled):
        raise ValueError("Argo synchronization is still queued/running. Wait until it finishes, then run dev again")
    if any(a["metadata"]["name"] not in expected or a["metadata"].get("finalizers") for a in settled):
        raise ValueError("Argo ownership changed while disabling synchronization; inspect it before retrying")
    for app in settled:
        name = app["metadata"]["name"]
        run(ak + ["delete", "application", name, "--cascade=orphan", "--wait=true"])
    patch = json.dumps({"metadata": {"annotations": {"argocd.argoproj.io/tracking-id": None},
                                    "labels": {"argocd.argoproj.io/instance": None}}})
    for service in SERVICES:
        for kind in ("deployment", "service"):
            run(nk + ["patch", kind, service, "--type=merge", "-p", patch])
    settings["mode"] = "dev"
    write_json(state / "settings.json", settings)
    require_dev(state, settings)
    print("Development mode: Argo Applications removed without deleting services or data.")


def credentials(args, state, settings):
    with locked(state):
        kube, _, _ = commands(state, settings)
        verify_context(kube, settings)
        record = checked_release(settings, args.helm)
        if record.get("visibility", "private") == "public":
            verify_pull_rights(None, None, record)
            print("Anonymous GHCR pull verified; no credential was read, stored or deleted.")
            return
        credential = authenticate(args, settings, record)
        apply(kube, [credential])
        print("Read-only authentication installed; token value was not saved to a file or printed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("init", "doctor", "up", "status", "credentials", "gitops", "dev", "web"))
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--branch", help="Explicit tracked branch at init; otherwise current origin branch")
    parser.add_argument("--token-file", type=Path, help="Your read:packages-only classic PAT file, mode0600; never copied")
    parser.add_argument("--local-images", type=Path, help="Explicit local-only smoke/development image JSON; no GHCR claim")
    parser.add_argument("--kind", default="kind")
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    if os.name == "nt":
        parser.error("Run this tool inside Windows WSL2 Ubuntu with Linux Python, not native Windows Python")
    if sys.version_info < (3, 13):
        parser.error("Use Python 3.13 or newer from the documented virtual environment")
    state = args.state_dir.absolute()
    if state in (Path.home(), Path("/"), ROOT, REPOSITORY_ROOT) or state.is_symlink():
        parser.error("Use a dedicated non-symlink local state directory")
    try:
        if args.action == "init":
            if (state / "settings.json").exists():
                load_settings(state)
                print("Already initialized; credentials and cluster were not changed.")
                return
            if state.exists() and any(state.iterdir()):
                raise ValueError("State directory is not empty; refusing to adopt or overwrite it")
            settings = initial_settings(from_origin(REPOSITORY_ROOT, branch=args.branch))
            write_json(state / "settings.json", settings)
            print("Initialized " + settings["repository"] + " (" + settings["branch"] + "), cluster " + settings["cluster"])
            return
        settings = load_settings(state)
        if args.action == "doctor":
            doctor(args, settings)
        elif args.action == "up":
            up(args, state, settings)
        elif args.action == "gitops":
            gitops(args, state, settings)
        elif args.action == "dev":
            development(state, settings)
        elif args.action == "credentials":
            credentials(args, state, settings)
        else:
            kube, nk, ak = commands(state, settings)
            verify_context(kube, settings)
            if args.action == "web":
                run(nk + ["port-forward", "--address", "127.0.0.1", "service/core-service", "18080:8080"], timeout=None)
            else:
                print("Mode: " + settings["mode"] + "; repository: " + settings["repository"])
                run(nk + ["get", "pods"])
                for app in applications(kube, ak):
                    status = app.get("status", {})
                    print(app["metadata"]["name"], status.get("sync", {}).get("status", "Unknown"), status.get("health", {}).get("status", "Unknown"))
    except KeyboardInterrupt:
        print("Stopped local command; services and data were preserved.")
    except URLError:
        parser.exit(1, "Bootstrap stopped: registry/GitHub connection or authentication failed; no token value is logged.\n")
    except (ValueError, FileNotFoundError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, "Bootstrap stopped: " + str(error) + "\n")


if __name__ == "__main__":
    main()
