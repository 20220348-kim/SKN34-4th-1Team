"""Bounded volume payloads; run only in a networkless helper with explicit mounts."""

import base64
import hashlib
import json
import os
import sys
from pathlib import Path, PurePosixPath

from ops_volume_restore_probe import MAX_BYTES, MAX_ENTRIES, check_prefect, tree


def validate(entries):
    if not isinstance(entries, dict) or not entries or len(entries) > MAX_ENTRIES:
        raise ValueError("Invalid volume inventory")
    total = 0
    files = 0
    for name, row in entries.items():
        path = PurePosixPath(name)
        if (
            path.as_posix() != name
            or path.is_absolute()
            or ".." in path.parts
            or "\\" in name
            or "\x00" in name
            or not isinstance(row, dict)
            or row.get("kind") not in {"file", "directory"}
        ):
            raise ValueError("Invalid volume path or entry")
        if (
            any(
                type(row.get(key)) is not int or row[key] < 0
                for key in ("mode", "uid", "gid", "mtime_ns", "size")
            )
            or row["mode"] > 0o777
        ):
            raise ValueError("Invalid volume metadata")
        if row["kind"] == "directory":
            if row.get("data") is not None or row.get("sha256") is not None or row["size"] != 0:
                raise ValueError("Directory cannot contain file data")
        else:
            raw = base64.b64decode(row["data"], validate=True)
            total += len(raw)
            files += 1
            if len(raw) != row["size"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
                raise ValueError("Invalid volume file digest")
        if total > MAX_BYTES:
            raise ValueError("Volume exceeds the supported size")
        for parent in path.parents:
            if entries.get(str(parent), {}).get("kind") != "directory":
                raise ValueError("Missing directory or file used as a directory")
    if entries.get(".", {}).get("kind") != "directory" or not files:
        raise ValueError("Volume needs a root directory and at least one file")
    return entries


def collect(root):
    before = tree(root)
    entries = {}
    for name, row in before.items():
        entries[name] = dict(row)
        if row["kind"] == "file":
            entries[name]["data"] = base64.b64encode((root / name).read_bytes()).decode()
    validate(entries)
    if tree(root) != before:
        raise ValueError("Source volume changed during collection")
    return entries


def restore(root, entries, kind):
    validate(entries)
    if kind not in {"results", "prefect"}:
        raise ValueError("Unsupported store")
    if root.is_symlink() or not root.is_dir() or any(root.iterdir()):
        raise ValueError("Restore requires an empty separate directory")
    order = sorted(entries, key=lambda name: (len(PurePosixPath(name).parts), name))
    for name in order:
        row = entries[name]
        target = root / name
        if row["kind"] == "directory":
            target.mkdir(exist_ok=True)
        else:
            with target.open("xb") as outgoing:
                outgoing.write(base64.b64decode(row["data"], validate=True))
    for name in reversed(order):
        row = entries[name]
        target = root / name
        os.chown(target, row["uid"], row["gid"])
        target.chmod(row["mode"])
        os.utime(target, ns=(row["mtime_ns"], row["mtime_ns"]))
    if collect(root) != entries:
        raise ValueError("Restored volume differs from the archive")
    result = {
        "status": "VERIFIED",
        "files": sum(row["kind"] == "file" for row in entries.values()),
        "bytes": sum(row["size"] for row in entries.values()),
        "tree_sha256": hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(),
        "permissions_verified": True,
    }
    if kind == "prefect":
        # Inspect the writable disposable copy. Read-only SQLite still needs WAL/SHM;
        # immutable=1 would silently omit committed WAL data. No server is started.
        result.update(check_prefect(root, {}))
    return result


if __name__ == "__main__":
    if sys.argv[1] == "collect":
        print(json.dumps(collect(Path("/source")), sort_keys=True))
    elif sys.argv[1] == "restore":
        print(json.dumps(restore(Path("/restore"), json.load(sys.stdin), sys.argv[2])))
    else:
        raise ValueError("Unsupported volume action")
