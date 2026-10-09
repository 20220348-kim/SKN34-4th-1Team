"""Restore and inspect new PVC copies; no server, credentials or model calls."""

import json
import os
from pathlib import Path

import ops_volume_restore_probe as probe
import ops_volume_snapshot_files as files

UID = 10001
GID = 10001


def runtime_tree(root):
    """Record content after SQLite inspection and explicit runtime permission mapping."""
    inventory = probe.tree(root)
    for row in inventory.values():
        if (row["uid"], row["gid"], row["mode"]) != (
            UID,
            GID,
            0o750 if row["kind"] == "directory" else 0o640,
        ):
            raise ValueError("Restored data is not owned by the evaluation runtime")
    return inventory


def restore(stores, expected, root):
    probe.expected_runs(expected)
    if set(stores) != {"prefect", "results"}:
        raise ValueError("Both evaluation stores are required")
    # Reject invalid input and nonempty targets before writing either store.
    for kind, entries in stores.items():
        files.validate(entries)
        target = root / kind
        if target.is_symlink() or not target.is_dir() or any(target.iterdir()):
            raise ValueError("PVC restore requires new empty stores")
    proof = {}
    for kind, entries in stores.items():
        target = root / kind
        restored = files.restore(target, entries, kind, expected)
        logical = probe.sqlite_digest(target) if kind == "prefect" else None
        # The archive's metadata has already been checked exactly. Kubernetes
        # uses UID/GID 10001; only this new copy is mapped to 0750/0640.
        for path in [*target.rglob("*"), target]:
            path.chmod(0o750 if path.is_dir() else 0o640)
            os.chown(path, UID, GID)
        proof[kind] = {
            "archive": restored,
            "runtime_tree": runtime_tree(target),
            "logical_sha256": logical,
        }
    return proof


def verify(proof, expected, root):
    if (os.getuid(), os.getgid()) != (UID, GID):
        raise ValueError("Verification must use the evaluation runtime UID/GID")
    probe.expected_runs(expected)
    if set(proof) != {"prefect", "results"}:
        raise ValueError("Both restored inventories are required")
    for kind, evidence in proof.items():
        target = root / kind
        if runtime_tree(target) != evidence["runtime_tree"]:
            raise ValueError("PVC content or metadata changed between Pods")
        if kind == "prefect":
            probe.check_prefect(target, expected)
            if probe.sqlite_digest(target) != evidence["logical_sha256"]:
                raise ValueError("Prefect logical data changed")
        else:
            for request, row in expected.items():
                if (
                    evidence["runtime_tree"][request + "/evaluation/report.html"][
                        "sha256"
                    ]
                    != row["report_sha256"]
                ):
                    raise ValueError(
                        "Completed report differs from restored Ops evidence"
                    )
        # Actually exercise the write path required by Prefect and the runner.
        # The read-only artifact server is verified by its own chart/API tests.
        check = target / ".govbiz-pvc-write-probe"
        before = target.stat()
        with check.open("xb") as stream:
            stream.write(b"pvc-write-probe")
        if check.read_bytes() != b"pvc-write-probe":
            raise ValueError("Runtime write probe differs")
        check.unlink()
        os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
    return {
        "status": "VERIFIED",
        "matched_completed_evaluations": len(expected),
        "matched_prefect_executions": len(probe.prefect_runs(expected)),
        "shared_review_copies_verified": sum(
            "shared_review_copy" in row for row in expected.values()
        ),
        "runtime_uid": UID,
        "runtime_gid": GID,
        "pod_replacement_preserved_data": True,
        "runtime_writable": True,
        "sqlite_integrity": True,
        "model_api_calls": 0,
    }


def main(value):
    try:
        root = Path("/restore")
        if value["action"] == "restore":
            result = restore(value["stores"], value["expected"], root)
        elif value["action"] == "verify":
            result = verify(value["proof"], value["expected"], root)
        else:
            raise ValueError("Unsupported PVC probe action")
        print(json.dumps(result, sort_keys=True))
    except Exception:  # noqa: BLE001 - Never print private restored paths or SQL.
        # File names, SQL and restored payloads must not enter Pod logs/errors.
        raise SystemExit("PVC data verification failed") from None
