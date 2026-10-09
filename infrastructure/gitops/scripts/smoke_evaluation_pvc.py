"""Verify synthetic Prefect/WAL and reports on a new disposable kind cluster."""

import argparse
import hashlib
import json
import sqlite3
import tempfile
from pathlib import Path
from uuid import uuid4

import evaluation_pvc_restore as restore
import evaluation_retained_data


def fixture(directory):
    request, flow = str(uuid4()), str(uuid4())
    report = "<html>한글 PVC 복원 검증 🧪</html>".encode()
    results, prefect = directory / "results", directory / "prefect"
    prefect.mkdir()
    artifact = results / request / "evaluation" / "report.html"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(report)
    database = sqlite3.connect(prefect / "prefect.db")
    try:
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("PRAGMA wal_autocheckpoint=0")
        database.executescript("""
            CREATE TABLE alembic_version(version_num TEXT PRIMARY KEY);
            INSERT INTO alembic_version VALUES ('synthetic-pvc-rehearsal');
            CREATE TABLE deployment(id TEXT PRIMARY KEY);
            INSERT INTO deployment VALUES ('fixture');
            CREATE TABLE deployment_schedule(active INTEGER);
            INSERT INTO deployment_schedule VALUES (0);
            CREATE TABLE flow_run(id TEXT PRIMARY KEY, state_type TEXT,
                parameters TEXT, deployment_id TEXT REFERENCES deployment(id));
            CREATE TABLE flow_run_state(id TEXT PRIMARY KEY,
                flow_run_id TEXT REFERENCES flow_run(id), type TEXT);
        """)
        database.execute(
            "INSERT INTO flow_run VALUES (?,?,?,?)",
            (flow, "COMPLETED", json.dumps({"request_id": request}), "fixture"),
        )
        database.execute(
            "INSERT INTO flow_run_state VALUES (?,?,?)",
            (str(uuid4()), flow, "COMPLETED"),
        )
        database.commit()
        # Capture while WAL is still committed and uncheckpointed.
        stores = {
            "prefect": restore.snapshot.files.collect(prefect),
            "results": restore.snapshot.files.collect(results),
        }
        if stores["prefect"]["prefect.db-wal"]["size"] == 0:
            raise ValueError("Synthetic fixture must include committed WAL")
        return stores, {
            request: {
                "flow_id": flow,
                "report_sha256": hashlib.sha256(report).hexdigest(),
            }
        }
    finally:
        database.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        parser.error("Use a new report path")
    run = restore.snapshot.storage.run
    if "v0.33.0" not in run(["kind", "version"]).decode():
        parser.error("Use pinned kind v0.33.0")
    cluster = "govbiz-pvc-smoke-" + uuid4().hex[:12]
    if cluster in run(["kind", "get", "clusters"]).decode().splitlines():
        parser.error("Refusing an existing cluster")
    report = {
        "status": "FAIL",
        "synthetic_fixture": True,
        "personal_environment_verified": False,
        "cluster_cleanup_complete": False,
    }
    created = False
    try:
        with tempfile.TemporaryDirectory(prefix=cluster) as directory:
            root = Path(directory)
            stores, expected = fixture(root)
            config = root / "kubeconfig"
            created = True
            run(
                [
                    "kind",
                    "create",
                    "cluster",
                    "--name",
                    cluster,
                    "--config",
                    str(restore.fork_cluster.ROOT / "kind/local.yaml"),
                    "--kubeconfig",
                    str(config),
                    "--wait",
                    "120s",
                ],
                timeout=180,
            )
            kube = [
                "kubectl",
                "--kubeconfig",
                str(config),
                "--context",
                "kind-" + cluster,
            ]
            restore.fork_cluster.verify_context(
                kube, {"cluster": cluster}, owner=False, timeout=15
            )
            report["pvc"] = restore.rehearse(
                kube, cluster + "-control-plane", stores, expected
            )
            # Retention must survive the context's exit. The outer disposable
            # cluster owns these synthetic copies, so no personal data is touched.
            retained = restore.retain_for_migration(
                kube, cluster + "-control-plane", stores, expected
            )
            nk = kube + ["-n", retained["namespace"]]
            token = restore.run(
                kube + ["get", "namespace", retained["namespace"], "-o", "json"]
            )["metadata"]["labels"][restore.LABEL]
            volumes = restore.bound_volumes(
                kube,
                nk,
                retained["namespace"],
                retained["storage_class"],
                token,
                {name: row["claim_uid"] for name, row in retained["claims"].items()},
                "Retain",
            )
            if (
                volumes != retained["claims"]
                or restore.run(nk + ["get", "pods", "-o", "json"])["items"]
            ):
                raise ValueError("Retained storage or helper cleanup was not preserved")
            # A second request must refuse this namespace and preserve its PVCs.
            try:
                restore.retain_for_migration(
                    kube, cluster + "-control-plane", stores, expected
                )
            except ValueError as error:
                if str(error) != "Retained namespace already exists":
                    raise
                if (
                    restore.bound_volumes(
                        kube,
                        nk,
                        retained["namespace"],
                        retained["storage_class"],
                        token,
                        {
                            name: row["claim_uid"]
                            for name, row in retained["claims"].items()
                        },
                        "Retain",
                    )
                    != volumes
                ):
                    raise ValueError(
                        "A repeated restore changed retained storage"
                    ) from None
            else:
                raise ValueError("An existing retained namespace was accepted")
            report["retained_pvc"] = {
                **retained,
                "retained_after_return": True,
                "repeat_restore_rejected": True,
                "handoff_storage": restore.inspect_retained(
                    kube, cluster + "-control-plane", retained
                ),
            }
            report["retained_data_probe"] = {}
            report["retained_data_recheck"] = evaluation_retained_data.recheck(
                kube,
                cluster + "-control-plane",
                retained,
                stores,
                retained["helper_image"],
                report["retained_data_probe"],
            )
            report["status"] = "PASS"
    finally:
        try:
            if created:
                run(["kind", "delete", "cluster", "--name", cluster], timeout=120)
            report["cluster_cleanup_complete"] = True
        except Exception:
            report["status"] = "FAIL"
            raise
        finally:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(
                json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8"
            )


if __name__ == "__main__":
    main()
