"""Read-only maintenance inventory and exact resume scope without a live cluster."""

import copy
import io
import json
import subprocess
import unittest
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import ops_maintenance_plan as maintenance
import test_ops_db_snapshot as db_tests


def preflight():
    return {
        "schemaVersion": 4,
        "scope": "ops_upgrade_preflight",
        "status": "BLOCKED",
        "reason": "admission_control_unsupported",
        "admission_supported": False,
        "admission_blocked": False,
        "backup_verified": False,
        "evaluation_executed": False,
        "checks": {
            "unsettled_evaluations": 0,
            "open_reservations": 0,
            "unfinished_flows": 0,
            "active_schedules": 0,
            "unpaused_ops_schedules": 0,
            "unsettled_schedule_occurrences": 0,
            "inspected_flows": 3,
            "open_admission": None,
        },
    }


class QuietTests(unittest.TestCase):
    def test_legacy_and_supported_paused_admission_can_be_inventoried(self):
        maintenance.require_quiet(preflight())
        current = preflight()
        current.update(
            status="PASS", admission_supported=True, admission_blocked=True, admission_version=2
        )
        current["checks"]["open_admission"] = 0
        maintenance.require_quiet(current)
        for change in (
            {"admission_blocked": False},
            {"admission_version": True},
            {"admission_version": 0},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                maintenance.require_quiet(current | change)

    def test_missing_unknown_or_outstanding_work_is_rejected(self):
        for value in (
            None,
            {},
            preflight() | {"checks": None},
            preflight() | {"status": "UNKNOWN"},
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                maintenance.require_quiet(value)
        for name in preflight()["checks"]:
            for value in (False, -1, "0", 1, None):
                if (name == "inspected_flows" and type(value) is int and value >= 0) or (
                    name == "open_admission" and value is None
                ):
                    continue
                result = preflight()
                result["checks"][name] = value
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    maintenance.require_quiet(result)
            result = preflight()
            del result["checks"][name]
            with self.subTest(missing=name), self.assertRaises(ValueError):
                maintenance.require_quiet(result)


class PlanTests(unittest.TestCase):
    def setUp(self):
        # Reuse the existing dedicated MySQL/Compose ownership fixture.
        db_tests.SourceTests.setUp(self)
        self.settings = db_tests.SETTINGS | {"mode": "dev"}
        self.load = self.stack.enter_context(
            patch.object(maintenance.database, "load_settings", return_value=self.settings)
        )
        self.probe = self.stack.enter_context(
            patch.object(maintenance.ops_runtime, "upgrade_preflight", return_value=preflight())
        )
        self.deployment["metadata"]["generation"] = 1
        self.deployment["spec"]["replicas"] = 1
        self.deployment["status"] = dict.fromkeys(
            (
                "replicas",
                "readyReplicas",
                "updatedReplicas",
                "availableReplicas",
                "observedGeneration",
            ),
            1,
        )
        for container in self.deployment["spec"]["template"]["spec"]["containers"]:
            container["image"] = "old-ops:fixture"
            container["env"].append({"name": "PRIVATE", "value": "do-not-disclose"})
        for writer in self.writers.values():
            writer["State"].update(Status="running", Running=True)
            writer["Config"]["Env"] = ["PRIVATE=do-not-disclose"]
        stopped = copy.deepcopy(self.writers["b" * 64])
        stopped["Id"] = "d" * 64
        stopped["Config"]["Labels"]["com.docker.compose.service"] = "ops-service"
        stopped["State"].update(Status="exited", Running=False)
        self.writers[stopped["Id"]] = stopped

    def enable_gitops(self):
        self.settings["mode"] = "gitops"
        self.deployment["kind"] = "Deployment"
        self.deployment["metadata"].update(
            name="ops-service",
            namespace=self.settings["namespace"],
            annotations={
                "argocd.argoproj.io/tracking-id": (
                    "govbiz-fork-ops-service:apps/Deployment:govbiz-msa/ops-service"
                )
            },
        )
        quiet = preflight() | {
            "status": "PASS",
            "admission_supported": True,
            "admission_blocked": True,
            "admission_version": 8,
        }
        quiet.pop("reason")
        quiet["checks"]["open_admission"] = 0
        self.probe.return_value = quiet
        self.argo = self.stack.enter_context(
            patch.object(
                maintenance,
                "argo_observation",
                return_value={
                    "projectUid": "project-uid",
                    "projectSpecSha256": "a" * 64,
                    "applications": {
                        "ops-service": {
                            "uid": "application-uid",
                            "sourceSha": "b" * 40,
                            "specSha256": "c" * 64,
                        }
                    },
                },
            )
        )

    def plan(self):
        return maintenance.plan(Path("fixture"))

    def test_exact_running_scope_preserves_stopped_services_and_private_values(self):
        report = self.plan()
        self.assertEqual(report["status"], "PLANNED")
        self.assertEqual(report["stop_order"], ["deployment/ops-service", "c" * 64, "b" * 64])
        self.assertEqual(report["resume_order"], ["b" * 64, "c" * 64, "deployment/ops-service"])
        self.assertEqual(report["leave_stopped"], ["d" * 64])
        self.assertEqual(report["database"]["pvc_uid"], "claim")
        self.assertNotIn("do-not-disclose", json.dumps(report))
        for field in ("services_changed", "backup_verified", "upgrade_allowed"):
            self.assertIs(report[field], False)
        for call in self.run.call_args_list:
            self.assertIn(call.args[0][:2], (["docker", "ps"], ["docker", "image"]))

    def test_unrelated_compose_services_are_not_stop_or_resume_targets(self):
        unrelated = self.writers.pop("d" * 64)
        unrelated["Config"]["Labels"]["com.docker.compose.service"] = "langfuse-worker"
        unrelated["State"].update(Status="running", Running=True)
        self.writers["d" * 64] = unrelated
        self.assertNotIn("d" * 64, self.plan()["writers"])

    def test_gitops_plan_requires_stable_manual_argo_and_retains_exact_resume_scope(
        self,
    ):
        self.enable_gitops()
        before = copy.deepcopy((self.settings, self.resources, self.writers))
        report = self.plan()
        self.assertEqual(report["status"], "PLANNED")
        self.assertEqual(report["argo_observation"], self.argo.return_value)
        self.assertEqual(self.argo.call_count, 2)
        maintenance.database.require_dev.assert_not_called()
        self.assertEqual(report["stop_order"], ["deployment/ops-service", "c" * 64, "b" * 64])
        self.assertEqual(report["leave_stopped"], ["d" * 64])
        self.assertEqual(before, (self.settings, self.resources, self.writers))
        self.assertNotIn("do-not-disclose", json.dumps(report))
        for key in ("services_changed", "backup_verified", "upgrade_allowed"):
            self.assertIs(report[key], False)
        for call in self.run.call_args_list:
            self.assertIn(call.args[0][:2], (["docker", "ps"], ["docker", "image"]))

    def test_gitops_owner_sync_or_late_argo_changes_reject_plan(self):
        self.enable_gitops()
        original = copy.deepcopy(self.argo.return_value)
        for observations in (
            [ValueError("wrong owner or active sync")],
            [original, ValueError("changed owner or active sync")],
            [original, original | {"projectUid": "replaced"}],
            [original, original | {"applications": {}}],
        ):
            self.argo.side_effect = observations
            with self.subTest(observations=observations), self.assertRaises(ValueError):
                self.plan()
        maintenance.database.require_dev.assert_not_called()

    def test_gitops_tracking_must_match_expected_application_and_resource(self):
        self.enable_gitops()
        baseline = copy.deepcopy(self.deployment)
        for change in (
            "missing",
            "foreign",
            "label",
            "hook",
            "name",
            "namespace",
            "kind",
        ):
            item = copy.deepcopy(baseline)
            if change == "missing":
                item["metadata"]["annotations"] = {}
            elif change == "foreign":
                item["metadata"]["annotations"]["argocd.argoproj.io/tracking-id"] = "other"
            elif change == "label":
                item["metadata"]["labels"] = {"argocd.argoproj.io/instance": "other"}
            elif change == "hook":
                item["metadata"]["annotations"]["argocd.argoproj.io/hook"] = "Sync"
            elif change == "kind":
                item["kind"] = "Job"
            else:
                item["metadata"][change] = "other"
            with self.subTest(change=change), self.assertRaises(ValueError):
                maintenance.deployment_record(item, gitops_namespace="govbiz-msa")

    def test_gitops_open_legacy_or_busy_admission_cannot_prepare_stop_plan(self):
        self.enable_gitops()
        original = copy.deepcopy(self.probe.return_value)
        for kind in ("open", "legacy", "busy", "unknown"):
            value = copy.deepcopy(original)
            if kind == "legacy":
                value = preflight()
            elif kind == "open":
                value.update(status="BLOCKED", reason="admission_open", admission_blocked=False)
                value["checks"]["open_admission"] = 1
            elif kind == "busy":
                value["checks"]["unfinished_flows"] = 1
            else:
                value["status"] = "UNKNOWN"
            self.probe.return_value = value
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.plan()
        self.run.assert_not_called()

    def test_gitops_inventory_does_not_allow_backup_of_running_ops(self):
        self.enable_gitops()
        with (
            patch.object(
                maintenance.database, "argo_observation", return_value=self.argo.return_value
            ),
            self.assertRaisesRegex(ValueError, "Stop the Kubernetes Ops"),
        ):
            maintenance.database.frozen_source(Path("fixture"), self.settings)
        self.run.assert_not_called()

    def test_admission_state_or_connection_change_during_inventory_is_rejected(self):
        self.enable_gitops()
        original = copy.deepcopy(self.probe.return_value)
        for change in ("admission", "work", "settings", "profile", "bridge", "hpa"):
            self.probe.side_effect = None
            self.load.side_effect = None
            self.connection.side_effect = None
            changed = copy.deepcopy(original)
            if change == "admission":
                changed["admission_version"] += 1
            elif change == "work":
                changed["checks"]["unfinished_flows"] = 1
            elif change == "settings":
                self.load.side_effect = [
                    self.settings,
                    self.settings | {"stateId": "replaced"},
                ]
            elif change in {"profile", "bridge"}:
                record = {"composeProject": "fixture"}
                self.connection.side_effect = [record, record] + (
                    [{"composeProject": "other"}]
                    if change == "profile"
                    else [record, {"composeProject": "other"}]
                )
            else:
                calls = 0

                def read(args):
                    nonlocal calls
                    resource = args[args.index("get") + 1]
                    if resource == "hpa":
                        calls += 1
                        if calls == 2:
                            return {
                                "items": [{"spec": {"scaleTargetRef": {"name": "ops-service"}}}]
                            }
                    return copy.deepcopy(self.resources[resource])

                with (
                    patch.object(maintenance.database, "read_json", side_effect=read),
                    self.assertRaises(ValueError),
                ):
                    self.plan()
                continue
            self.probe.side_effect = [original, changed]
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.plan()

    def test_only_preflight_observation_time_can_change(self):
        original = preflight()
        self.probe.side_effect = [
            original | {"started_at": "before-start", "checked_at": "before-end"},
            original | {"started_at": "after-start", "checked_at": "after-end"},
        ]
        self.assertEqual(self.plan()["status"], "PLANNED")

    def test_unavailable_exact_image_blocks_plan_without_a_pull(self):
        def run(args, **kwargs):
            if args[1] == "ps":
                return "\n".join(self.writers).encode()
            raise maintenance.database.storage.SnapshotError("private engine diagnostic")

        self.run.side_effect = run
        report = self.plan()
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["blockers"], ["source_mysql_image_not_available_or_unverified"])
        self.assertNotIn("private engine", json.dumps(report))

    def test_active_work_stops_inventory_before_resource_reads(self):
        value = preflight()
        value["checks"]["unfinished_flows"] = 1
        self.probe.return_value = value
        with self.assertRaises(ValueError):
            self.plan()
        self.run.assert_not_called()

    def test_foreign_or_changing_connection_is_rejected(self):
        self.connection.side_effect = [{"composeProject": "fixture"}, {"composeProject": "other"}]
        with self.assertRaises(ValueError):
            self.plan()
        self.probe.assert_not_called()

    def test_hpa_or_unready_database_is_rejected(self):
        self.resources["hpa"]["items"] = [{"spec": {"scaleTargetRef": {"name": "ops-service"}}}]
        with self.assertRaises(ValueError):
            self.plan()
        self.resources["hpa"]["items"] = []
        self.pod["status"]["containerStatuses"][0]["ready"] = False
        with self.assertRaises(ValueError):
            self.plan()

    def test_unstable_or_managed_deployment_and_wrong_database_are_rejected(self):
        baseline = copy.deepcopy(self.deployment)
        changes = (
            ("metadata", "deletionTimestamp", "now"),
            ("metadata", "annotations", {"argocd.argoproj.io/tracking-id": "managed"}),
            ("spec", "replicas", 2),
            ("status", "observedGeneration", 0),
            ("status", "readyReplicas", 0),
        )
        for section, key, value in changes:
            deployment = copy.deepcopy(baseline)
            deployment[section][key] = value
            with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                maintenance.deployment_record(deployment)
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        container["env"][0]["value"] = "other-db"
        with self.assertRaises(ValueError):
            self.plan()

    def test_restarting_duplicate_missing_and_foreign_writers_are_rejected(self):
        baseline = copy.deepcopy(self.writers)
        for change in ("restart", "duplicate", "missing", "foreign", "oneoff"):
            self.writers = copy.deepcopy(baseline)
            writer = self.writers["b" * 64]
            labels = writer["Config"]["Labels"]
            if change == "restart":
                writer["State"]["Restarting"] = True
            elif change == "duplicate":
                self.writers["d" * 64]["Config"]["Labels"]["com.docker.compose.service"] = "prefect"
            elif change == "missing":
                del self.writers["b" * 64]
            elif change == "foreign":
                labels["com.docker.compose.project"] = "other"
            else:
                labels["com.docker.compose.oneoff"] = "True"
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.plan()

    def test_deployment_mysql_restart_or_route_changes_during_inventory_fail(self):
        original = copy.deepcopy(self.resources)
        for change in ("deployment", "pod", "pvc"):
            self.resources = copy.deepcopy(original)
            real_inspect = maintenance.inspect_writers

            def inspect(project, real_inspect=real_inspect, change=change):
                value = real_inspect(project)
                if change == "pod":
                    self.resources["pod"]["status"]["containerStatuses"][0]["restartCount"] += 1
                else:
                    self.resources[change]["metadata"]["uid"] = "replacement"
                return value

            # Real kubectl responses are separate objects, not references to a mutable fixture.
            with (
                patch.object(
                    maintenance.database,
                    "read_json",
                    side_effect=lambda args: copy.deepcopy(
                        self.resources[args[args.index("get") + 1]]
                    ),
                ),
                patch.object(maintenance, "inspect_writers", side_effect=inspect),
                self.subTest(change=change),
                self.assertRaises(ValueError),
            ):
                self.plan()

    def test_preflight_diagnostics_do_not_break_json_output(self):
        def probe(*args):
            print("bridge observation")
            return preflight()

        self.probe.side_effect = probe
        output = io.StringIO()
        with redirect_stdout(output):
            self.plan()
        self.assertEqual(output.getvalue(), "")

    def test_cli_returns_failure_for_blocked_plan_or_redacted_exception(self):
        for value in (
            {"status": "BLOCKED"},
            ValueError("secret-diagnostic"),
            subprocess.TimeoutExpired(["kubectl", "secret-diagnostic"], 15),
            subprocess.CalledProcessError(
                1, ["kubectl", "secret-diagnostic"], output="secret-diagnostic"
            ),
        ):
            output, error = io.StringIO(), io.StringIO()
            with (
                patch("sys.argv", ["ops_maintenance_plan.py", "--state-dir", "fixture"]),
                patch.object(maintenance, "locked", return_value=nullcontext()),
                patch.object(
                    maintenance,
                    "plan",
                    **(
                        {"side_effect": value}
                        if isinstance(value, Exception)
                        else {"return_value": value}
                    ),
                ),
                redirect_stdout(output),
                redirect_stderr(error),
            ):
                self.assertEqual(maintenance.main(), 1)
            self.assertNotIn("secret-diagnostic", output.getvalue() + error.getvalue())


if __name__ == "__main__":
    unittest.main()
