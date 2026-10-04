"""Package encrypted Ops history and exact images for a teammate's local Compose copy.

No server deployment, cloud upload, source mutation, automatic API startup or model calls.
The key is deliberately excluded from the package and must be delivered separately.
"""

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path

import ops_snapshot as snapshot


def file_digest(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise snapshot.SnapshotError("Package entries must be regular files, not links")
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    return {"sha256": digest, "size": info.st_size}


def image_info(reference):
    image = json.loads(snapshot.run(["docker", "image", "inspect", reference]))[0]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image["Id"]):
        raise snapshot.SnapshotError("Images must have exact sha256 identities")
    return {"id": image["Id"], "platform": image["Os"] + "/" + image["Architecture"]}


def pack(archive, key_file, ops_image, directory):
    key = snapshot.key_bytes(key_file)
    with archive.open("rb") as source:
        raw = source.read(snapshot.MAX_BYTES * 4 + 1)
    payload = snapshot.unseal(raw, key)
    images = {"ops": image_info(ops_image), "mysql": image_info(payload["mysql_image"])}
    # Never replace an existing package or put the recovery key inside it.
    if directory.exists() or directory.is_symlink():
        raise snapshot.SnapshotError("Use a NEW package directory")
    if key_file.resolve().is_relative_to(directory.resolve()):
        raise snapshot.SnapshotError("Keep the recovery key outside the package")
    snapshot.require_local_image(images["ops"]["id"])
    directory.mkdir(mode=0o700)
    snapshot.exclusive(directory / "snapshot.enc", raw)
    snapshot.exclusive(directory / "images.tar", b"")
    snapshot.run(
        [
            "docker",
            "image",
            "save",
            "--output",
            str(directory / "images.tar"),
            *dict.fromkeys(item["id"] for item in images.values()),
        ],
        timeout=600,
    )
    manifest = {
        "version": 1,
        "kind": "govbiz-ops-local-copy",
        "images": images,
        "files": {name: file_digest(directory / name) for name in ("snapshot.enc", "images.tar")},
    }
    # Authenticate the large image archive without reading all image layers into Python memory.
    snapshot.exclusive(directory / "package.enc", snapshot.seal(manifest, key))
    return {"status": "PACKAGED", "images": images, "key_included": False, "model_api_calls": 0}


def verify_package(package, key_file):
    if package.is_symlink() or not package.is_dir():
        raise snapshot.SnapshotError("Select a package directory, not a link")
    file_digest(package / "package.enc")
    with (package / "package.enc").open("rb") as source:
        manifest = snapshot.open_payload(source.read(65537), snapshot.key_bytes(key_file))
    if (
        manifest.get("version") != 1
        or manifest.get("kind") != "govbiz-ops-local-copy"
        or set(manifest.get("files", {})) != {"snapshot.enc", "images.tar"}
        or set(manifest.get("images", {})) != {"ops", "mysql"}
    ):
        raise snapshot.SnapshotError("Unsupported local copy package")
    for name, expected in manifest["files"].items():
        if file_digest(package / name) != expected:
            raise snapshot.SnapshotError("Package integrity check failed; no images or DB loaded")
    for item in manifest["images"].values():
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", item["id"]):
            raise snapshot.SnapshotError("Package must pin exact image identities")
    with (package / "snapshot.enc").open("rb") as source:
        payload = snapshot.unseal(
            source.read(snapshot.MAX_BYTES * 4 + 1), snapshot.key_bytes(key_file)
        )
    if payload["mysql_image"] != manifest["images"]["mysql"]["id"]:
        raise snapshot.SnapshotError("Package database image differs from snapshot")
    return manifest


def restore_local(package, key_file, directory, core_port=8080, ops_port=18002):
    if not 1024 <= core_port <= 65535 or not 1024 <= ops_port <= 65535 or core_port == ops_port:
        raise snapshot.SnapshotError("Use distinct Core/Ops ports between 1024 and 65535")
    manifest = verify_package(package, key_file)
    # Validate everything before docker load. No replacement tags are used by the restored stack.
    snapshot.run(["docker", "image", "load", "--input", str(package / "images.tar")], timeout=600)
    for item in manifest["images"].values():
        if image_info(item["id"]) != item:
            raise snapshot.SnapshotError("Loaded image identity or platform differs from package")
    result = snapshot.restore(
        package / "snapshot.enc",
        key_file,
        directory,
        local_ops_image=manifest["images"]["ops"]["id"],
        core_port=core_port,
        api_port=ops_port,
    )
    return {
        **result,
        "local_copy": True,
        "ops_proxy_target": f"http://127.0.0.1:{ops_port}",
        "core_proxy_target": f"http://127.0.0.1:{core_port}",
        "historical_reviewers_preserved": True,
    }


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser("pack")
    create.add_argument("--archive", required=True, type=Path)
    create.add_argument("--key-file", required=True, type=Path)
    create.add_argument("--ops-image", required=True, help="Built image with account namespaces")
    create.add_argument("--directory", required=True, type=Path)
    restore = actions.add_parser("restore-local")
    restore.add_argument("--package", required=True, type=Path)
    restore.add_argument("--key-file", required=True, type=Path)
    restore.add_argument("--directory", required=True, type=Path)
    restore.add_argument("--core-port", type=int, default=8080)
    restore.add_argument("--ops-port", type=int, default=18002)
    args = vars(parser.parse_args())
    action = args.pop("action")
    try:
        result = pack(**args) if action == "pack" else restore_local(**args)
        print(json.dumps(result, sort_keys=True))
    except snapshot.SnapshotError as error:
        parser.exit(1, f"Local copy {action} failed: {error}\n")
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(
            1, f"Local copy {action} failed ({type(error).__name__}); no automatic overwrite.\n"
        )


if __name__ == "__main__":
    main()
