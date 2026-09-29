"""Offline failure, restoration and false-positive guards for sync recovery."""

import copy
import json
import os
import subprocess
import sys
import unittest
from contextlib import contextmanager, nullcontext
from unittest.mock import Mock, patch
from uuid import UUID

import smoke_ops_sync_recovery as smoke

RUN_ID = "8f54ebfc-8692-4f71-836e-8ad9debce471"
FLOW_ID = "158770e0-5fd7-4515-b967-d8c1fdf8ebf5"
PROJECT = "govbiz-bridge-smoke-0123456789"
NK = ["kubectl", "--context", "kind-" + PROJECT, "-n", "govbiz-msa"]
FINGERPRINT = "a" * 64
ORIGINAL_HASH = "b" * 64


def run(**values):
    return {
        "id": RUN_ID,
        "execution_mode": "replay",
        "model_api_calls": 0,
        "execution_spec_sha256": FINGERPRINT,
        "status": "REQUESTED",
        "prefect_flow_run_id": None,
        "error_code": "PREFECT_DISPATCH_UNCONFIRMED",
        "error_message": "unconfirmed",
        "synced_at": None,
        "sync_attempted_at": "2026-09-30T00:00:00Z",
        "status_stale": True,
        "report_url": None,
        **values,
    }


class FaultRestorationTests(unittest.TestCase):
    def info(self):
        return {
            "Running": True,
            "Paused": False,
            "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": "prefect",
            },
        }

    def deployment(self):
        return {
            "metadata": {"uid": "owned"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {"name": "ops-service", "command": ["gunicorn"]},
                            {
                                "name": "ops-sync",
                                "command": [
                                    "python",
                                    "manage.py",
                                    "sync_evaluations",
                                    "--watch",
                                ],
                            },
                        ]
                    }
                }
            },
        }

    def test_only_our_running_unpaused_prefect_can_be_interrupted(self):
        for value in (
            {**self.info(), "Running": False},
            {**self.info(), "Paused": True},
            {
                **self.info(),
                "Labels": {
                    "com.docker.compose.project": "user-project",
                    "com.docker.compose.service": "prefect",
                },
            },
            {
                **self.info(),
                "Labels": {
                    "com.docker.compose.project": PROJECT,
                    "com.docker.compose.service": "evaluation-runner",
                },
            },
        ):
            with (
                patch.object(
                    smoke, "execute", side_effect=["identity", json.dumps(value)]
                ) as command,
                self.assertRaises(AssertionError),
                smoke.stopped_prefect(["docker", "compose"], {}, PROJECT),
            ):
                self.fail("must not pause")
            self.assertEqual(command.call_count, 2)

    def test_prefect_is_unpaused_by_identity_after_verification_failure(self):
        with (
            patch.object(
                smoke,
                "execute",
                side_effect=["identity", json.dumps(self.info()), "", ""],
            ) as command,
            self.assertRaisesRegex(RuntimeError, "verification"),
            smoke.stopped_prefect(["docker", "compose"], {}, PROJECT),
        ):
            raise RuntimeError("verification")
        self.assertEqual(
            command.call_args_list[-2].args[0], ["docker", "pause", "identity"]
        )
        self.assertEqual(
            command.call_args_list[-1].args[0], ["docker", "unpause", "identity"]
        )

    def test_unpause_failure_is_not_suppressed(self):
        with (
            patch.object(
                smoke,
                "execute",
                side_effect=[
                    "identity",
                    json.dumps(self.info()),
                    "",
                    RuntimeError("unpause"),
                ],
            ),
            self.assertRaisesRegex(RuntimeError, "unpause"),
            smoke.stopped_prefect(["docker", "compose"], {}, PROJECT),
        ):
            pass

    def test_sync_command_restored_on_rollout_failure_without_api_mutation(self):
        deployment = self.deployment()
        with (
            patch.object(
                smoke,
                "execute",
                side_effect=[
                    json.dumps(deployment),
                    "",
                    RuntimeError("rollout"),
                    "",
                    "",
                ],
            ) as command,
            self.assertRaisesRegex(RuntimeError, "rollout"),
            smoke.stopped_sync(NK),
        ):
            self.fail("rollout failed")
        patches = [
            json.loads(c.kwargs["data"])
            for c in command.call_args_list
            if "data" in c.kwargs
        ]
        self.assertEqual(len(patches), 2)
        for change in patches:
            self.assertEqual(
                change[0], {"op": "test", "path": "/metadata/uid", "value": "owned"}
            )
            self.assertEqual(
                change[2]["path"], "/spec/template/spec/containers/1/command"
            )
        self.assertEqual(patches[0][2]["value"], smoke.PAUSED_COMMAND)
        self.assertEqual(patches[1][1]["value"], smoke.PAUSED_COMMAND)
        self.assertEqual(
            patches[1][2]["value"],
            deployment["spec"]["template"]["spec"]["containers"][1]["command"],
        )

    @unittest.skipIf(os.name == "nt", "Linux container termination")
    def test_temporary_sync_command_exits_cleanly_on_sigterm(self):
        child = subprocess.Popen(
            [sys.executable, *smoke.PAUSED_COMMAND[1:]],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "sync stopped for smoke")
            child.terminate()
            _, errors = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0, errors)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)

    def test_unexpected_sync_command_is_not_replaced(self):
        deployment = self.deployment()
        deployment["spec"]["template"]["spec"]["containers"][1]["command"] = [
            "another-worker"
        ]
        with (
            patch.object(
                smoke, "execute", return_value=json.dumps(deployment)
            ) as command,
            self.assertRaises(AssertionError),
            smoke.stopped_sync(NK),
        ):
            self.fail("unexpected worker")
        self.assertEqual(command.call_count, 1)


class ObservationTests(unittest.TestCase):
    def test_lists_do_not_call_detail_or_accept_failed_or_paid_evaluations(self):
        for row, valid in (
            (run(), True),
            (run(status="FAILED"), False),
            (run(model_api_calls=1), False),
        ):
            with patch.object(
                smoke.artifacts,
                "response",
                return_value=(200, {}, json.dumps({"results": [row]}).encode()),
            ) as request:
                if valid:
                    self.assertEqual(smoke.list_run("client", RUN_ID), row)
                else:
                    with self.assertRaises(AssertionError):
                        smoke.list_run("client", RUN_ID)
            self.assertEqual(
                request.call_args.args[1], smoke.BASE + "/api/v1/ops/evaluations"
            )

    def test_post_preserves_request_identity_and_csrf_for_explicit_retry(self):
        payload = {"request_id": RUN_ID, "execution_mode": "replay"}
        with patch.object(
            smoke.artifacts,
            "response",
            return_value=(503, {}, json.dumps(run()).encode()),
        ) as request:
            status, _ = smoke.submit("client", "csrf-token", payload)
        self.assertEqual(status, 503)
        posted = request.call_args.args[1]
        self.assertEqual(json.loads(posted.data), payload)
        self.assertEqual(posted.get_header("X-csrftoken"), "csrf-token")
        self.assertTrue(request.call_args.kwargs["allow_error"])

    def test_wait_has_deadline_and_does_not_turn_noncompletion_into_success(self):
        with (
            patch.object(smoke.time, "monotonic", side_effect=[0, 1, 3]),
            patch.object(smoke.time, "sleep") as sleep,
            self.assertRaisesRegex(TimeoutError, "stale"),
        ):
            smoke.wait_for("stale", lambda: False, bool, timeout=2)
        sleep.assert_called_once_with(3)

    def test_wait_accepts_only_observed_completion(self):
        with patch.object(smoke.time, "sleep") as sleep:
            self.assertEqual(
                smoke.wait_for("done", lambda: {"state": "COMPLETED"}, bool),
                {"state": "COMPLETED"},
            )
        sleep.assert_not_called()

    def test_duplicate_wrong_request_and_failed_prefect_runs_are_rejected(self):
        row = {
            "id": FLOW_ID,
            "key": "ops-" + RUN_ID,
            "request_id": RUN_ID,
            "state": "COMPLETED",
            "spec": FINGERPRINT,
        }
        for rows in (
            [row, row],
            [{**row, "request_id": FLOW_ID}],
            [{**row, "key": "other"}],
            [{**row, "state": "FAILED"}],
        ):
            with (
                patch.object(smoke, "execute", return_value=json.dumps(rows)),
                self.assertRaises(AssertionError),
            ):
                smoke.prefect_runs(NK, RUN_ID)
        with patch.object(smoke, "execute", return_value=json.dumps([row])) as command:
            self.assertEqual(smoke.prefect_runs(NK, RUN_ID), [row])
            compile(command.call_args.kwargs["data"], "<prefect-reader>", "exec")

    def test_prefect_outage_does_not_allow_failed_liveness_or_artifact_checks(self):
        expected = {
            "status": "FAIL",
            "runner_liveness_verified": False,
            "checks": {
                "evidence": "PASS",
                "results_directory": "PASS",
                "prefect_deployment": "FAIL",
                "result_artifact": "NOT_CHECKED",
            },
        }
        replies = [
            (200, {}, b'{"status":"UP"}'),
            (200, {}, b'{"status":"UP"}'),
            (503, {}, json.dumps(expected).encode()),
        ]
        with patch.object(smoke.artifacts, "response", side_effect=replies):
            self.assertEqual(
                smoke.check_runtime("client", prefect_available=False)["http_status"],
                503,
            )
        broken = copy.deepcopy(expected)
        broken["checks"]["results_directory"] = "FAIL"
        with (
            patch.object(
                smoke.artifacts,
                "response",
                side_effect=replies[:2] + [(503, {}, json.dumps(broken).encode())],
            ),
            self.assertRaises(AssertionError),
        ):
            smoke.check_runtime("client", prefect_available=False)
        with (
            patch.object(
                smoke.artifacts,
                "response",
                return_value=(503, {}, b'{"status":"DOWN"}'),
            ),
            self.assertRaises(AssertionError),
        ):
            smoke.check_runtime("client", prefect_available=False)


class RecoverySequenceTests(unittest.TestCase):
    def exercise(
        self, report, *, corrupt_completion=False, changed_while_stopped=False
    ):
        outage = run(error_code="PREFECT_STATUS_UNAVAILABLE")
        recovered = run(sync_attempted_at="2026-09-30T00:00:11Z")
        queued = run(
            status="QUEUED",
            prefect_flow_run_id=FLOW_ID,
            error_code="",
            sync_attempted_at=recovered["sync_attempted_at"],
        )
        complete = {
            **queued,
            "status": "COMPLETED",
            "status_stale": False,
            "synced_at": "2026-09-30T00:00:40Z",
            "sync_attempted_at": "2026-09-30T00:00:40Z",
            "report_url": "/report",
            "execution_spec_sha256": "changed" if corrupt_completion else FINGERPRINT,
        }
        remote = [{"id": FLOW_ID, "state": "COMPLETED", "spec": FINGERPRINT}]
        events = []

        @contextmanager
        def interrupt(name):
            events.append(name + "-stop")
            try:
                yield
            finally:
                events.append(name + "-restore")

        with (
            patch.object(smoke.artifacts, "require_disposable"),
            patch.object(
                smoke.fork_web, "forwards", side_effect=lambda nk: nullcontext()
            ),
            patch.object(smoke, "session", return_value=(Mock(), "csrf", "profile")),
            patch.object(
                smoke, "stopped_prefect", side_effect=lambda *a: interrupt("prefect")
            ),
            patch.object(
                smoke, "stopped_sync", side_effect=lambda *a: interrupt("sync")
            ),
            patch.object(smoke, "uuid4", return_value=UUID(RUN_ID)),
            patch.object(
                smoke,
                "submit",
                side_effect=[(503, run()), (200, queued), (200, queued)],
            ) as submit,
            patch.object(
                smoke,
                "list_run",
                side_effect=[
                    outage,
                    recovered,
                    queued,
                    complete if changed_while_stopped else queued,
                    complete,
                ],
            ),
            patch.object(smoke, "prefect_runs", side_effect=[[], remote, remote]),
            patch.object(smoke, "check_runtime", return_value={"checked": True}),
            patch.object(smoke.artifacts, "completed_run", return_value=run()),
            patch.object(
                smoke.artifacts, "report_hash", side_effect=[ORIGINAL_HASH, "c" * 64]
            ),
        ):
            try:
                smoke.verify(
                    NK, [], {}, "password", {"id": RUN_ID}, ORIGINAL_HASH, report
                )
            finally:
                self.assertEqual(
                    events,
                    ["prefect-stop", "prefect-restore", "sync-stop", "sync-restore"],
                )
            self.assertEqual(submit.call_count, 3)
            self.assertEqual(
                len({call.args[2]["request_id"] for call in submit.call_args_list}), 1
            )

    def test_one_replay_recovers_only_after_explicit_dispatch_and_sync_restart(self):
        report = {"compose_project": PROJECT}
        self.exercise(report)
        evidence = report["sync_recovery"]
        self.assertEqual(evidence["status"], "PASS")
        self.assertEqual(evidence["automatic_dispatch_count"], 0)
        self.assertEqual(evidence["prefect_flow_count"], 1)
        self.assertEqual(evidence["model_api_calls"], 0)
        self.assertTrue(evidence["background_sync_without_detail"])
        self.assertTrue(evidence["sync_stopped"]["list_does_not_repair_state"])

    def test_changed_execution_spec_is_not_successful_recovery(self):
        report = {"compose_project": PROJECT}
        with self.assertRaises(AssertionError):
            self.exercise(report, corrupt_completion=True)
        self.assertEqual(report["sync_recovery"]["status"], "FAIL")
        self.assertEqual(report["evaluation_phase"], "sync_resumed")

    def test_updates_while_sync_is_stopped_are_not_accepted(self):
        report = {"compose_project": PROJECT}
        with self.assertRaises(AssertionError):
            self.exercise(report, changed_while_stopped=True)
        self.assertEqual(report["sync_recovery"]["status"], "FAIL")
        self.assertEqual(report["evaluation_phase"], "sync_stopped")


if __name__ == "__main__":
    unittest.main()
