"""Pod readiness must not hide stopped Compose dependencies or stale routes."""

import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import ops_status as status
from ops_runtime import connection

SETTINGS = {
    "mode": "dev",
    "stateId": "a" * 32,
    "repository": "alice/project",
    "namespace": "govbiz-msa",
    "cluster": "govbiz-owned",
}
PROJECT = "govbiz-preview"


def container(service="prefect"):
    return {
        "id": "b" * 64,
        "project": PROJECT,
        "service": service,
        "oneoff": "False",
        "state": "running",
        "running": True,
        "paused": False,
        "restarting": False,
        "restart_count": 2,
        "started_at": "2026-10-04T00:00:00.123456789Z",
        "health": None,
    }


class ContainerTests(unittest.TestCase):
    def inspect(self, value):
        with patch.object(status, "run", side_effect=["b" * 64, json.dumps(value)]):
            return status.container_status(PROJECT, "prefect")

    def test_only_whitelisted_metadata_is_requested_and_historical_restarts_are_not_failures(
        self,
    ):
        value = {**container(), "env": "DO-NOT-PRINT"}
        with patch.object(
            status, "run", side_effect=["b" * 64, json.dumps(value)]
        ) as run:
            result = status.container_status(PROJECT, "prefect")
        self.assertTrue(result["ready"])
        self.assertEqual(result["restart_count"], 2)
        self.assertIsNone(result["health"])
        self.assertNotIn("DO-NOT-PRINT", json.dumps(result))
        self.assertIn("--all", run.call_args_list[0].args[0])
        self.assertIn("--no-trunc", run.call_args_list[0].args[0])
        for call in run.call_args_list:
            command = call.args[0]
            self.assertEqual(call.kwargs, {"capture": True, "timeout": 15})
            self.assertNotIn(".Config.Env", " ".join(command))
            self.assertNotIn(".State.Error", " ".join(command))
            self.assertNotIn(".Health.Log", " ".join(command))
            self.assertFalse(
                set(command) & {"exec", "start", "stop", "restart", "logs", "rm"}
            )

    def test_stopped_paused_restarting_unhealthy_or_starting_cannot_pass(self):
        for change in (
            {"state": "exited", "running": False},
            {"paused": True},
            {"restarting": True},
            {"health": "starting"},
            {"health": "unhealthy"},
        ):
            with self.subTest(change=change):
                self.assertFalse(self.inspect({**container(), **change})["ready"])

    def test_missing_or_ambiguous_service_does_not_inspect_an_arbitrary_container(self):
        for ids, code in (("", "CONTAINER_MISSING"), ("a\nb", "CONTAINER_AMBIGUOUS")):
            with patch.object(status, "run", return_value=ids) as run:
                result = status.container_status(PROJECT, "prefect")
            self.assertEqual(result["issues"], [code])
            self.assertEqual(run.call_count, 1)

    def test_changed_ownership_invalid_shape_and_untrusted_metadata_are_redacted(self):
        for key, value in (
            ("id", "c" * 64),
            ("project", "other"),
            ("service", "other"),
            ("oneoff", "True"),
            ("oneoff", None),
            ("state", "PRIVATE"),
            ("running", 1),
            ("restart_count", -1),
            ("restart_count", True),
            ("started_at", "PRIVATE"),
            ("health", "PRIVATE"),
        ):
            with self.subTest(key=key):
                result = self.inspect({**container(), key: value})
                self.assertEqual(result["issues"], ["CONTAINER_INSPECTION_FAILED"])
                self.assertNotIn("PRIVATE", json.dumps(result))

    def test_command_errors_timeout_and_malformed_json_are_not_success(self):
        for error in (
            OSError("PRIVATE"),
            subprocess.TimeoutExpired("docker", 15, output="PRIVATE"),
            subprocess.CalledProcessError(1, "docker", stderr="PRIVATE"),
        ):
            with patch.object(status, "run", side_effect=error):
                result = status.container_status(PROJECT, "prefect")
            self.assertEqual(result["issues"], ["CONTAINER_INSPECTION_FAILED"])
            self.assertNotIn("PRIVATE", json.dumps(result))
        with patch.object(status, "run", side_effect=["b" * 64, "PRIVATE"]):
            self.assertFalse(status.container_status(PROJECT, "prefect")["ready"])


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        for name in (status.PROFILE, status.BRIDGE):
            (self.state / name).write_text(json.dumps(connection(SETTINGS, PROJECT)))
        self.observations = [
            {
                "service": name,
                "ready": True,
                "issues": [],
                "id": str(index) * 64,
                "restart_count": 0,
            }
            for index, name in enumerate(status.SERVICES)
        ]

    def test_ready_containers_and_stable_owned_routes_are_required_without_http_claim(
        self,
    ):
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        with (
            patch.object(
                status, "container_status", side_effect=self.observations * 2
            ) as inspect,
            patch.object(
                status.ops_bridge,
                "connect",
                side_effect=lambda *a, **k: print("PRIVATE"),
            ) as bridge,
            patch("sys.stdout", new_callable=io.StringIO) as output,
        ):
            report = status.snapshot(self.state, SETTINGS)
        self.assertEqual(report["status"], "PASS")
        self.assertTrue(report["bridge_verified"])
        self.assertFalse(
            report["application_paths_verified"] or report["evaluation_executed"]
        )
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(inspect.call_count, 6)
        bridge.assert_called_once_with(self.state, SETTINGS, PROJECT, check=True)
        self.assertEqual(
            before, {path.name: path.read_bytes() for path in self.state.iterdir()}
        )

    def test_missing_or_different_activation_records_prevent_any_docker_access(self):
        (self.state / status.PROFILE).unlink()
        for mode in ("dev", "gitops"):
            with (
                patch.object(status, "container_status") as inspect,
                patch.object(status.ops_bridge, "connect") as bridge,
            ):
                report = status.snapshot(self.state, {**SETTINGS, "mode": mode})
            self.assertEqual(report["status"], "UNKNOWN")
            inspect.assert_not_called()
            bridge.assert_not_called()
        (self.state / status.PROFILE).write_text(
            json.dumps(connection(SETTINGS, "other"))
        )
        with patch.object(status, "container_status") as inspect:
            self.assertEqual(status.snapshot(self.state, SETTINGS)["status"], "UNKNOWN")
        inspect.assert_not_called()

    def test_gitops_uses_owned_connection_and_read_only_bridge_without_http_claim(self):
        settings = {**SETTINGS, "mode": "gitops"}
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        with (
            patch.object(status, "container_status", side_effect=self.observations * 2),
            patch.object(status.ops_bridge, "connect") as bridge,
        ):
            report = status.snapshot(self.state, settings)
        self.assertEqual(report["status"], "PASS")
        self.assertTrue(report["bridge_verified"])
        self.assertFalse(report["application_paths_verified"])
        self.assertFalse(report["evaluation_executed"])
        bridge.assert_called_once_with(self.state, settings, PROJECT, check=True)
        self.assertEqual(
            before, {path.name: path.read_bytes() for path in self.state.iterdir()}
        )

    def test_gitops_foreign_records_and_unknown_modes_prevent_docker_access(self):
        for field in ("repository", "stateId", "namespace"):
            with (
                self.subTest(field=field),
                patch.object(status, "container_status") as inspect,
                patch.object(status.ops_bridge, "connect") as bridge,
            ):
                report = status.snapshot(
                    self.state, {**SETTINGS, "mode": "gitops", field: "other"}
                )
            self.assertEqual(
                report["issues"], ["CONNECTION_RECORD_INVALID_OR_MISSING"]
            )
            inspect.assert_not_called()
            bridge.assert_not_called()
        with (
            patch.object(status, "container_status") as inspect,
            patch.object(status.ops_bridge, "connect") as bridge,
        ):
            report = status.snapshot(self.state, {**SETTINGS, "mode": "unknown"})
        self.assertEqual(report["status"], "UNKNOWN")
        self.assertEqual(report["issues"], ["UNSUPPORTED_MODE"])
        inspect.assert_not_called()
        bridge.assert_not_called()

    def test_gitops_bridge_failure_is_redacted_and_cannot_pass(self):
        with (
            patch.object(status, "container_status", side_effect=self.observations),
            patch.object(
                status.ops_bridge, "connect", side_effect=ValueError("PRIVATE")
            ),
        ):
            report = status.snapshot(self.state, {**SETTINGS, "mode": "gitops"})
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["issues"], ["BRIDGE_CHECK_FAILED"])
        self.assertFalse(report["bridge_verified"])
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_one_stopped_service_still_reports_all_components_and_does_not_claim_routes(
        self,
    ):
        self.observations[0].update(ready=False, issues=["CONTAINER_NOT_RUNNING"])
        with (
            patch.object(status, "container_status", side_effect=self.observations),
            patch.object(status.ops_bridge, "connect") as bridge,
        ):
            report = status.snapshot(self.state, SETTINGS)
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(len(report["containers"]), 3)
        self.assertFalse(report["bridge_verified"])
        bridge.assert_not_called()

    def test_stale_routes_or_private_subprocess_error_are_reported_without_raw_output(
        self,
    ):
        with (
            patch.object(status, "container_status", side_effect=self.observations),
            patch.object(
                status.ops_bridge, "connect", side_effect=ValueError("PRIVATE")
            ),
        ):
            report = status.snapshot(self.state, SETTINGS)
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["issues"], ["BRIDGE_CHECK_FAILED"])
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_restart_or_replacement_during_route_check_does_not_pass(self):
        for change in ({"id": "f" * 64}, {"restart_count": 1}, {"ready": False}):
            after = [dict(item) for item in self.observations]
            after[2].update(change)
            with (
                patch.object(
                    status, "container_status", side_effect=self.observations + after
                ),
                patch.object(status.ops_bridge, "connect"),
            ):
                report = status.snapshot(self.state, SETTINGS)
            self.assertEqual(report["issues"], ["COMPOSE_CHANGED_DURING_CHECK"])
            self.assertFalse(report["bridge_verified"])


@unittest.skipUnless(
    os.environ.get("OPS_STATUS_DOCKER_IMAGE"),
    "Requires an explicit local Docker test image",
)
class DockerInspectionTests(unittest.TestCase):
    def test_real_docker_without_healthcheck_reports_created_and_running_states(self):
        project = "govbiz-status-" + uuid4().hex
        identity = None
        try:
            identity = status.run(
                [
                    "docker",
                    "create",
                    "--pull=never",
                    "--network=none",
                    "--read-only",
                    "--no-healthcheck",
                    "--user=10001",
                    "--cap-drop=ALL",
                    "--memory=128m",
                    "--pids-limit=32",
                    "--label",
                    "com.docker.compose.project=" + project,
                    "--label",
                    "com.docker.compose.service=prefect",
                    "--label",
                    "com.docker.compose.oneoff=False",
                    "--entrypoint=python",
                    os.environ["OPS_STATUS_DOCKER_IMAGE"],
                    "-B",
                    "-c",
                    "import time; time.sleep(90)",
                ],
                capture=True,
                timeout=15,
            ).strip()
            self.assertRegex(identity, r"^[a-f0-9]{64}$")
            created = status.container_status(project, "prefect")
            self.assertEqual(created["state"], "created")
            self.assertEqual(created["issues"], ["CONTAINER_NOT_RUNNING"])
            self.assertIsNone(created["health"])
            status.run(["docker", "start", identity], capture=True, timeout=15)
            running = status.container_status(project, "prefect")
            self.assertEqual(running["id"], identity)
            self.assertTrue(running["ready"])
            self.assertIsNone(running["health"])
        finally:
            if identity:
                status.run(
                    ["docker", "rm", "--force", identity], capture=True, timeout=15
                )


if __name__ == "__main__":
    unittest.main()
