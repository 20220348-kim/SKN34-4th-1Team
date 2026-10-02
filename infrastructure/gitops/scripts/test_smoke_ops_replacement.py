"""Replacement must use owned volumes, change the real address and fail closed."""

import copy
import json
import subprocess
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

import ops_bridge
import smoke_ops_evaluation as evaluation
import smoke_ops_replacement as smoke

PROJECT = "govbiz-bridge-smoke-0123456789"
RUN_ID = "8f54ebfc-8692-4f71-836e-8ad9debce471"
SETTINGS = {"cluster": PROJECT, "namespace": "govbiz-msa", "stateId": "a" * 32}
NETWORK = "fixture-network"
OLD = {
    "prefect": {
        "id": "p-old",
        "image": "p-image",
        "volume": PROJECT + "_prefect-data",
        "address": "172.28.0.2",
    },
    "ops-artifacts": {
        "id": "a-old",
        "image": "a-image",
        "volume": PROJECT + "_ops-results",
        "address": "172.28.0.3",
    },
}
NEW = {
    "prefect": {**OLD["prefect"], "id": "p-new"},
    "ops-artifacts": {**OLD["ops-artifacts"], "id": "a-new", "address": "172.28.0.4"},
}


def topology(endpoints):
    return {
        "networkId": NETWORK,
        "subnets": ["172.28.0.0/16"],
        "nodeId": "node",
        "nodeConnected": True,
        "containers": {name: item["id"] for name, item in endpoints.items()},
        "addresses": {name: item["address"] for name, item in endpoints.items()},
    }


class ContainerOwnershipTests(unittest.TestCase):
    def info(self):
        return {
            "Id": "a-old",
            "Image": "a-image",
            "Running": True,
            "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": "ops-artifacts",
            },
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": PROJECT + "_ops-results",
                    "Destination": "/results",
                    "RW": False,
                }
            ],
            "Networks": {NETWORK: {"NetworkID": NETWORK, "IPAddress": "172.28.0.3"}},
        }

    def test_returns_only_identity_image_volume_address(self):
        with patch.object(
            smoke, "execute", return_value=json.dumps(self.info())
        ) as command:
            self.assertEqual(
                smoke.container("a-old", PROJECT, "ops-artifacts", NETWORK, NETWORK),
                OLD["ops-artifacts"],
            )
        self.assertNotIn("Config.Env", str(command.call_args))

    def test_foreign_stopped_oneoff_or_wrong_volume_cannot_be_replaced(self):
        for mutate in (
            lambda x: x.update(Running=False),
            lambda x: x["Labels"].update(
                {"com.docker.compose.project": "user-project"}
            ),
            lambda x: x["Labels"].update({"com.docker.compose.service": "database"}),
            lambda x: x["Labels"].update({"com.docker.compose.oneoff": "True"}),
            lambda x: x["Mounts"][0].update(Name="user-data"),
            lambda x: x["Mounts"][0].update(Type="bind"),
            lambda x: x["Mounts"][0].update(RW=True),
            lambda x: x["Networks"][NETWORK].update(NetworkID="other"),
        ):
            info = self.info()
            mutate(info)
            with (
                patch.object(smoke, "execute", return_value=json.dumps(info)),
                self.assertRaises(AssertionError),
            ):
                smoke.container("a-old", PROJECT, "ops-artifacts", NETWORK, NETWORK)


class ReplacementTests(unittest.TestCase):
    def exercise(self, *, new=None, identities="a-old\na-new"):
        changed = new or NEW
        returned = [
            OLD["prefect"],
            OLD["ops-artifacts"],
            changed["prefect"],
            changed["ops-artifacts"],
            OLD["ops-artifacts"],
        ]

        def execute(command, **kwargs):
            if command[-3:] == ["ps", "-q", "prefect"]:
                return "p-new"
            if command[-3:] == ["ps", "-q", "ops-artifacts"]:
                return (
                    "a-new"
                    if any(
                        call.args[0][:3] == ["docker", "rm", "--force"]
                        for call in run.call_args_list
                    )
                    else identities
                )
            return ""

        with (
            patch.object(smoke, "container", side_effect=returned),
            patch.object(smoke, "execute", side_effect=execute) as run,
        ):
            try:
                result = smoke.replace_endpoints(
                    ["docker", "compose"], {}, PROJECT, NETWORK, topology(OLD)
                )
            except AssertionError:
                self.assertFalse(
                    any(
                        call.args[0][:2] == ["docker", "rm"]
                        for call in run.call_args_list
                    )
                )
                raise
        self.assertEqual(result, (OLD, NEW))
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn(["docker", "rm", "--force", "a-old"], commands)
        self.assertTrue(
            any("--force-recreate" in cmd and cmd[-1] == "prefect" for cmd in commands)
        )
        self.assertTrue(
            any("--no-recreate" in cmd and "ops-artifacts=2" in cmd for cmd in commands)
        )
        self.assertFalse(any("--volumes" in cmd or "-v" in cmd for cmd in commands))
        return result

    def test_force_recreates_prefect_and_removes_only_verified_old_artifact(self):
        self.exercise()

    def test_same_address_image_drift_volume_change_or_unchanged_id_blocks_removal(
        self,
    ):
        for service, key, value in (
            ("ops-artifacts", "address", OLD["ops-artifacts"]["address"]),
            ("ops-artifacts", "image", "different-image"),
            ("ops-artifacts", "volume", "different-volume"),
            ("prefect", "id", OLD["prefect"]["id"]),
        ):
            changed = copy.deepcopy(NEW)
            changed[service][key] = value
            with self.assertRaises(AssertionError):
                self.exercise(new=changed)

    def test_unexpected_replica_set_blocks_removal(self):
        for identities in ("a-old", "foreign\na-new", "a-old\na-new\nthird"):
            with self.assertRaises(AssertionError):
                self.exercise(identities=identities)


class RouteRecoveryTests(unittest.TestCase):
    def exercise(
        self,
        *,
        stale_error="address changed",
        changed_service=False,
        repair_on_check=False,
    ):
        report = {"compose_project": PROJECT}
        old_routes = {
            (item["kind"], item["metadata"]["name"]): item
            for item in ops_bridge.manifests(
                SETTINGS, PROJECT, topology(OLD)["addresses"]
            )
        }
        if repair_on_check:
            old_routes[("EndpointSlice", "ops-compose-artifacts")]["endpoints"][0][
                "addresses"
            ] = ["172.28.0.4"]
        identities = {
            "ops-compose-prefect": {"uid": "p-service", "cluster_ip": "10.96.0.1"},
            "ops-compose-artifacts": {"uid": "a-service", "cluster_ip": "10.96.0.2"},
        }
        with (
            patch.object(
                smoke.fork_cluster, "commands", return_value=([], ["kubectl"], [])
            ),
            patch.object(smoke.artifacts, "require_disposable"),
            patch.object(
                smoke.ops_bridge,
                "connect",
                side_effect=[
                    None,
                    ValueError(stale_error) if stale_error else None,
                    None,
                    None,
                ],
            ) as connect,
            patch.object(
                smoke.ops_bridge, "topology", side_effect=[topology(OLD), topology(NEW)]
            ),
            patch.object(smoke, "replace_endpoints", return_value=(OLD, NEW)),
            patch.object(
                smoke,
                "service_identities",
                side_effect=[identities, {} if changed_service else identities],
            ),
            patch.object(
                smoke.ops_bridge, "existing_resources", return_value=old_routes
            ),
            patch.object(smoke, "wait_runtime", return_value={"status": "PASS"}),
            patch.object(smoke.fork_web, "forwards", return_value=nullcontext()),
            patch.object(
                smoke.artifacts,
                "check_access",
                return_value={"report_http_status": 200},
            ),
        ):
            smoke.verify(
                Path("state"),
                SETTINGS,
                [],
                {},
                "password",
                {"id": RUN_ID},
                "a" * 64,
                report,
            )
        self.assertEqual(
            [call.kwargs.get("check", False) for call in connect.call_args_list],
            [True, True, False, True],
        )
        return report

    def test_route_recovery_still_requires_new_evaluation_before_pass(self):
        report = self.exercise()
        evidence = report["replacement_recovery"]
        self.assertTrue(evidence["routes_recovered"])
        self.assertTrue(evidence["artifact_address_changed"])
        self.assertTrue(evidence["volumes_preserved"])
        self.assertEqual(evidence["status"], "FAIL")

    def test_unrelated_errors_and_missing_stale_detection_do_not_pass(self):
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.exercise(stale_error="ownership")
        with self.assertRaisesRegex(AssertionError, "not rejected"):
            self.exercise(stale_error=None)

    def test_service_replacement_or_mutating_read_only_check_is_rejected(self):
        for kwargs in ({"changed_service": True}, {"repair_on_check": True}):
            with self.assertRaises(AssertionError):
                self.exercise(**kwargs)

    def test_readiness_retries_are_bounded_and_require_http_result_verification(self):
        value = {
            "status": "PASS",
            "storage_transport": "http",
            "result_artifact_verified": True,
            "checks": {"result_artifact": "PASS"},
        }
        with (
            patch.object(
                smoke,
                "execute",
                side_effect=[
                    subprocess.CalledProcessError(1, ["probe"]),
                    json.dumps(value),
                ],
            ),
            patch.object(smoke.time, "monotonic", side_effect=[0, 1]),
            patch.object(smoke.time, "sleep"),
        ):
            self.assertEqual(smoke.wait_runtime(["kubectl"], RUN_ID), value)
        with (
            patch.object(
                smoke,
                "execute",
                side_effect=subprocess.CalledProcessError(1, ["probe"]),
            ),
            patch.object(smoke.time, "monotonic", side_effect=[0, 121]),
            self.assertRaises(TimeoutError),
        ):
            smoke.wait_runtime(["kubectl"], RUN_ID)
        with (
            patch.object(
                smoke,
                "execute",
                return_value=json.dumps({**value, "result_artifact_verified": False}),
            ),
            self.assertRaises(AssertionError),
        ):
            smoke.wait_runtime(["kubectl"], RUN_ID)


class FreeEvaluationTests(unittest.TestCase):
    def rag_result(self):
        return {
            "status": "COMPLETED",
            "model_api_calls": 0,
            "case_count": 3,
            "comparison": "self-replay",
            "rag_replay": {
                "scope": "source-chunks-retrieval-answer",
                "measurement_kind": "synthetic-contract-check",
                "baseline_eligible": False,
                "live_execution_performed": False,
            },
        }

    def test_rag_replay_explicitly_selects_the_new_path_without_seeding_accounts(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "rag.json"
            result = self.rag_result()
            output.write_text(json.dumps(result))
            with patch.object(evaluation, "execute") as execute:
                self.assertEqual(
                    evaluation.free_evaluation(output, "secret", {}, rag_replay=True),
                    result,
                )
            command = execute.call_args.args[0]
            self.assertIn("--rag-replay", command)
            self.assertNotIn("--seed-dev-accounts", command)
            self.assertNotIn("secret", command)

    def test_fixed_context_or_quality_claim_cannot_pass_as_rag_replay(self):
        for mutate in (
            lambda x: x.update(case_count=6),
            lambda x: x.update(comparison="candidate-reference"),
            lambda x: x["rag_replay"].update(scope="fixed-answer-context-only"),
            lambda x: x["rag_replay"].update(
                measurement_kind="integration-stub-replay"
            ),
            lambda x: x["rag_replay"].update(baseline_eligible=True),
            lambda x: x["rag_replay"].update(live_execution_performed=True),
        ):
            result = self.rag_result()
            mutate(result)
            with tempfile.TemporaryDirectory() as temp:
                output = Path(temp) / "rag.json"
                output.write_text(json.dumps(result))
                with (
                    patch.object(evaluation, "execute"),
                    self.assertRaises(AssertionError),
                ):
                    evaluation.free_evaluation(output, "secret", {}, rag_replay=True)

    def test_only_initial_evaluation_seeds_accounts_and_password_is_not_an_argument(
        self,
    ):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "result.json"
            output.write_text(json.dumps({"status": "COMPLETED", "model_api_calls": 0}))
            for seed in (True, False):
                with patch.object(evaluation, "execute") as execute:
                    evaluation.free_evaluation(
                        output, "private-password", {"PATH": "fixture"}, seed=seed
                    )
                command = execute.call_args.args[0]
                self.assertEqual("--seed-dev-accounts" in command, seed)
                self.assertNotIn("--rag-replay", command)
                self.assertNotIn("private-password", str(command))
                self.assertEqual(
                    execute.call_args.kwargs["env"]["CORE_ADMIN_PASSWORD"],
                    "private-password",
                )
                self.assertIn("http", command)

    def test_failed_or_paid_result_is_not_successful_replacement_evaluation(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "result.json"
            for state, calls in (("FAILED", 0), ("COMPLETED", 1)):
                output.write_text(
                    json.dumps({"status": state, "model_api_calls": calls})
                )
                with (
                    patch.object(evaluation, "execute"),
                    self.assertRaises(AssertionError),
                ):
                    evaluation.free_evaluation(output, "password", {})


class EvaluationEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.result = {
            "request_id": RUN_ID,
            "status": "COMPLETED",
            "model_api_calls": 0,
            "prefect_flow_run_id": "flow",
            "execution_spec_sha256": "b" * 64,
        }
        self.record = {
            "run": {
                "id": RUN_ID,
                **{
                    key: value
                    for key, value in self.result.items()
                    if key != "request_id"
                },
            },
            "execution_release_sha256": "c" * 64,
        }
        self.flow = {"id": "flow", "state": "COMPLETED", "spec": "b" * 64}
        self.evidence = {
            "evaluation": self.result,
            "kubernetes_database": self.record,
            "request_flow_count": 1,
            "report_sha256": "d" * 64,
        }

    def test_records_correlated_database_single_flow_and_authenticated_report(self):
        with (
            patch.object(
                evaluation, "free_evaluation", return_value=self.result
            ) as replay,
            patch.object(evaluation, "database_record", return_value=self.record),
            patch.object(
                evaluation.smoke_ops_sync_recovery,
                "prefect_runs",
                return_value=[self.flow],
            ),
            patch.object(
                evaluation.smoke_ops_artifacts,
                "read_completed_report",
                return_value="d" * 64,
            ) as report,
        ):
            self.assertEqual(
                evaluation.rag_evaluation(["kubectl"], Path("rag.json"), "secret", {}),
                self.evidence,
            )
        self.assertTrue(replay.call_args.kwargs["rag_replay"])
        report.assert_called_once_with("secret", RUN_ID)

    def test_missing_duplicate_unfinished_or_mismatched_flow_is_rejected(self):
        for flows in (
            [],
            [self.flow, self.flow],
            [{**self.flow, "state": "RUNNING"}],
            [{**self.flow, "id": "wrong"}],
            [{**self.flow, "spec": "wrong"}],
        ):
            with (
                patch.object(evaluation, "database_record", return_value=self.record),
                patch.object(
                    evaluation.smoke_ops_sync_recovery,
                    "prefect_runs",
                    return_value=flows,
                ),
                self.assertRaises(AssertionError),
            ):
                evaluation.verify_execution_record(["kubectl"], self.result)

    def test_database_request_status_flow_spec_and_usage_must_match_http_result(self):
        for key, value in (
            ("id", "wrong"),
            ("status", "RUNNING"),
            ("prefect_flow_run_id", "wrong"),
            ("execution_spec_sha256", "wrong"),
            ("model_api_calls", 1),
        ):
            changed = copy.deepcopy(self.record)
            changed["run"][key] = value
            with (
                patch.object(evaluation, "database_record", return_value=changed),
                self.assertRaises(AssertionError),
            ):
                evaluation.verify_execution_record(["kubectl"], self.result)

    def test_restart_and_replacement_require_preserved_db_and_authenticated_hash(self):
        with (
            patch.object(evaluation, "database_record", return_value=self.record),
            patch.object(
                evaluation.smoke_ops_artifacts,
                "check_access",
                return_value={"report_http_status": 200},
            ) as access,
        ):
            self.assertEqual(
                evaluation.check_rag_preserved(["kubectl"], "secret", self.evidence),
                {"report_http_status": 200},
            )
        access.assert_called_once_with("secret", self.record["run"], "d" * 64)
        changed = {**self.record, "execution_release_sha256": "other-release"}
        with (
            patch.object(evaluation, "database_record", return_value=changed),
            self.assertRaises(AssertionError),
        ):
            evaluation.check_rag_preserved(["kubectl"], "secret", self.evidence)
        with (
            patch.object(evaluation, "database_record", return_value=self.record),
            patch.object(
                evaluation.smoke_ops_artifacts,
                "check_access",
                side_effect=AssertionError("report changed"),
            ),
            self.assertRaisesRegex(AssertionError, "report changed"),
        ):
            evaluation.check_rag_preserved(["kubectl"], "secret", self.evidence)


if __name__ == "__main__":
    unittest.main()
