"""Exact-backup gates and fail-closed first migration, without touching a cluster."""

import copy
import hashlib
import json
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

import ops_initial_migration as migration
from check_msa import render
from repository import Fork

SHA = "a" * 40
IMAGE = "sha256:" + "b" * 64
TAG = "govbiz-ops-service:first-pause-fixture"
REQUEST = "a89c84d3-e23a-440f-a74a-ce2ab9c628fc"
PAUSE = {"request_id": REQUEST, "actor": "운영자", "reason": "최초 전환 검증"}
SETTINGS = {"stateId": "c" * 32, "repository": "alice/project"}
SOURCE = {"deployment_version": "1", "pvc_uid": "pvc", "pod_uid": "pod"}


class JobTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resources = render(
            "ops-service",
            extra=(
                "--set",
                "localMode=true",
                "--set-string",
                "image.repository=govbiz-ops-service",
                "--set-string",
                "image.tag=first-pause-fixture",
                "--set-string",
                "image.digest=",
                "--set-string",
                "image.pullPolicy=Never",
            ),
        )
        cls.deployment = next(
            row for row in cls.resources if row["kind"] == "Deployment"
        )

    def test_job_uses_validated_chart_and_keeps_security_and_original_credentials(self):
        job = migration.initial_job(TAG, PAUSE, self.deployment, "helm")
        original = next(row for row in self.resources if row["kind"] == "Job")
        container = job["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(
            container["command"], ["python", "manage.py", "migrate_deployment"]
        )
        self.assertEqual(container["image"], TAG)
        self.assertIn("--pause-actor=운영자", container["args"])
        self.assertIn("--pause-request-id=" + REQUEST, container["args"])
        self.assertNotIn("annotations", job["metadata"])
        self.assertEqual(job["spec"]["backoffLimit"], 0)
        self.assertEqual(
            container["securityContext"],
            original["spec"]["template"]["spec"]["containers"][0]["securityContext"],
        )
        self.assertEqual(container["imagePullPolicy"], "Never")

    def test_route_or_secret_change_and_mutable_image_are_rejected(self):
        for name in (
            "DB_HOST",
            "DB_NAME",
            "DB_USER",
            "DB_PASSWORD",
            "DJANGO_SECRET_KEY",
        ):
            deployment = copy.deepcopy(self.deployment)
            env = deployment["spec"]["template"]["spec"]["containers"][0]["env"]
            next(row for row in env if row["name"] == name).update(value="different")
            with self.subTest(name=name), self.assertRaises(ValueError):
                migration.initial_job(TAG, PAUSE, deployment, "helm")
        for tag in ("govbiz-ops-service:latest", "unrelated:tag", "sha256:abc"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                migration.initial_job(tag, PAUSE, self.deployment, "helm")

    def test_invalid_pause_input_is_rejected_without_external_calls(self):
        self.assertEqual(
            migration.pause_arguments(REQUEST, " 운영자 ", " 최초 전환 검증 "), PAUSE
        )
        for arguments in (
            ("bad", "운영자", "사유"),
            (REQUEST, "", "사유"),
            (REQUEST, "a" * 151, "사유"),
            (REQUEST, "운영자", "a" * 501),
            (REQUEST, "운\n영자", "사유"),
            (REQUEST, None, "사유"),
        ):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                migration.pause_arguments(*arguments)


class SourceTests(unittest.TestCase):
    def test_exact_clean_head_remote_branch_and_every_ci_job_are_required(self):
        with (
            patch.object(
                migration, "from_origin", return_value=Fork("alice/project", "topic")
            ),
            patch.object(
                migration.database.storage, "run", side_effect=[SHA.encode(), b""]
            ),
            patch.object(migration.gate, "api", return_value={"object": {"sha": SHA}}),
            patch.object(
                migration.gate, "ci_blocked_reason", return_value=None
            ) as gate,
        ):
            self.assertEqual(migration.source_evidence(SETTINGS, SHA, "topic"), [])
            gate.assert_called_once()
        for output, remote, blocked in (
            ([b"d" * 40], SHA, None),
            ([SHA.encode(), b" M tracked.py"], SHA, None),
            ([SHA.encode(), b"?? untracked.py"], SHA, None),
            ([SHA.encode(), b""], "d" * 40, None),
            (
                [SHA.encode(), b""],
                SHA,
                "ci_jobs_not_successful_or_incomplete:ops-ci.yml",
            ),
        ):
            with (
                self.subTest(output=output, remote=remote, blocked=blocked),
                patch.object(
                    migration,
                    "from_origin",
                    return_value=Fork("alice/project", "topic"),
                ),
                patch.object(migration.database.storage, "run", side_effect=output),
                patch.object(
                    migration.gate, "api", return_value={"object": {"sha": remote}}
                ),
                patch.object(migration.gate, "ci_blocked_reason", return_value=blocked),
                self.assertRaises(ValueError),
            ):
                migration.source_evidence(SETTINGS, SHA, "topic")

    def test_backup_must_match_current_database_volumes_files_and_keys(self):
        payload = {
            "database": {
                "source": SOURCE,
                "table_counts": {"table": 1},
                "sql": "private SQL",
            },
            "sources": {"results": {"image": IMAGE, "volume": "fixture"}},
            "stores": {"results": {"entries": {"file": "private bytes"}}},
            "runtime_keys": {"keys": "private keys", "proof": "private proof"},
        }
        for changed in (
            None,
            "source",
            "counts",
            "sql",
            "volumes",
            "files",
            "keys",
            "last_source",
        ):
            with ExitStack() as stack, self.subTest(changed=changed):
                frozen = stack.enter_context(
                    patch.object(
                        migration.database,
                        "frozen_source",
                        return_value=(["kubectl"], SOURCE),
                    )
                )
                stack.enter_context(patch.object(migration.database, "quiet_database"))
                stack.enter_context(
                    patch.object(
                        migration.database,
                        "inventory",
                        return_value={} if changed == "counts" else {"table": 1},
                    )
                )
                stack.enter_context(
                    patch.object(
                        migration.database,
                        "dump",
                        return_value="changed" if changed == "sql" else "private SQL",
                    )
                )
                stack.enter_context(
                    patch.object(
                        migration.snapshot,
                        "volume_sources",
                        return_value={} if changed == "volumes" else payload["sources"],
                    )
                )
                stack.enter_context(
                    patch.object(
                        migration.snapshot,
                        "volume_helper",
                        return_value={}
                        if changed == "files"
                        else payload["stores"]["results"]["entries"],
                    )
                )
                stack.enter_context(
                    patch.object(
                        migration.runtime_keys,
                        "capture",
                        return_value={}
                        if changed == "keys"
                        else {"keys": "private keys"},
                    )
                )
                if changed in {"source", "last_source"}:
                    frozen.side_effect = [
                        (["kubectl"], {} if changed == "source" else SOURCE),
                        (["kubectl"], {}),
                    ]
                if changed:
                    with self.assertRaises(ValueError):
                        migration.require_backup_source(
                            Path("state"), SETTINGS, payload
                        )
                else:
                    self.assertEqual(
                        migration.require_backup_source(
                            Path("state"), SETTINGS, payload
                        )[1],
                        SOURCE,
                    )


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.state = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.args = SimpleNamespace(
            pause_request_id=REQUEST,
            pause_actor=PAUSE["actor"],
            pause_reason=PAUSE["reason"],
            state_dir=self.state,
            expected_state_id=SETTINGS["stateId"],
            source_sha=SHA,
            source_branch="topic",
            archive=self.state / "state.enc",
            key_file=self.state / "key",
            ops_image=TAG,
            helm="helm",
            kind="kind",
            execute=False,
        )
        self.payload = {
            "database": {"source": SOURCE},
            "runtime_keys": {"keys": "private-key"},
        }
        self.job = {"kind": "Job", "metadata": {"name": "ops-service-migrate"}}
        self.events = []
        self.mocks = {}

        def mock(owner, name, **kwargs):
            value = self.stack.enter_context(patch.object(owner, name, **kwargs))
            self.mocks[name] = value
            return value

        mock(migration.database, "load_settings", return_value=SETTINGS)
        mock(migration.cluster, "require_dev")
        mock(migration.database, "frozen_source", return_value=(["kubectl"], SOURCE))
        mock(migration, "source_evidence", return_value=[{"runId": 1}])
        mock(migration.database, "private_parent", side_effect=lambda path: path)
        mock(migration.database, "read_archive", return_value=b"ciphertext")
        mock(migration.database.storage, "key_bytes", return_value=b"private-key")
        mock(migration.database.storage, "open_payload", return_value=self.payload)
        mock(migration.snapshot, "validate", side_effect=lambda payload: payload)
        mock(
            migration,
            "require_backup_source",
            return_value=(["kubectl"], SOURCE, ["mysql"]),
        )

        def read_json(arguments):
            if arguments[0] == "docker":
                return [{"Id": IMAGE}]
            return {"metadata": {"resourceVersion": "1"}, "spec": {"replicas": 0}}

        mock(migration.database, "read_json", side_effect=read_json)
        mock(migration, "initial_job", return_value=self.job)
        mock(migration.database.storage, "run", return_value=b"")
        mock(
            migration.snapshot,
            "verify",
            return_value={"sha256": hashlib.sha256(b"ciphertext").hexdigest()},
        )

        @contextmanager
        def restored(_payload):
            self.events.append("restore")
            try:
                yield ["disposable-mysql"]
            finally:
                self.events.append("cleanup")

        mock(migration.database, "restored_database", side_effect=restored)
        mock(migration.upgrade, "run_upgrade", return_value={"status": "REHEARSED"})
        mock(migration.cluster, "load_image")
        mock(migration.cluster, "commands", return_value=(["kubectl"], ["kubectl"], []))
        mock(migration, "run_migration")
        mock(migration, "verify_pause")

    def journal(self):
        return self.state / "ops-initial-migrations" / (REQUEST + ".json")

    def test_default_only_verifies_and_does_not_create_job_or_load_cluster_image(self):
        report = migration.migrate(self.args)
        self.assertEqual(report["status"], "VERIFIED_FOR_MIGRATION")
        self.assertFalse(report["original_database_migration_attempted"])
        self.assertFalse(report["writers_resumed"])
        self.assertEqual(self.events, ["restore", "cleanup"])
        self.mocks["load_image"].assert_not_called()
        self.mocks["run_migration"].assert_not_called()
        self.assertFalse(self.journal().exists())
        self.mocks["verify"].assert_called_once_with(
            self.args.archive,
            self.args.key_file,
            completed_links=True,
            verify_runtime_keys=True,
            database_login=True,
        )

    def test_execution_journals_before_mutation_retains_job_and_never_resumes(self):
        self.args.execute = True

        def apply(*arguments, **kwargs):
            recorded = json.loads(self.journal().read_text())
            self.assertEqual(recorded["stage"], "migration")
            self.assertTrue(recorded["original_database_migration_attempted"])
            self.assertTrue(kwargs["retain_completed"])
            self.assertNotIn("private-key", self.journal().read_text())

        self.mocks["run_migration"].side_effect = apply
        report = migration.migrate(self.args)
        self.assertEqual(report["status"], "MIGRATED_PAUSED")
        self.assertTrue(report["admission_paused"])
        self.assertFalse(report["runtime_updated"])
        self.assertFalse(report["writers_resumed"])
        self.mocks["verify_pause"].assert_called_once_with(["mysql"], PAUSE)
        self.assertEqual(json.loads(self.journal().read_text()), report)

    def test_failed_or_interrupted_job_records_unknown_outcome_and_redacts_error(self):
        self.args.execute = True
        for error in (RuntimeError("private-db-password"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                self.mocks["run_migration"].side_effect = error
                with self.assertRaises(type(error)):
                    migration.migrate(self.args)
                report = json.loads(self.journal().read_text())
                self.assertEqual(report["status"], "FAILED")
                self.assertEqual(report["stage"], "migration")
                self.assertTrue(report["original_database_migration_attempted"])
                self.assertNotIn("private-db-password", self.journal().read_text())
                self.mocks["verify_pause"].assert_not_called()
                self.journal().unlink()

    def test_missing_checks_or_changed_source_stop_before_job(self):
        self.args.execute = True
        for name in (
            "frozen_source",
            "source_evidence",
            "require_backup_source",
            "verify",
            "run_upgrade",
        ):
            with self.subTest(name=name):
                original = self.mocks[name].side_effect
                self.mocks[name].side_effect = ValueError("blocked")
                with self.assertRaises(ValueError):
                    migration.migrate(self.args)
                self.mocks["run_migration"].assert_not_called()
                self.mocks[name].side_effect = original
        self.mocks["read_archive"].side_effect = [b"ciphertext", b"changed"]
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        self.mocks["run_migration"].assert_not_called()

    def test_existing_job_or_journal_cannot_be_automatically_retried(self):
        self.args.execute = True
        self.mocks["run"].return_value = b"job/ops-service-migrate"
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        self.mocks["run"].return_value = b""
        self.journal().parent.mkdir()
        self.journal().write_text("original record")
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        self.assertEqual(self.journal().read_text(), "original record")
        self.mocks["run_migration"].assert_not_called()

    def test_changed_ci_after_image_load_leaves_failure_journal_without_migration(self):
        self.args.execute = True
        self.mocks["source_evidence"].side_effect = [
            [{"runId": 1}],
            [{"runId": 1}],
            [{"runId": 2}],
        ]
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        report = json.loads(self.journal().read_text())
        self.assertEqual(report["status"], "FAILED")
        self.assertEqual(report["stage"], "final_verification")
        self.assertFalse(report["original_database_migration_attempted"])
        self.mocks["run_migration"].assert_not_called()

    def test_pause_verification_failure_cannot_report_success_or_restart_writers(self):
        self.args.execute = True
        self.mocks["verify_pause"].side_effect = ValueError("private row")
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        report = json.loads(self.journal().read_text())
        self.assertEqual(report["status"], "FAILED")
        self.assertEqual(report["stage"], "pause_verification")
        self.assertTrue(report["original_database_migration_attempted"])
        self.assertFalse(report["writers_resumed"])
        self.assertFalse(report["automatic_database_restore"])
        self.assertNotIn("private row", self.journal().read_text())

    def test_changed_image_after_rehearsal_is_rejected_before_load_or_job(self):
        self.args.execute = True
        self.mocks["read_json"].side_effect = [
            {"metadata": {"resourceVersion": "1"}, "spec": {"replicas": 0}},
            [{"Id": IMAGE}],
            [{"Id": "sha256:" + "d" * 64}],
        ]
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        self.mocks["load_image"].assert_not_called()
        self.mocks["run_migration"].assert_not_called()

    def test_other_state_and_missing_keys_are_rejected(self):
        self.args.expected_state_id = "wrong-state"
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        self.mocks["frozen_source"].assert_not_called()
        self.args.expected_state_id = SETTINGS["stateId"]
        self.payload.pop("runtime_keys")
        with self.assertRaises(ValueError):
            migration.migrate(self.args)
        self.mocks["verify"].assert_not_called()
        self.mocks["run_migration"].assert_not_called()


class PauseTests(unittest.TestCase):
    def test_state_and_single_matching_audit_required(self):
        change = {
            **PAUSE,
            "request_id": UUID(REQUEST).hex,
            "accepting": 0,
            "version": 1,
        }
        for state, rows, valid in (
            ("0\t1", [change], True),
            ("1\t2", [change], False),
            ("0\t1", [], False),
            ("0\t1", [change, change], False),
            ("0\t1", [{**change, "actor": "다른 운영자"}], False),
        ):
            with (
                self.subTest(state=state, rows=rows),
                patch.object(
                    migration.database,
                    "query",
                    side_effect=[state, "\n".join(json.dumps(row) for row in rows)],
                ),
            ):
                if valid:
                    migration.verify_pause(["mysql"], PAUSE)
                else:
                    with self.assertRaises(ValueError):
                        migration.verify_pause(["mysql"], PAUSE)


if __name__ == "__main__":
    unittest.main()
