"""Snapshot guards and an opt-in, isolated real MySQL encrypted restore test."""

import copy
import hashlib
import json
import os
import secrets
import subprocess
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import ops_db_snapshot as snapshot

IMAGE = "mysql@sha256:" + "a" * 64
IDENTITY = "b" * 64
SQL = "CREATE TABLE `django_migrations` (id int);\n-- 한글 🧪\n"
COUNTS = {name: 1 for name in snapshot.REQUIRED_TABLES}
SETTINGS = {"repository": "alice/project", "stateId": "c" * 32, "namespace": "govbiz-msa"}


def payload():
    return {
        "schema_version": 1,
        "scope": snapshot.SCOPE,
        "database": snapshot.DATABASE,
        "mysql_image": IMAGE,
        "mysql_version": "8.4.8",
        "sql": SQL,
        "sql_sha256": hashlib.sha256(SQL.encode()).hexdigest(),
        "table_counts": COUNTS,
    }


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.dev_guard = self.stack.enter_context(patch.object(snapshot, "require_dev"))
        self.stack.enter_context(
            patch.object(snapshot, "commands", return_value=([], ["kubectl"], []))
        )
        self.connection = self.stack.enter_context(
            patch.object(snapshot, "read_connection", return_value={"composeProject": "fixture"})
        )
        self.env = {"DB_HOST": "ops-mysql", "DB_PORT": "3306", "DB_NAME": "govbiz_ops"}
        self.deployment = {
            "metadata": {"uid": "deployment", "resourceVersion": "1"},
            "spec": {
                "replicas": 0,
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": name,
                                "env": [
                                    {"name": key, "value": value} for key, value in self.env.items()
                                ],
                            }
                            for name in ("ops-service", "ops-sync")
                        ]
                    }
                },
            },
            "status": {"replicas": 0},
        }
        self.pod = {
            "metadata": {
                "uid": "pod",
                "labels": {"app": "ops-mysql"},
                "ownerReferences": [{"controller": True, "kind": "StatefulSet", "uid": "stateful"}],
            },
            "spec": {
                "volumes": [
                    {"name": "data", "persistentVolumeClaim": {"claimName": "data-ops-mysql-0"}}
                ]
            },
            "status": {
                "containerStatuses": [
                    {
                        "name": "mysql",
                        "ready": True,
                        "state": {"running": {"startedAt": "time"}},
                        "imageID": IMAGE,
                        "restartCount": 0,
                    }
                ]
            },
        }
        self.resources = {
            "deployment": self.deployment,
            "pods": {"items": []},
            "hpa": {"items": []},
            "pod": self.pod,
            "statefulset": {"metadata": {"uid": "stateful"}},
            "pvc": {
                "metadata": {"uid": "claim"},
                "status": {"phase": "Bound"},
                "spec": {"volumeName": "volume"},
            },
            "service": {
                "metadata": {"uid": "service"},
                "spec": {
                    "selector": {"app": "ops-mysql"},
                    "ports": [
                        {"name": "mysql", "port": 3306, "protocol": "TCP", "targetPort": "mysql"}
                    ],
                },
            },
            "endpointslices": {
                "items": [
                    {"endpoints": [{"targetRef": {"uid": "pod"}, "conditions": {"ready": True}}]}
                ]
            },
        }
        self.stack.enter_context(
            patch.object(
                snapshot,
                "read_json",
                side_effect=lambda args: self.resources[args[args.index("get") + 1]],
            )
        )
        self.writers = {
            ch * 64: {
                "Id": ch * 64,
                "Config": {
                    "Labels": {
                        "com.docker.compose.project": "fixture",
                        "com.docker.compose.service": name,
                    }
                },
                "Image": "sha256:" + ch * 64,
                "RestartCount": 0,
                "State": {
                    "Status": "exited",
                    "Running": False,
                    "StartedAt": "start",
                    "FinishedAt": "finish",
                },
            }
            for ch, name in (("b", "prefect"), ("c", "evaluation-runner"))
        }
        self.stack.enter_context(
            patch.object(
                snapshot.storage, "inspect", side_effect=lambda identity: self.writers[identity]
            )
        )
        self.run = self.stack.enter_context(
            patch.object(
                snapshot.storage,
                "run",
                side_effect=lambda args, **kw: (
                    "\n".join(self.writers).encode() if args[1] == "ps" else b"[]"
                ),
            )
        )

    def source(self):
        return snapshot.frozen_source(Path("fixture"), SETTINGS)[1]

    def test_only_stopped_owned_writers_and_matching_db_are_accepted(self):
        result = self.source()
        self.assertEqual(result["pvc_uid"], "claim")
        self.assertEqual(result["mysql_image"], IMAGE)
        self.assertEqual(len(result["writers"]), 2)
        self.assertNotIn("Env", json.dumps(result))
        self.assertFalse(
            any(
                "stop" in call.args[0] or "start" in call.args[0]
                for call in self.run.call_args_list
            )
        )

    def test_active_or_unterminated_kubernetes_writers_are_rejected(self):
        self.deployment["spec"]["replicas"] = 1
        with self.assertRaises(ValueError):
            self.source()
        self.deployment["spec"]["replicas"] = 0
        self.resources["pods"]["items"] = [{}]
        with self.assertRaises(ValueError):
            self.source()

    def test_wrong_connection_or_database_or_autoscaler_is_rejected(self):
        with patch.object(
            snapshot, "read_connection", side_effect=[{"composeProject": "fixture"}, {}]
        ):
            with self.assertRaises(ValueError):
                self.source()
        self.deployment["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = "foreign"
        with self.assertRaises(ValueError):
            self.source()
        self.deployment["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = (
            "ops-mysql"
        )
        self.resources["hpa"]["items"] = [{"spec": {"scaleTargetRef": {"name": "ops-service"}}}]
        with self.assertRaises(ValueError):
            self.source()

    def test_running_paused_missing_and_foreign_compose_writers_are_rejected(self):
        original = copy.deepcopy(self.writers)
        for changes in (
            {"Running": True},
            {"Paused": True},
            {"Restarting": True},
            {"Status": "running"},
        ):
            self.writers = copy.deepcopy(original)
            self.writers[IDENTITY]["State"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.source()
        self.writers = copy.deepcopy(original)
        self.writers[IDENTITY]["Config"]["Labels"]["com.docker.compose.project"] = "foreign"
        with self.assertRaises(ValueError):
            self.source()
        self.writers = {}
        with self.assertRaises(ValueError):
            self.source()

    def test_changed_volume_owner_or_service_endpoint_is_rejected(self):
        original = copy.deepcopy(self.resources)
        for resource, path, value in (
            ("statefulset", ("metadata", "uid"), "foreign"),
            ("pvc", ("status", "phase"), "Pending"),
            ("service", ("spec", "selector"), {"app": "other"}),
            ("endpointslices", ("items",), []),
        ):
            self.resources = copy.deepcopy(original)
            target = self.resources[resource]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(resource=resource), self.assertRaises(ValueError):
                self.source()


class GitOpsSourceTests(SourceTests):
    def setUp(self):
        super().setUp()
        self.settings = SETTINGS | {"mode": "gitops"}
        self.deployment["kind"] = "Deployment"
        self.deployment["metadata"].update(
            name="ops-service",
            namespace="govbiz-msa",
            generation=2,
            annotations={
                "argocd.argoproj.io/tracking-id": (
                    "govbiz-fork-ops-service:apps/Deployment:govbiz-msa/ops-service"
                )
            },
        )
        self.deployment["status"]["observedGeneration"] = 2
        self.argo = self.enterContext(
            patch.object(
                snapshot,
                "argo_observation",
                return_value={
                    "projectUid": "project",
                    "projectSpecSha256": "d" * 64,
                    "applications": {
                        "ops-service": {"uid": "app", "sourceSha": "e" * 40, "specSha256": "f" * 64}
                    },
                },
            )
        )
        self.load = self.enterContext(
            patch.object(snapshot, "load_settings", return_value=self.settings)
        )
        self.query = self.enterContext(patch.object(snapshot, "query", return_value="1\t0\t8"))

    def source(self):
        return snapshot.frozen_source(Path("fixture"), self.settings)[1]

    def test_kubernetes_cutover_requires_explicit_mode_and_skips_stale_compose(self):
        for container in self.deployment["spec"]["template"]["spec"]["containers"]:
            container["env"] += [
                {
                    "name": "PREFECT_API_URL",
                    "value": "http://prefect.govbiz-evaluation.svc.cluster.local:4200/api",
                },
                {
                    "name": "LLMOPS_ARTIFACT_URL",
                    "value": "http://ops-artifacts.govbiz-evaluation.svc.cluster.local:8010",
                },
            ]
        with self.assertRaisesRegex(ValueError, "kubernetes-evaluation"):
            self.source()
        self.connection.reset_mock()
        with (
            patch("evaluation_snapshot.observe", return_value={"namespace_uid": "evaluation"}),
            patch.object(snapshot, "compose_writers") as compose,
        ):
            result = snapshot.frozen_source(
                Path("fixture"), self.settings, kubernetes_evaluation=True
            )[1]
        self.assertEqual(result["evaluation"], {"namespace_uid": "evaluation"})
        self.assertNotIn("compose_project", result)
        compose.assert_not_called()
        self.connection.assert_not_called()

    def test_stopped_gitops_binds_argo_deployment_and_paused_admission_without_writes(self):
        original = copy.deepcopy((self.settings, self.resources, self.writers))
        result = self.source()
        self.assertEqual(result["admission_version"], 8)
        self.assertEqual(result["argo_observation"], self.argo.return_value)
        self.assertEqual(
            result["deployment_spec_sha256"],
            hashlib.sha256(
                json.dumps(self.deployment["spec"], sort_keys=True).encode()
            ).hexdigest(),
        )
        self.assertEqual(self.argo.call_count, 2)
        self.argo.assert_called_with(Path("fixture"), self.settings, stopped_ops=True)
        self.dev_guard.assert_not_called()
        self.assertEqual(original, (self.settings, self.resources, self.writers))
        self.assertEqual(self.query.call_count, 1)
        self.assertTrue(self.query.call_args.args[1].startswith("SELECT "))

    def test_foreign_tracking_or_unobserved_stop_is_rejected(self):
        original = copy.deepcopy(self.deployment)
        for section, key, value in (
            ("metadata", "uid", ""),
            ("metadata", "generation", True),
            ("metadata", "namespace", "foreign"),
            ("metadata", "annotations", {}),
            ("metadata", "labels", {"argocd.argoproj.io/instance": "other"}),
            (
                "metadata",
                "annotations",
                original["metadata"]["annotations"] | {"argocd.argoproj.io/hook": "PreSync"},
            ),
            ("status", "observedGeneration", 1),
            ("status", "readyReplicas", 1),
            ("status", "replicas", False),
            ("spec", "replicas", False),
        ):
            self.resources["deployment"] = copy.deepcopy(original)
            self.resources["deployment"][section][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.source()
        self.query.assert_not_called()

    def test_ambiguous_database_environment_is_rejected(self):
        original = copy.deepcopy(self.deployment)
        for change in ("duplicate", "envFrom", "valueFrom"):
            self.resources["deployment"] = copy.deepcopy(original)
            container = self.resources["deployment"]["spec"]["template"]["spec"]["containers"][0]
            if change == "duplicate":
                container["env"].append(copy.deepcopy(container["env"][0]))
            elif change == "envFrom":
                container["envFrom"] = [{"secretRef": {"name": "foreign"}}]
            else:
                container["env"][0]["valueFrom"] = {
                    "secretKeyRef": {"name": "foreign", "key": "host"}
                }
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.source()
        self.query.assert_not_called()

    def test_argo_settings_or_connections_changed_during_read_are_rejected(self):
        record = self.connection.return_value
        for change in ("argo", "settings", "profile", "bridge"):
            self.argo.side_effect = None
            self.load.side_effect = None
            self.connection.side_effect = None
            if change == "argo":
                self.argo.side_effect = [self.argo.return_value, {"projectUid": "changed"}]
            elif change == "settings":
                self.load.side_effect = [self.settings | {"mode": "dev"}]
            else:
                self.connection.side_effect = (
                    [record, record, {}, record]
                    if change == "profile"
                    else [record, record, record, {}]
                )
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "changed"):
                self.source()

    def test_open_gate_prevents_a_frozen_source(self):
        self.query.return_value = "1\t1\t9"
        with self.assertRaisesRegex(ValueError, "paused admission"):
            self.source()


class ContractTests(unittest.TestCase):
    def test_paused_admission_requires_exactly_one_supported_closed_gate(self):
        for value in ("", "1\t1\t8", "2\t0\t8", "1\t0\t0", "1\t0\t-1", "1\t0\t8\n2\t0\t9"):
            with patch.object(snapshot, "query", return_value=value), self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "paused admission"):
                    snapshot.paused_admission_version([])
        with patch.object(snapshot, "query", return_value="1\t0\t8"):
            self.assertEqual(snapshot.paused_admission_version([]), 8)
        with patch.object(
            snapshot, "query", side_effect=snapshot.storage.SnapshotError("missing table")
        ):
            with self.assertRaises(snapshot.storage.SnapshotError):
                snapshot.paused_admission_version([])

    @unittest.skipUnless(os.name == "posix", "CLI is WSL/Linux only")
    def test_cli_failure_redacts_private_error_and_never_prints_success(self):
        for failure in (
            ValueError("private SQL/password"),
            subprocess.TimeoutExpired("private SQL/password", 15),
            subprocess.CalledProcessError(1, "private SQL/password"),
        ):
            with (
                self.subTest(failure=type(failure).__name__),
                patch(
                    "sys.argv",
                    ["ops_db_snapshot.py", "verify", "--archive", "private", "--key-file", "key"],
                ),
                patch.object(snapshot, "verify", side_effect=failure),
                patch.object(snapshot.os, "umask"),
                patch("builtins.print") as output,
                patch("sys.stderr") as error,
            ):
                with self.assertRaises(SystemExit) as exit_status:
                    snapshot.main()
            self.assertEqual(exit_status.exception.code, 1)
            output.assert_not_called()
            self.assertNotIn("private SQL/password", str(error.write.call_args_list))

    def test_invalid_archive_contract_and_sql_hash_are_rejected(self):
        for change in (
            {"scope": "compose"},
            {"schema_version": True},
            {"mysql_image": "mysql:8.4"},
            {"mysql_version": "8.0.42"},
            {"sql": None},
            {"sql": SQL + "changed"},
            {"table_counts": {}},
            {"table_counts": COUNTS | {"auth_user": True}},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                snapshot.validate(payload() | change)
        with self.assertRaises(ValueError):
            snapshot.validate([])

    def test_legacy_database_without_schedule_tables_is_supported(self):
        with patch.object(snapshot, "query", return_value="0") as query:
            snapshot.quiet_database([], COUNTS)
        self.assertEqual(query.call_count, 3)

    def test_outstanding_runs_reservations_and_schedules_are_rejected(self):
        counts = COUNTS | {
            "evaluations_evaluationschedule": 1,
            "evaluations_evaluationscheduleoccurrence": 1,
        }
        for index in range(5):
            replies = ["0"] * 5
            replies[index] = "1"
            with self.subTest(index=index), patch.object(snapshot, "query", side_effect=replies):
                with self.assertRaises(ValueError):
                    snapshot.quiet_database([], counts)
        with self.assertRaises(ValueError):
            snapshot.quiet_database([], COUNTS | {"evaluations_evaluationschedule": 1})

    def test_inventory_rejects_missing_tables_and_duplicate_counts(self):
        for responses in (["auth_user"], ["\n".join(COUNTS), "auth_user\t1\nauth_user\t1"]):
            with (
                patch.object(snapshot, "query", side_effect=responses),
                self.assertRaises(ValueError),
            ):
                snapshot.inventory([])


@unittest.skipUnless(
    os.name == "posix", "Private file and OpenSSL pipe contracts require WSL/Linux"
)
class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ops-db-snapshot-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.key = self.root / "key"
        self.archive = self.root / "snapshot.enc"
        snapshot.storage.exclusive(self.key, b"a" * 64)

    def test_backup_encrypts_without_plaintext_file_or_automatic_restore(self):
        before = {"mysql_image": IMAGE}
        with (
            patch.object(snapshot, "load_settings", return_value=SETTINGS),
            patch.object(snapshot, "frozen_source", return_value=(["kubectl"], before)),
            patch.object(snapshot, "query", return_value="8.4.8"),
            patch.object(snapshot, "inventory", return_value=COUNTS),
            patch.object(snapshot, "quiet_database"),
            patch.object(snapshot, "dump", return_value=SQL),
        ):
            result = snapshot.backup(self.root, self.key, self.archive)
        self.assertEqual(result["status"], "BACKED_UP")
        self.assertFalse(result["restore_verified"])
        self.assertFalse(result["full_backup_verified"])
        self.assertFalse(result["services_changed"])
        raw = self.archive.read_bytes()
        self.assertNotIn(SQL.encode(), raw)
        self.assertEqual(
            snapshot.validate(snapshot.storage.open_payload(raw, b"a" * 64))["sql"], SQL
        )
        self.assertEqual(set(self.root.iterdir()), {self.key, self.archive})
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            snapshot.backup(self.root, self.key, self.archive)
        self.assertEqual(self.archive.read_bytes(), raw)

    def test_source_change_prevents_archive_publication(self):
        before = {"mysql_image": IMAGE}
        for metadata, dumps, counts in (
            ([before, before | {"restart": 1}], [SQL], [COUNTS]),
            ([before, before], [SQL, SQL + "changed"], [COUNTS, COUNTS]),
            ([before, before], [SQL], [COUNTS, COUNTS | {"auth_user": 2}]),
            ([before, before, before | {"restart": 1}], [SQL, SQL], [COUNTS, COUNTS]),
            ([before, before | {"admission_version": 9}], [SQL], [COUNTS]),
            (
                [before, before, before | {"argo_observation": {"projectUid": "changed"}}],
                [SQL, SQL],
                [COUNTS, COUNTS],
            ),
            ([before, before | {"deployment_spec_sha256": "changed"}], [SQL], [COUNTS]),
        ):
            with (
                patch.object(snapshot, "load_settings", return_value=SETTINGS),
                patch.object(
                    snapshot, "frozen_source", side_effect=[([], value) for value in metadata]
                ),
                patch.object(snapshot, "query", return_value="8.4.8"),
                patch.object(snapshot, "inventory", side_effect=counts),
                patch.object(snapshot, "quiet_database"),
                patch.object(snapshot, "dump", side_effect=dumps),
            ):
                with self.assertRaises(ValueError):
                    snapshot.backup(self.root, self.key, self.archive)
            self.assertFalse(self.archive.exists())

    def test_private_paths_required(self):
        public = self.root / "public"
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        with self.assertRaises(ValueError):
            snapshot.private_parent(public / "archive")
        with self.assertRaises(ValueError):
            snapshot.private_parent(snapshot.REPOSITORY_ROOT / "archive")

    def test_modified_wrong_key_and_compose_payload_fail_before_docker(self):
        raw = snapshot.storage.seal(payload(), b"a" * 64)
        for bad in (
            raw[:-1] + bytes([raw[-1] ^ 1]),
            snapshot.storage.seal(payload(), b"b" * 64),
            snapshot.storage.seal({"version": 1, "files": {}}, b"a" * 64),
        ):
            self.archive.write_bytes(bad)
            self.archive.chmod(0o600)
            with patch.object(snapshot.storage, "run") as run, self.assertRaises(ValueError):
                snapshot.verify(self.archive, self.key)
            run.assert_not_called()
        with self.assertRaises((KeyError, ValueError)):
            snapshot.storage.unseal(raw, b"a" * 64)

    def test_archive_symlink_and_shared_permissions_are_rejected(self):
        self.archive.symlink_to(self.key)
        with self.assertRaises(OSError):
            snapshot.verify(self.archive, self.key)
        self.archive.unlink()
        self.archive.write_bytes(b"fixture")
        self.archive.chmod(0o644)
        with self.assertRaises(ValueError):
            snapshot.verify(self.archive, self.key)

    def test_verify_uses_new_isolated_database_and_cleans_up_on_failure(self):
        snapshot.storage.exclusive(self.archive, b"mock-encrypted")
        for failure in (
            None,
            "version",
            "nonempty",
            "counts",
            "dump",
            "import",
            "cleanup",
            "links",
        ):
            events = []

            def run(args, events=events, failure=failure, **kwargs):
                events.append((args, kwargs))
                if args[:2] == ["docker", "create"]:
                    return IDENTITY.encode()
                if args[:2] == ["docker", "rm"] and failure == "cleanup":
                    raise snapshot.storage.SnapshotError("cleanup failed")
                return b""

            def query(command, sql, failure=failure):
                if sql == "SELECT VERSION();":
                    return "8.4.0" if failure == "version" else "8.4.8"
                if sql == "SHOW TABLES;":
                    return "exists" if failure == "nonempty" else ""
                self.assertEqual(sql, SQL)
                if failure == "import":
                    raise snapshot.storage.SnapshotError("import failed")
                return ""

            with (
                self.subTest(failure=failure),
                patch.object(snapshot.storage, "open_payload", return_value=payload()),
                patch.object(snapshot.storage, "run", side_effect=run),
                patch.object(snapshot, "query", side_effect=query) as queries,
                patch.object(
                    snapshot, "inventory", return_value={} if failure == "counts" else COUNTS
                ),
                patch.object(
                    snapshot, "dump", return_value="changed" if failure == "dump" else SQL
                ),
            ):
                if failure:
                    with self.assertRaises(ValueError):
                        if failure == "links":
                            with snapshot.restored_database(payload()):
                                raise ValueError("mismatched completed evaluation")
                        else:
                            snapshot.verify(self.archive, self.key)
                else:
                    result = snapshot.verify(self.archive, self.key)
                    self.assertTrue(result["restore_verified"])
                    self.assertFalse(result["full_backup_verified"])
                if failure in {"version", "nonempty"}:
                    self.assertFalse(any(call.args[1] == SQL for call in queries.call_args_list))
            create, kwargs = next(event for event in events if event[0][:2] == ["docker", "create"])
            self.assertIn("--network=none", create)
            self.assertIn("--pull=never", create)
            self.assertIn("--event-scheduler=OFF", create)
            self.assertNotIn(kwargs["env"]["MYSQL_ROOT_PASSWORD"], " ".join(create))
            self.assertFalse({"--publish", "--mount", "-v", "--volume"} & set(create))
            self.assertEqual(events[-1][0], ["docker", "rm", "--force", "--volumes", IDENTITY])


@unittest.skipUnless(
    os.environ.get("OPS_DB_SNAPSHOT_MYSQL_IMAGE"), "Real MySQL fixture is enabled explicitly in CI"
)
class MySQLRestoreTests(unittest.TestCase):
    def test_real_mysql_utf8_json_fk_dump_survives_encryption_and_restore(self):
        image = os.environ["OPS_DB_SNAPSHOT_MYSQL_IMAGE"]
        snapshot.validate(payload() | {"mysql_image": image})
        identity = (
            snapshot.storage.run(
                [
                    "docker",
                    "create",
                    "--pull=never",
                    "--network=none",
                    "--memory=512m",
                    "--pids-limit=128",
                    "--tmpfs=/var/lib/mysql:rw,nosuid,size=384m",
                    "--env",
                    "MYSQL_ROOT_PASSWORD",
                    "--env",
                    "MYSQL_DATABASE=govbiz_ops",
                    image,
                    "--mysqlx=0",
                    "--performance-schema=OFF",
                    "--innodb-buffer-pool-size=64M",
                    "--skip-log-bin",
                ],
                env={**os.environ, "MYSQL_ROOT_PASSWORD": secrets.token_hex(32)},
            )
            .decode()
            .strip()
        )
        self.assertRegex(identity, r"^[a-f0-9]{64}$")
        try:
            snapshot.storage.run(["docker", "start", identity])
            command = ["docker", "exec", "-i", identity, *snapshot.storage.AUTH]
            deadline = time.monotonic() + 90
            while True:
                try:
                    version = snapshot.query(command, "SELECT VERSION();")
                    break
                except snapshot.storage.SnapshotError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(1)
            snapshot.query(
                command,
                """
CREATE TABLE django_migrations (id int PRIMARY KEY, name varchar(255)) CHARACTER SET utf8mb4;
CREATE TABLE auth_user (id int PRIMARY KEY, username varchar(255)) CHARACTER SET utf8mb4;
CREATE TABLE evaluations_evaluationrun (id int PRIMARY KEY, user_id int, detail json,
  ended_at datetime NULL, status varchar(32), FOREIGN KEY (user_id) REFERENCES auth_user(id));
CREATE TABLE evaluations_evaluationbudgetreservation (id int PRIMARY KEY, run_id int,
  closed_at datetime NULL, FOREIGN KEY (run_id) REFERENCES evaluations_evaluationrun(id));
INSERT INTO django_migrations VALUES (1,'0017_input_token_budget');
INSERT INTO auth_user VALUES (1,'복원 🧪 따옴표 ''');
INSERT INTO evaluations_evaluationrun VALUES
  (1,1,JSON_OBJECT('한글',JSON_ARRAY('🧪',NULL)),NULL,'COMPLETED');
INSERT INTO evaluations_evaluationbudgetreservation VALUES (1,1,'2026-10-05 00:00:00');
""",
            )
            counts = snapshot.inventory(command)
            snapshot.quiet_database(command, counts)
            sql = snapshot.dump(command)
            data = snapshot.validate(
                payload()
                | {
                    "mysql_image": image,
                    "mysql_version": version,
                    "sql": sql,
                    "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                    "table_counts": counts,
                }
            )
            with tempfile.TemporaryDirectory(prefix="ops-db-real-test-") as directory:
                root = Path(directory)
                key = secrets.token_hex(32).encode()
                snapshot.storage.exclusive(root / "key", key)
                snapshot.storage.exclusive(root / "backup.enc", snapshot.storage.seal(data, key))
                result = snapshot.verify(root / "backup.enc", root / "key")
                self.assertEqual(result["status"], "VERIFIED")
                self.assertTrue(result["cleanup_complete"])
                self.assertFalse(result["full_backup_verified"])
            self.assertEqual(snapshot.dump(command), sql)
            # The new GitOps gate is read against real MySQL only in this disposable fixture.
            snapshot.query(
                command,
                "CREATE TABLE evaluations_evaluationadmission "
                "(id bigint PRIMARY KEY, accepting bool NOT NULL, version bigint NOT NULL);",
            )
            with self.assertRaises(ValueError):
                snapshot.paused_admission_version(command)
            snapshot.query(command, "INSERT INTO evaluations_evaluationadmission VALUES (1, 1, 8);")
            with self.assertRaises(ValueError):
                snapshot.paused_admission_version(command)
            snapshot.query(
                command,
                "UPDATE evaluations_evaluationadmission SET accepting=0, version=9 WHERE id=1;",
            )
            self.assertEqual(snapshot.paused_admission_version(command), 9)
        finally:
            snapshot.storage.run(["docker", "rm", "--force", "--volumes", identity])


if __name__ == "__main__":
    unittest.main()
