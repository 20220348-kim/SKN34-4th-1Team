"""Paused first rollout contracts, failure journals and opt-in real image/Compose checks."""

import base64
import copy
import hashlib
import json
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import ops_initial_runtime as rollout

REQUEST = "a89c84d3-e23a-440f-a74a-ce2ab9c628fc"
IMAGE = "sha256:" + "b" * 64
RUNNER = "sha256:" + "c" * 64
TAG = "govbiz-ops-service:initial-runtime"
SETTINGS = {
    "stateId": "d" * 32,
    "repository": "alice/project",
    "cluster": "fixture",
    "namespace": "govbiz-msa",
}
PROJECT = "fixture-project"


def container(name):
    runner = name == "evaluation-runner"
    networks = {PROJECT + "_default": {"NetworkID": "network"}}
    mounts = [
        {
            "Type": "volume",
            "Name": PROJECT + "_ops-results",
            "Destination": "/results",
            "RW": runner,
        }
    ]
    if not runner:
        networks[rollout.runtime.ops_bridge.network_name(SETTINGS)] = {
            "NetworkID": "network"
        }
        mounts.append(
            {
                "Type": "bind",
                "Destination": "/evaluation-data",
                "RW": False,
                "Source": str(
                    rollout.database.REPOSITORY_ROOT
                    / "evaluation/support-program-evidence"
                ),
            }
        )
    return {
        "Id": ("e" if runner else "f") * 64,
        "Image": IMAGE,
        "State": {"Running": not runner},
        "Config": {
            "User": "10001:10001",
            "Entrypoint": None,
            "WorkingDir": "/app/backend/ai-service" if runner else "/app",
            "Cmd": [
                ".venv/bin/python",
                "/app/evaluation/support-program-evidence/ops_flow.py",
            ]
            if runner
            else [
                "gunicorn",
                "apps.evaluations.artifact_server:create_app()",
                "--bind",
                "0.0.0.0:8010",
            ],
            "Env": [
                "LLMOPS_LIVE_ENABLED=false",
                "OPENAI_API_KEY=",
                "LLMOPS_ARTIFACT_TOKEN=private$token",
                "PATH=/image/default",
            ],
            "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": name,
                "com.docker.compose.oneoff": "False",
            },
        },
        "HostConfig": {
            "Init": True,
            "ReadonlyRootfs": not runner,
            "RestartPolicy": {"Name": "unless-stopped"},
        },
        "Mounts": mounts,
        "NetworkSettings": {"Networks": networks},
    }


def inspected_resource(arguments):
    if arguments[1] == "image":
        return [{"Id": IMAGE, "Config": {"Env": ["PATH=/image/default"]}}]
    if arguments[1] == "network":
        return [{"Id": "network", "Labels": {"com.docker.compose.project": PROJECT}}]
    return [
        {
            "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.volume": "ops-results",
            }
        }
    ]


class ComposeTests(unittest.TestCase):
    def setUp(self):
        self.items = {name: container(name) for name in rollout.SERVICES}
        self.images = {"ops-artifacts": IMAGE, "evaluation-runner": RUNNER}

    def definition(self):
        with patch.object(
            rollout.database, "read_json", side_effect=inspected_resource
        ):
            return rollout.compose_definition(
                SETTINGS, PROJECT, self.items, self.images
            )

    def test_only_two_services_reuse_external_stores_and_networks(self):
        result = self.definition()
        self.assertEqual(set(result["services"]), set(rollout.SERVICES))
        self.assertEqual(
            result["volumes"]["ops-results"],
            {"external": True, "name": PROJECT + "_ops-results"},
        )
        self.assertTrue(all(value["external"] for value in result["networks"].values()))
        self.assertTrue(result["services"]["ops-artifacts"]["volumes"][0]["read_only"])
        self.assertFalse(
            result["services"]["evaluation-runner"]["volumes"][0]["read_only"]
        )
        for service in result["services"].values():
            self.assertNotIn("depends_on", service)
            self.assertNotIn("build", service)
            self.assertNotIn("ports", service)
            self.assertNotIn("PATH", service["environment"])
            self.assertEqual(
                service["environment"]["LLMOPS_ARTIFACT_TOKEN"], "private$token"
            )
        env = result["services"]["evaluation-runner"]["environment"]
        self.assertTrue(all(env[name] == "false" for name in rollout.storage.FLAGS))
        self.assertEqual(env["OPENAI_API_KEY"], "")

    def test_free_flags_foreign_routes_ports_commands_and_mounts_are_rejected(self):
        for change in (
            lambda row: row["Config"]["Env"].append("LLMOPS_SCHEDULES_ENABLED=true"),
            lambda row: row["Config"]["Env"].append("OPENAI_API_KEY=private"),
            lambda row: row["HostConfig"].update(Privileged=True),
            lambda row: row["HostConfig"].update(PortBindings={"8000/tcp": []}),
            lambda row: row["Config"].update(Cmd=["sh", "-c", "unreviewed"]),
            lambda row: row["Mounts"][0].update(Name="foreign-results"),
            lambda row: row["NetworkSettings"]["Networks"].update(
                foreign={"NetworkID": "network"}
            ),
            lambda row: row["Config"]["Labels"].update(
                {"com.docker.compose.project": "foreign"}
            ),
        ):
            with self.subTest(change=change):
                self.items = {name: container(name) for name in rollout.SERVICES}
                change(self.items["evaluation-runner"])
                with self.assertRaises(ValueError):
                    self.definition()

    def test_stopped_endpoint_without_network_id_is_supported_but_running_mismatch_is_not(
        self,
    ):
        self.items["evaluation-runner"]["NetworkSettings"]["Networks"][
            PROJECT + "_default"
        ]["NetworkID"] = ""
        self.definition()
        self.items["evaluation-runner"]["State"]["Running"] = True
        with self.assertRaises(ValueError):
            self.definition()

    def test_interpolation_changes_cannot_reach_compose_up(self):
        definition = self.definition()
        self.assertIn("private$$token", json.dumps(rollout.compose_input(definition)))
        with patch.object(
            rollout.storage,
            "run",
            return_value=json.dumps(rollout.compose_input(definition)).encode(),
        ):
            rollout.verify_compose_input(definition)
        resolved = copy.deepcopy(definition)
        resolved["services"]["ops-artifacts"]["environment"][
            "LLMOPS_ARTIFACT_TOKEN"
        ] = "changed"
        with (
            patch.object(
                rollout.storage, "run", return_value=json.dumps(resolved).encode()
            ),
            self.assertRaises(ValueError),
        ):
            rollout.verify_compose_input(definition)

    def test_desktop_path_requires_exact_same_directory_and_never_mounts_reported_path(
        self,
    ):
        translated = (
            "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/" + "9" * 64
        )
        self.items["ops-artifacts"]["Mounts"][1]["Source"] = translated
        with patch.object(
            rollout.storage, "run", side_effect=[b"[114,1234]", b"[114,1234]"]
        ) as run:
            self.definition()
        probe = run.call_args_list[0].args[0]
        self.assertIn("--network=none", probe)
        self.assertIn("--read-only", probe)
        self.assertFalse(any(translated in str(arg) for arg in probe))
        for values in ([b"[114,1234]", b"[114,9999]"], [b"[]", b"[]"]):
            with (
                patch.object(rollout.storage, "run", side_effect=values),
                self.assertRaises(ValueError),
            ):
                self.definition()
        self.items["ops-artifacts"]["Mounts"][1]["Source"] = "/etc"
        with patch.object(rollout.storage, "run") as run, self.assertRaises(ValueError):
            self.definition()
        run.assert_not_called()


class EvidenceTests(unittest.TestCase):
    def test_only_private_completed_migration_record_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            journal = state / "ops-initial-migrations" / (REQUEST + ".json")
            record = {
                "schema_version": 1,
                "scope": "ops_initial_migration",
                "status": "MIGRATED_PAUSED",
                "stage": "completed",
                "state_id": SETTINGS["stateId"],
                "pause": {"request_id": REQUEST},
                "original_database_migration_attempted": True,
                "admission_paused": True,
                "writers_resumed": False,
                "frozen_source": {},
                "deployment_spec_sha256": "c" * 64,
            }
            rollout.cluster.write_json(journal, record)
            # ACL/uid semantics are POSIX; unit fixture keeps the logical validator portable.
            info = SimpleNamespace(st_mode=0o100600, st_uid=1000, st_nlink=1)
            with (
                patch.object(Path, "lstat", return_value=info),
                patch.object(rollout.os, "getuid", return_value=1000, create=True),
            ):
                self.assertEqual(
                    rollout.read_migration(state, REQUEST, SETTINGS), record
                )
                for key, invalid in (
                    ("status", "FAILED"),
                    ("stage", "migration"),
                    ("state_id", "other"),
                    ("admission_paused", False),
                    ("writers_resumed", True),
                    ("deployment_spec_sha256", ""),
                ):
                    journal.write_text(json.dumps({**record, key: invalid}))
                    with self.subTest(key=key), self.assertRaises(ValueError):
                        rollout.read_migration(state, REQUEST, SETTINGS)
                journal.write_text(json.dumps(record))
                for name, value in (
                    ("st_mode", 0o100644),
                    ("st_mode", 0o120600),
                    ("st_uid", 1001),
                    ("st_nlink", 2),
                ):
                    changed = {**vars(info), name: value}
                    with (
                        patch.object(
                            Path, "lstat", return_value=SimpleNamespace(**changed)
                        ),
                        self.assertRaises(ValueError),
                    ):
                        rollout.read_migration(state, REQUEST, SETTINGS)

    def test_successful_job_must_match_image_command_and_pause_identity(self):
        record = {
            "target_image": TAG,
            "pause": {"request_id": REQUEST, "actor": "운영자", "reason": "전환"},
        }
        job = {
            "metadata": {},
            "status": {
                "succeeded": 1,
                "conditions": [{"type": "Complete", "status": "True"}],
            },
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "image": TAG,
                                "command": [
                                    "python",
                                    "manage.py",
                                    "migrate_deployment",
                                ],
                                "args": [
                                    "--verbosity=0",
                                    "--pause-request-id=" + REQUEST,
                                    "--pause-actor=운영자",
                                    "--pause-reason=전환",
                                ],
                            }
                        ]
                    }
                }
            },
        }
        with patch.object(rollout.database, "read_json", return_value=job):
            rollout.require_completed_job(["kubectl"], record)
        for change in (
            lambda value: value["metadata"].update(deletionTimestamp="now"),
            lambda value: value["status"].update(succeeded=0),
            lambda value: value["status"].update(conditions=[]),
            lambda value: value["spec"]["template"]["spec"]["containers"][0].update(
                image="old"
            ),
            lambda value: value["spec"]["template"]["spec"]["containers"][0].update(
                args=[]
            ),
        ):
            changed = copy.deepcopy(job)
            change(changed)
            with (
                patch.object(rollout.database, "read_json", return_value=changed),
                self.assertRaises(ValueError),
            ):
                rollout.require_completed_job(["kubectl"], record)

    def test_loaded_image_requires_matching_state_host_and_kind(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            ledger = {
                **SETTINGS,
                "images": {TAG: {"dockerId": IMAGE, "criId": "kind-id"}},
            }
            path = state / "loaded-images.json"
            path.write_text(json.dumps(ledger))
            record = {"target_image": TAG, "target_image_id": IMAGE}
            with (
                patch.object(
                    rollout.cluster, "node_image_id", return_value="kind-id"
                ) as node,
                patch.object(
                    rollout.database, "read_json", return_value=[{"Id": IMAGE}]
                ) as host,
            ):
                rollout.require_loaded_image(state, SETTINGS, record)
                node.return_value = "changed"
                with self.assertRaises(ValueError):
                    rollout.require_loaded_image(state, SETTINGS, record)
                node.return_value = "kind-id"
                host.return_value = [{"Id": RUNNER}]
                with self.assertRaises(ValueError):
                    rollout.require_loaded_image(state, SETTINGS, record)
                host.return_value = [{"Id": IMAGE}]
                path.write_text(json.dumps({**ledger, "stateId": "other"}))
                with self.assertRaises(ValueError):
                    rollout.require_loaded_image(state, SETTINGS, record)


class RolloutTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.state = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.baseline = {
            "source": "local",
            "images": {
                "ops-service": "govbiz-ops-service:old",
                "core-service": "unchanged",
            },
        }
        (self.state / "baseline.json").write_text(json.dumps(self.baseline))
        self.deployment = {
            "metadata": {"uid": "deployment", "resourceVersion": "1"},
            "spec": {
                "replicas": 0,
                "template": {
                    "spec": {
                        "containers": [
                            {"name": name, "image": "govbiz-ops-service:old"}
                            for name in ("ops-service", "ops-sync")
                        ]
                    }
                },
            },
        }
        self.items = {name: container(name) for name in rollout.SERVICES}
        self.source = {
            "compose_project": PROJECT,
            "writers": {
                "e" * 64: {"service": "evaluation-runner"},
                "a" * 64: {"service": "prefect"},
                "0" * 64: {"service": "ops-service"},
            },
        }
        self.record = {
            "source_sha": "a" * 40,
            "source_branch": "topic",
            "frozen_source": self.source,
            "deployment_spec_sha256": hashlib.sha256(
                json.dumps(self.deployment["spec"], sort_keys=True).encode()
            ).hexdigest(),
            "target_image": TAG,
            "target_image_id": IMAGE,
            "pause": {"request_id": REQUEST, "actor": "운영자", "reason": "전환"},
        }
        self.args = SimpleNamespace(
            state_dir=self.state,
            migration_request_id=REQUEST,
            runner_image=RUNNER,
            execute=False,
        )
        self.calls = []
        self.mocks = {}

        def mock(owner, name, **kwargs):
            value = self.stack.enter_context(patch.object(owner, name, **kwargs))
            self.mocks[name] = value
            return value

        mock(rollout.database, "load_settings", return_value=SETTINGS)
        mock(rollout, "read_migration", return_value=self.record)
        mock(rollout.initial, "source_evidence", return_value=[{"runId": 1}])
        mock(rollout.database, "frozen_source", return_value=(["kubectl"], self.source))
        mock(rollout, "require_completed_job")
        mock(rollout, "require_loaded_image")
        mock(rollout, "require_same_database")
        mock(rollout.initial, "verify_pause")
        mock(rollout.database, "quiet_database")
        mock(rollout.database, "inventory", return_value={"fixture": 1})
        mock(
            rollout,
            "image_release",
            side_effect=lambda image, **kwargs: {
                "image_id": RUNNER if kwargs.get("runner") else IMAGE,
                "release_sha256": "c" * 64,
            },
        )
        mock(
            rollout,
            "service_container",
            side_effect=lambda project, name: self.items[name],
        )
        self.definition = {
            "name": PROJECT,
            "services": {
                name: {"image": RUNNER if name == "evaluation-runner" else IMAGE}
                for name in rollout.SERVICES
            },
        }
        mock(rollout, "compose_definition", return_value=self.definition)
        mock(rollout, "verify_compose_input")
        mock(rollout, "wait_healthy")
        mock(rollout.runtime.ops_bridge, "connect")
        mock(rollout.runtime, "verify_artifact_token")
        mock(rollout.runtime, "verify_release", return_value={"imageId": IMAGE})
        mock(rollout.runtime, "check_runtime")
        mock(rollout.runtime, "upgrade_preflight", return_value={"status": "PASS"})
        mock(rollout.storage, "inspect", return_value={"State": {"Running": False}})

        def read_json(arguments):
            if arguments[0] == "docker":
                return [{"Id": arguments[-1]}]
            if "secret" in arguments:
                return {
                    "data": {
                        "LLMOPS_ARTIFACT_TOKEN": base64.b64encode(
                            b"private$token"
                        ).decode()
                    }
                }
            return self.deployment

        mock(rollout.database, "read_json", side_effect=read_json)
        mock(rollout.storage, "run", side_effect=self.execute)

    def execute(self, command, **kwargs):
        self.calls.append((command, kwargs))
        journal = json.loads(self.journal().read_text())
        self.assertEqual(journal["status"], "RUNNING")
        self.assertIn("RUNNING", journal["stages"].values())
        if "compose" in command:
            name = command[-1]
            self.items[name] = copy.deepcopy(self.items[name])
            self.items[name]["Image"] = self.definition["services"][name]["image"]
            self.items[name]["State"]["Running"] = True
        return b""

    def journal(self):
        return self.state / "ops-initial-rollouts" / (REQUEST + ".json")

    def test_default_checks_never_start_or_replace_any_component(self):
        result = rollout.rollout(self.args)
        self.assertEqual(result["status"], "VERIFIED_FOR_ROLLOUT")
        self.assertEqual(self.calls, [])
        self.assertFalse(self.journal().exists())
        self.mocks["connect"].assert_not_called()

    def test_order_credentials_volumes_and_admission_stay_explicit(self):
        self.args.execute = True
        result = rollout.rollout(self.args)
        self.assertEqual(result["status"], "ROLLED_OUT_PAUSED")
        self.assertFalse(result["admission_resumed"])
        self.assertFalse(result["evaluation_executed"])
        self.assertEqual(self.calls[0][0], ["docker", "start", "a" * 64])
        self.assertEqual(
            [cmd[-1] for cmd, _ in self.calls if "compose" in cmd],
            list(rollout.SERVICES),
        )
        for cmd, _ in self.calls:
            self.assertNotIn("down", cmd)
            self.assertNotIn("--remove-orphans", cmd)
            if "compose" in cmd:
                self.assertIn("--no-deps", cmd)
                self.assertIn("--no-build", cmd)
                self.assertIn("never", cmd)
        patch_data = next(
            json.loads(kw["data"]) for cmd, kw in self.calls if "patch" in cmd
        )
        self.assertEqual(
            patch_data[0],
            {"op": "test", "path": "/metadata/uid", "value": "deployment"},
        )
        self.assertFalse(any("env" in row["path"] for row in patch_data))
        self.mocks["check_runtime"].assert_called_once_with(
            self.state, SETTINGS, expected_image=TAG
        )
        baseline = json.loads((self.state / "baseline.json").read_text())
        self.assertEqual(
            baseline["images"], {"ops-service": TAG, "core-service": "unchanged"}
        )
        self.assertNotIn("private$token", self.journal().read_text())

    def test_every_partial_failure_preserves_original_baseline_and_records_stage(self):
        self.args.execute = True
        self.mocks["wait_healthy"].side_effect = ValueError("private-credential")
        with self.assertRaises(ValueError):
            rollout.rollout(self.args)
        result = json.loads(self.journal().read_text())
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["stages"]["prefect_health"], "RUNNING")
        self.assertNotIn("private-credential", self.journal().read_text())
        self.assertEqual(
            json.loads((self.state / "baseline.json").read_text()), self.baseline
        )
        self.assertEqual(len(self.calls), 1)

    def test_runtime_failure_does_not_resume_admission_or_record_baseline(self):
        self.args.execute = True
        self.mocks["check_runtime"].side_effect = ValueError("runtime failure")
        with self.assertRaises(ValueError):
            rollout.rollout(self.args)
        result = json.loads(self.journal().read_text())
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["stages"]["runtime_check"], "RUNNING")
        self.assertFalse(result["admission_resumed"])
        self.assertEqual(
            json.loads((self.state / "baseline.json").read_text()), self.baseline
        )

    def test_ci_or_pause_or_loaded_image_failure_prevents_mutation(self):
        self.args.execute = True
        for name in (
            "source_evidence",
            "verify_pause",
            "require_loaded_image",
            "require_completed_job",
        ):
            with self.subTest(name=name):
                self.mocks[name].side_effect = ValueError("blocked")
                with self.assertRaises(ValueError):
                    rollout.rollout(self.args)
                self.mocks[name].side_effect = None
                self.assertEqual(self.calls, [])

    def test_existing_attempt_is_not_retried_or_overwritten(self):
        self.args.execute = True
        rollout.cluster.write_json(self.journal(), {"status": "RUNNING"})
        with self.assertRaisesRegex(ValueError, "no automatic retry"):
            rollout.rollout(self.args)
        self.assertEqual(self.calls, [])
        self.assertEqual(json.loads(self.journal().read_text()), {"status": "RUNNING"})

    def test_concurrent_deployment_edit_blocks_activation_after_compose_replacement(
        self,
    ):
        self.args.execute = True
        original_read = self.mocks["read_json"].side_effect
        reads = 0

        def changed_read(command):
            nonlocal reads
            value = original_read(command)
            if "deployment" in command:
                reads += 1
                if reads == 2:
                    value = copy.deepcopy(value)
                    value["metadata"]["resourceVersion"] = "new-edit"
            return value

        self.mocks["read_json"].side_effect = changed_read
        with self.assertRaisesRegex(ValueError, "Deployment changed"):
            rollout.rollout(self.args)
        self.assertFalse(any("patch" in command for command, _ in self.calls))
        result = json.loads(self.journal().read_text())
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["stages"]["evaluation-runner_replace"], "COMPLETED")
        self.assertEqual(
            json.loads((self.state / "baseline.json").read_text()), self.baseline
        )


@unittest.skipUnless(
    os.environ.get("OPS_INITIAL_RUNTIME_OPS_IMAGE")
    and os.environ.get("OPS_INITIAL_RUNTIME_RUNNER_IMAGE"),
    "Explicit immutable local fixture images required",
)
class DockerTests(unittest.TestCase):
    def test_images_match_source_and_compose_preserves_literal_credentials(self):
        ops = rollout.image_release(os.environ["OPS_INITIAL_RUNTIME_OPS_IMAGE"])
        runner = rollout.image_release(
            os.environ["OPS_INITIAL_RUNTIME_RUNNER_IMAGE"], runner=True
        )
        self.assertEqual(ops["release_sha256"], runner["release_sha256"])
        items = {name: container(name) for name in rollout.SERVICES}
        with patch.object(
            rollout.database, "read_json", side_effect=inspected_resource
        ):
            definition = rollout.compose_definition(
                SETTINGS,
                PROJECT,
                items,
                {"ops-artifacts": IMAGE, "evaluation-runner": RUNNER},
            )
        rollout.verify_compose_input(definition)

    def test_compose_container_receives_exact_literal_environment(self):
        literal = "synthetic$token${UNSET_RUNTIME_TEST}$$"
        definition = {
            "services": {
                "literal": {
                    "image": os.environ["OPS_INITIAL_RUNTIME_OPS_IMAGE"],
                    "network_mode": "none",
                    "read_only": True,
                    "cap_drop": ["ALL"],
                    "security_opt": ["no-new-privileges:true"],
                    "environment": {"LITERAL": literal},
                    "entrypoint": [
                        "python",
                        "-B",
                        "-c",
                        "import os;print(os.environ['LITERAL'])",
                    ],
                }
            }
        }
        result = rollout.storage.run(
            [
                "docker",
                "compose",
                "--env-file",
                "/dev/null",
                "--project-name",
                "ops-runtime-literal-" + uuid4().hex[:12],
                "-f",
                "-",
                "run",
                "--rm",
                "--no-deps",
                "-T",
                "literal",
            ],
            data=json.dumps(rollout.compose_input(definition)).encode(),
        )
        self.assertEqual(result.decode().strip(), literal)


if __name__ == "__main__":
    unittest.main()
