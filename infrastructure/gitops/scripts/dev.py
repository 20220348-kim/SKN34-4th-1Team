"""Rebuild changed local sources into this fork's kind cluster; never publish images."""

import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from fork_cluster import REPOSITORY_ROOT, STATE, commands, load_settings, locked, require_dev, run

INPUTS = {
    "core-service": ("gradlew", "gradle", "build.gradle", "settings.gradle", "src"),
    "catalog-service": ("gradlew", "gradle", "build.gradle", "settings.gradle", "src"),
    "ai-service": ("pyproject.toml", "uv.lock", "app", "document-tools"),
    "ops-service": ("pyproject.toml", "uv.lock", "manage.py", "config", "apps"),
}
EXCLUDED_PARTS = {".git", ".local", ".gradle", ".kotlin", ".venv", "venv", "node_modules",
                  "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "build", "dist",
                  "out", "coverage", ".idea", ".vscode"}


def regular_file(path, boundary):
    """Do not follow a symlink in either the file or any containing directory."""
    path.relative_to(boundary)
    for part in (path, *path.parents):
        if part == boundary:
            break
        if part.is_symlink():
            raise ValueError("Symlink build input is not allowed: " + str(path))
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("Build input is not a regular file: " + str(path))


def pattern_matches(pattern, path):
    """Match slash-separated Docker ignore globs, including ** and parent folders."""
    parts = pattern.strip("/").split("/")

    def match(pattern_parts, path_parts):
        if not pattern_parts:
            return not path_parts
        if pattern_parts[0] == "**":
            return match(pattern_parts[1:], path_parts) or bool(path_parts) and match(pattern_parts, path_parts[1:])
        return bool(path_parts) and fnmatch.fnmatchcase(path_parts[0], pattern_parts[0]) and match(pattern_parts[1:], path_parts[1:])

    names = path.split("/")
    return any(match(parts, names[:length]) for length in range(1, len(names) + 1))


def included(path, ignore_text):
    parts = Path(path).parts
    if any(p in EXCLUDED_PARTS or p == ".env" or p.startswith(".env.") for p in parts):
        return False
    if parts[-1].lower().endswith((".pem", ".key", ".p12", ".pfx", ".log", ".pyc", ".class")):
        return False
    ignored = False
    for line in ignore_text.splitlines():
        pattern = line.strip()
        if not pattern or pattern.startswith("#") or pattern == ".":
            continue
        if "\\" in pattern or pattern.startswith("/") or ".." in pattern.split("/"):
            raise ValueError("Unsupported .dockerignore pattern; use relative /-separated patterns")
        negate = pattern.startswith("!")
        if pattern_matches(pattern[1:] if negate else pattern, path):
            ignored = not negate
    return not ignored


def check_dockerfile(text, roots):
    """Fail closed if a Dockerfile starts copying inputs outside our watched roots."""
    logical = re.sub(r"\\\r?\n[ \t]*", " ", text)
    for line in logical.splitlines():
        words = shlex.split(line, comments=True)
        if not words or words[0].upper() not in {"COPY", "ADD"}:
            continue
        if any(word.startswith("--from=") for word in words[1:]):
            continue
        fields = [word for word in words[1:] if not word.startswith("--")]
        if len(fields) < 2:
            raise ValueError("Unsupported Dockerfile COPY/ADD syntax")
        for source in fields[:-1]:
            if words[0].upper() == "ADD" and source.startswith("https://"):
                continue
            if source.startswith("/") or ".." in source.split("/") or not any(source == root or source.startswith(root + "/") for root in roots):
                raise ValueError("Dockerfile input is outside the watched allowlist: " + source)


def source_files(root, service):
    if service not in INPUTS:
        raise ValueError("Unknown service")
    context = root / "backend" / service
    if context.is_symlink() or context.parent.is_symlink():
        raise ValueError("Symlink source directory is not allowed")
    for name in ("Dockerfile", ".dockerignore"):
        regular_file(context / name, root)
    if (context / "Dockerfile.dockerignore").exists():
        raise ValueError("Dockerfile-specific ignore files are not supported; use .dockerignore")
    check_dockerfile((context / "Dockerfile").read_text(), INPUTS[service])
    ignore_text = (context / ".dockerignore").read_text()
    listed = run(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
                  str(context.relative_to(root))], capture=True)
    selected = {"Dockerfile", ".dockerignore"}
    for item in listed.split("\0"):
        if not item:
            continue
        candidate = root / item
        relative = candidate.relative_to(context).as_posix()
        if not any(relative == source or relative.startswith(source + "/") for source in INPUTS[service]):
            continue
        if not included(relative, ignore_text):
            continue
        # Deletions of tracked files change the fingerprint; never resurrect Git contents.
        if not candidate.exists() and not candidate.is_symlink():
            continue
        regular_file(candidate, root)
        selected.add(relative)
    return context, sorted(selected)


def snapshot(root, service, destination=None):
    """Hash file contents and executable bits, optionally copying the exact build snapshot."""
    context, names = source_files(root, service)
    digest = hashlib.sha256()
    for name in names:
        source = context / name
        regular_file(source, root)
        content = source.read_bytes()
        mode = 0o755 if source.stat().st_mode & 0o111 else 0o644
        digest.update(name.encode() + b"\0" + str(mode).encode() + b"\0")
        digest.update(len(content).to_bytes(8, "big") + content)
        if destination is not None:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(mode)
    return digest.hexdigest()


def read_ledger(state, settings):
    path = state / "dev-images.json"
    if not path.exists():
        return {"schemaVersion": 1, "repository": settings["repository"], "cluster": settings["cluster"], "images": {}}
    regular_file(path, state)
    result = json.loads(path.read_text())
    if (result.get("schemaVersion") != 1 or result.get("repository") != settings["repository"] or
            result.get("cluster") != settings["cluster"] or not isinstance(result.get("images"), dict) or
            not set(result["images"]) <= set(INPUTS)):
        raise ValueError("Development image ledger belongs to a different fork or is invalid")
    for value in result["images"].values():
        if not isinstance(value, dict) or any(not isinstance(value.get(k), str) or not value[k] for k in ("image", "fingerprint", "previousImage")):
            raise ValueError("Invalid development image ledger entry")
    return result


def write_ledger(state, ledger):
    with tempfile.NamedTemporaryFile(mode="w", prefix="dev-images-", dir=state, delete=False) as file:
        os.chmod(file.name, 0o600)
        json.dump(ledger, file, indent=2)
        temporary = Path(file.name)
    os.replace(temporary, state / "dev-images.json")


def deployment(nk, service):
    resource = json.loads(run(nk + ["get", "deployment", service, "-o", "json"], capture=True))
    metadata = resource.get("metadata", {})
    for field in ("annotations", "labels"):
        if any(key.startswith("argocd.argoproj.io/") for key in metadata.get(field, {})):
            raise ValueError("Argo CD tracks this Deployment; switch to dev mode before changing it")
    containers = resource["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1 or containers[0]["name"] != service:
        raise ValueError("Unexpected deployment container; refusing image update")
    if containers[0].get("imagePullPolicy") not in {"IfNotPresent", "Never"}:
        raise ValueError("Local development requires imagePullPolicy IfNotPresent or Never")
    return containers[0]["image"]


def set_image(nk, service, image):
    run(nk + ["set", "image", "deployment/" + service, service + "=" + image])


def rollout(nk, service):
    run(nk + ["rollout", "status", "deployment/" + service, "--timeout=600s"], timeout=650)


def restore(state, settings, services):
    require_dev(state, settings)
    _, nk, _ = commands(state, settings)
    ledger = read_ledger(state, settings)
    for service in services:
        entry = ledger["images"].get(service)
        if entry is None:
            continue
        current = deployment(nk, service)
        if current not in {entry["image"], entry["previousImage"]}:
            raise ValueError("Deployment changed outside this watcher; inspect before restoring " + service)
        set_image(nk, service, entry["previousImage"])
        rollout(nk, service)
        del ledger["images"][service]
        write_ledger(state, ledger)
        print("Restored original image: " + service, flush=True)
    if not ledger["images"] and (state / "dev-images.json").exists():
        (state / "dev-images.json").unlink()


def sync_service(root, state, settings, service, expected=None, kind="kind"):
    require_dev(state, settings)
    _, nk, _ = commands(state, settings)
    previous = deployment(nk, service)
    ledger = read_ledger(state, settings)
    entry = ledger["images"].get(service)
    fingerprint = expected or snapshot(root, service)
    if entry and entry["fingerprint"] == fingerprint and entry["image"] == previous:
        return False
    if entry and previous not in {entry["image"], entry["previousImage"]}:
        raise ValueError("Deployment changed outside this watcher; inspect before updating " + service)
    image = settings["cluster"] + "/" + service + ":dev-" + uuid.uuid4().hex
    existing = run(["docker", "image", "ls", "--quiet", "--filter", "reference=" + image], capture=True)
    if existing.strip():
        raise ValueError("Generated image tag already exists; refusing overwrite")
    print("Building local " + service + " (no image upload)", flush=True)
    with tempfile.TemporaryDirectory(prefix="govbiz-dev-context-") as directory:
        context = Path(directory)
        fingerprint = snapshot(root, service, context)
        run(["docker", "build", "--platform", settings["platform"], "--tag", image,
             "--label", "dev.govbiz.repository=" + settings["repository"],
             "--label", "dev.govbiz.fingerprint=" + fingerprint, context], timeout=3600)
    run([kind, "load", "docker-image", image, "--name", settings["cluster"]], timeout=600)
    # Building can take minutes. Recheck mode, cluster ownership and the live image.
    latest = load_settings(state)
    if latest != settings:
        raise ValueError("Fork settings changed during build; no Deployment was modified")
    require_dev(state, settings)
    if deployment(nk, service) != previous:
        raise ValueError("Deployment changed during build; no Deployment was modified")
    # Record recovery information before the mutation, including on interruption.
    original = entry["previousImage"] if entry else previous
    ledger["images"][service] = {"image": image, "fingerprint": fingerprint, "previousImage": original}
    write_ledger(state, ledger)
    try:
        set_image(nk, service, image)
        rollout(nk, service)
    except (subprocess.SubprocessError, OSError, KeyboardInterrupt):
        # Roll back only our own current image, never a concurrently replaced one.
        if deployment(nk, service) == image:
            print("Rollout failed; restoring the previous image for " + service, file=sys.stderr, flush=True)
            set_image(nk, service, previous)
            rollout(nk, service)
            if entry:
                ledger["images"][service] = entry
            else:
                del ledger["images"][service]
            write_ledger(state, ledger)
        raise
    print("Updated only this PC: " + service, flush=True)
    return True


def watch(root, state, settings, services, interval=2.0, kind="kind"):
    failed = {}
    while True:
        for service in services:
            fingerprint = snapshot(root, service)
            if failed.get(service) == fingerprint:
                continue
            try:
                sync_service(root, state, settings, service, fingerprint, kind)
                failed.pop(service, None)
            except (subprocess.SubprocessError, OSError) as error:
                failed[service] = fingerprint
                print(f"{service}: {type(error).__name__}. Not retrying unchanged source; save another change or restart to retry.",
                      file=sys.stderr, flush=True)
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--once", action="store_true", help="Build/update selected current sources once")
    action.add_argument("--watch", action="store_true", help="Build initially, then rebuild only changed services")
    action.add_argument("--restore", action="store_true", help="Restore images present before local development")
    parser.add_argument("--service", choices=("all", *INPUTS), default="all")
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--kind", default="kind")
    args = parser.parse_args()
    if args.interval < 0.5:
        parser.error("Polling interval must be at least 0.5 seconds")
    if sys.platform == "win32":
        parser.error("Run inside Windows WSL2 with Linux Docker integration, not native PowerShell/Python")
    # Preserve symlink information for load_settings' ownership/path checks.
    state = args.state_dir.absolute()
    try:
        settings = load_settings(state)
        require_dev(state, settings)
        platform = run(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], capture=True).strip()
        if platform != settings["platform"] or platform != "linux/amd64":
            raise ValueError("This image/toolchain path is verified only for linux/amd64 Docker; ARM emulation is not silently enabled")
        services = tuple(INPUTS) if args.service == "all" else (args.service,)
        with locked(state):
            if args.restore:
                restore(state, settings, services)
            elif args.watch:
                watch(REPOSITORY_ROOT, state, settings, services, args.interval, args.kind)
            else:
                for service in services:
                    sync_service(REPOSITORY_ROOT, state, settings, service, kind=args.kind)
    except KeyboardInterrupt:
        print("Stopped watching. Local services keep running; use --restore before returning to GitOps.")
        return 130
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Never print command input, runtime secrets or a complete subprocess repr.
        print(str(error) if isinstance(error, ValueError) else type(error).__name__ + ": development command failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
