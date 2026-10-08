"""Offline rendering and failure boundaries for the owned runtime CI fixture."""

import base64
import copy
import json
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import check_evaluation
import smoke_evaluation_runtime as smoke
import smoke_ops_evaluation as evaluation
import yaml

PROJECT = "govbiz-bridge-smoke-" + "a" * 10
ID = "11111111-1111-4111-8111-111111111111"
FLOW = "22222222-2222-4222-8222-222222222222"
IMAGE_ID = "sha256:" + "d" * 64
PREFECT_IMAGE = yaml.safe_load(smoke.pvc.PREFECT_VALUES.read_text(encoding="utf-8"))[
    "image"
]
EXPECTED = {
    ID: {"flow_id": FLOW, "execution_spec_sha256": "b" * 64, "report_sha256": "c" * 64}
}


class RuntimeTests(unittest.TestCase):
    def test_runtime_uses_deployment_resource_profiles_for_main_and_init_containers(
        self,
    ):
        images = {
            name: f"govbiz/{name}:{PROJECT}" for name in check_evaluation.COMPONENTS
        }
        images["prefect"] = PREFECT_IMAGE
        rows = check_evaluation.render_bundle(
            smoke.bundle(images, PROJECT + "-control-plane", "http://172.20.0.2:3000"),
            "govbiz-evaluation-restore-abc123",
        )
        defaults = yaml.safe_load(
            (check_evaluation.CHART / "values.yaml").read_text(encoding="utf-8")
        )
        for name, resources in rows.items():
            profile = yaml.safe_load(
                smoke.pvc.PREFECT_VALUES.with_name(name + ".yaml").read_text(
                    encoding="utf-8"
                )
            )
            expected = profile.get("resources", defaults["resources"])
            workload = next(row for row in resources if row["kind"] == "Deployment")
            pod = workload["spec"]["template"]["spec"]
            for container in pod["containers"] + pod.get("initContainers", []):
                with self.subTest(component=name, container=container["name"]):
                    self.assertEqual(container["resources"], expected)

    def test_real_chart_with_ci_images_is_free_and_uses_restored_claims(self):
        images = {
            name: f"govbiz/{name}:{PROJECT}" for name in check_evaluation.COMPONENTS
        }
        images["prefect"] = PREFECT_IMAGE
        rows = check_evaluation.render_bundle(
            smoke.bundle(images, PROJECT + "-control-plane", "http://172.20.0.2:3000"),
            "govbiz-evaluation-restore-abc123",
        )
        for name, resources in rows.items():
            workload = next(row for row in resources if row["kind"] == "Deployment")
            self.assertEqual(workload["spec"]["replicas"], 1)
            pod = workload["spec"]["template"]["spec"]
            container = pod["containers"][0]
            self.assertEqual(container["image"], images[name])
            self.assertEqual(container["imagePullPolicy"], "Never")
            claim = next(row for row in pod["volumes"] if row["name"] == "data")
            self.assertEqual(
                claim["persistentVolumeClaim"]["claimName"],
                "prefect" if name == "prefect" else "results",
            )
            if name == "evaluation-runner":
                env = {row["name"]: row.get("value") for row in container["env"]}
                self.assertEqual(env["OPENAI_API_KEY"], "")
                self.assertEqual(env["LLMOPS_LIVE_ENABLED"], "false")
                self.assertEqual(env["LLMOPS_RAG_LIVE_ENABLED"], "false")
            if name == "prefect":
                self.assertEqual(pod["initContainers"][0]["image"], PREFECT_IMAGE)
                self.assertEqual(pod["initContainers"][0]["imagePullPolicy"], "Never")
                env = {row["name"]: row["value"] for row in container["env"]}
                self.assertEqual(env["PREFECT_API_DATABASE_MIGRATE_ON_START"], "false")

    def test_personal_or_unverified_environment_is_rejected_before_io(self):
        for settings, report in (
            ({"cluster": "personal", "repository": "ilil1/SKN34-4th-1Team"}, {}),
            (
                {
                    "cluster": PROJECT,
                    "repository": "bridge-smoke/local",
                    "namespace": "govbiz-msa",
                },
                {"compose_project": PROJECT, "database_restore": {"status": "FAIL"}},
            ),
        ):
            with (
                self.subTest(settings=settings),
                patch.object(smoke, "execute") as command,
            ):
                with self.assertRaises(ValueError):
                    smoke.verify(
                        Path("."),
                        settings,
                        [],
                        {},
                        "kind",
                        "helm",
                        "secret",
                        {},
                        EXPECTED,
                        report,
                    )
                command.assert_not_called()
                self.assertEqual(
                    report["evaluation_kubernetes_runtime"]["status"], "FAIL"
                )

    def test_running_oom_or_unclean_sources_are_not_copied(self):
        base = {
            "Id": "a" * 64,
            "Image": IMAGE_ID,
            "State": {
                "Running": False,
                "OOMKilled": False,
                "Status": "exited",
                "ExitCode": 0,
            },
        }
        for change in (
            {"Running": True},
            {"OOMKilled": True},
            {"ExitCode": 137},
            {"Paused": True},
        ):
            row = copy.deepcopy(base)
            row["State"].update(change)
            with (
                self.subTest(change=change),
                patch.object(smoke, "execute", return_value="a" * 64),
                patch.object(smoke.volumes, "container", return_value=row),
                patch.object(smoke.snapshot, "volume_sources") as sources,
            ):
                with self.assertRaisesRegex(ValueError, "cleanly stopped"):
                    smoke.stopped_sources([], {}, PROJECT)
                sources.assert_not_called()

    def test_both_ops_containers_receive_new_routes_in_one_patch(self):
        with patch.object(smoke, "execute") as command:
            url = smoke.switch_ops(["kubectl"], "govbiz-evaluation-restore-test")
        change = json.loads(command.call_args_list[0].kwargs["data"])["spec"]
        self.assertEqual(change["replicas"], 1)
        containers = change["template"]["spec"]["containers"]
        self.assertEqual(
            {row["name"] for row in containers}, {"ops-service", "ops-sync"}
        )
        for row in containers:
            env = {item["name"]: item["value"] for item in row["env"]}
            self.assertEqual(env["LLMOPS_ARTIFACT_URL"], url)
            self.assertIn(
                "prefect.govbiz-evaluation-restore-test.svc.cluster.local",
                env["PREFECT_API_URL"],
            )
        self.assertNotIn("ops-compose", json.dumps(change))

    def core_restore_report(self):
        return {
            "core_auth_restore": {
                "status": "PASS",
                "scope": "disposable_core_database_and_fresh_session",
                "source_preserved": True,
                "cleanup_complete": True,
            }
        }

    def test_completed_core_backup_resumes_fixture_before_web_verification(self):
        deployment = {"metadata": {"resourceVersion": "123"}, "spec": {"replicas": 0}}
        with patch.object(
            smoke, "execute", side_effect=[json.dumps(deployment), "", ""]
        ) as command:
            result = smoke.resume_core(
                ["kubectl", "-n", "govbiz-msa"], self.core_restore_report()
            )
        self.assertEqual(
            result, {"status": "PASS", "previous_replicas": 0, "replicas": 1}
        )
        scale = command.call_args_list[1].args[0]
        self.assertIn("deployment/core-service", scale)
        self.assertIn("--current-replicas=0", scale)
        self.assertIn("--resource-version=123", scale)
        self.assertIn("--replicas=1", scale)
        self.assertEqual(
            command.call_args_list[2].args[0][-3:],
            ["status", "deployment/core-service", "--timeout=300s"],
        )

    def test_unverified_core_restore_cannot_resume_writers(self):
        for key, value in (
            ("status", "FAIL"),
            ("scope", "personal"),
            ("source_preserved", False),
            ("cleanup_complete", False),
        ):
            report = self.core_restore_report()
            report["core_auth_restore"][key] = value
            with self.subTest(key=key), patch.object(smoke, "execute") as command:
                with self.assertRaises(ValueError):
                    smoke.resume_core(["kubectl"], report)
                command.assert_not_called()

    def test_core_resume_rejects_changed_replica_state_and_propagates_rollout_failure(
        self,
    ):
        deployment = {"metadata": {"resourceVersion": "123"}, "spec": {"replicas": 1}}
        with patch.object(
            smoke, "execute", return_value=json.dumps(deployment)
        ) as command:
            with self.assertRaises(ValueError):
                smoke.resume_core(["kubectl"], self.core_restore_report())
            self.assertEqual(command.call_count, 1)
        deployment["spec"]["replicas"] = 0
        failure = subprocess.CalledProcessError(1, ["kubectl", "rollout"])
        with patch.object(
            smoke, "execute", side_effect=[json.dumps(deployment), "", failure]
        ):
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                smoke.resume_core(["kubectl"], self.core_restore_report())
            self.assertIs(caught.exception, failure)

    def test_report_hash_and_unique_flow_are_checked_after_restart(self):
        record = {
            "run": {
                "id": ID,
                "prefect_flow_run_id": FLOW,
                "execution_spec_sha256": "b" * 64,
            }
        }
        flows = [{"id": FLOW, "state": "COMPLETED", "spec": "b" * 64}]
        for bad in (None, "report", "duplicate", "flow", "spec"):
            rows = copy.deepcopy(flows)
            if bad == "duplicate":
                rows += copy.deepcopy(rows)
            if bad == "flow":
                rows[0]["id"] = ID
            if bad == "spec":
                rows[0]["spec"] = "e" * 64
            with (
                self.subTest(bad=bad),
                patch.object(
                    evaluation, "database_record", return_value=record
                ) as database,
                patch.object(smoke.sync, "prefect_runs", return_value=rows),
                patch.object(
                    smoke.artifacts,
                    "read_completed_report",
                    return_value="e" * 64 if bad == "report" else "c" * 64,
                ),
            ):
                if bad:
                    with self.assertRaises(ValueError):
                        smoke.preserved(
                            [], "secret", EXPECTED, "http://new-artifacts:8010"
                        )
                else:
                    self.assertEqual(
                        smoke.preserved(
                            [], "secret", EXPECTED, "http://new-artifacts:8010"
                        ),
                        {ID: record},
                    )
                    database.assert_called_once_with(
                        [], ID, artifact_url="http://new-artifacts:8010"
                    )

    def test_restart_requires_new_uid_and_same_image(self):
        before = {"uid": "old", "image_id": IMAGE_ID}
        for after in (
            before,
            {"uid": "new", "image_id": "other"},
            {**before, "uid": "new"},
        ):
            with (
                patch.object(smoke, "execute"),
                patch.object(smoke, "pod_identity", side_effect=[before, after]),
            ):
                if after["uid"] == "old" or after["image_id"] != IMAGE_ID:
                    with self.assertRaises(ValueError):
                        smoke.restart([], "prefect")
                else:
                    self.assertEqual(smoke.restart([], "prefect")["after"], after)

    def test_failed_rollout_preserves_safe_evidence_and_original_error(self):
        original = subprocess.CalledProcessError(
            1, ["kubectl", "rollout"], stderr="private-token"
        )
        calls = []

        def command(args, **kwargs):
            calls.append(args)
            if "rollout" in args:
                raise original
            if "pods" in args:
                return json.dumps(
                    {
                        "items": [
                            {
                                "metadata": {"name": "prefect-test"},
                                "spec": {"env": {"SECRET": "private-token"}},
                                "status": {
                                    "phase": "Running",
                                    "conditions": [
                                        {"type": "PodScheduled", "status": "True"}
                                    ],
                                    "initContainerStatuses": [
                                        {
                                            "name": "restored-prefect-database",
                                            "ready": True,
                                            "restartCount": 0,
                                            "state": {
                                                "terminated": {
                                                    "reason": "Completed",
                                                    "exitCode": 0,
                                                }
                                            },
                                        }
                                    ],
                                    "containerStatuses": [
                                        {
                                            "name": "prefect",
                                            "ready": False,
                                            "restartCount": 2,
                                            "state": {
                                                "waiting": {
                                                    "reason": "CrashLoopBackOff",
                                                    "message": "private-token",
                                                }
                                            },
                                            "lastState": {
                                                "terminated": {
                                                    "reason": "OOMKilled",
                                                    "exitCode": 137,
                                                    "message": "private-token",
                                                }
                                            },
                                        }
                                    ],
                                },
                            }
                        ]
                    }
                )
            if "events" in args:
                return json.dumps(
                    {
                        "items": [
                            {
                                "message": "probe failed: connection refused private-token"
                            }
                        ]
                    }
                )
            if "logs" in args:
                return (
                    "shutil.Error: private-token; Operation not permitted; "
                    "Read-only file system /private/path"
                )
            self.fail(args)

        evidence = {}
        with (
            patch.object(smoke, "execute", side_effect=command),
            self.assertRaises(subprocess.CalledProcessError) as caught,
        ):
            smoke.rollout(["kubectl", "-n", "owned-test"], "prefect", evidence)
        self.assertIs(caught.exception, original)
        report = evidence["rollout_failure"]
        self.assertEqual(report["component"], "prefect")
        self.assertEqual(report["pod_count"], 1)
        self.assertEqual(
            report["pods"][0]["containers"][1]["lastState"]["terminated"],
            {"reason": "OOMKilled", "exit_code": 137},
        )
        self.assertEqual(
            report["signals"],
            ["permission_denied", "probe_connection_refused", "read_only_filesystem"],
        )
        self.assertNotIn("private", json.dumps(report))
        self.assertTrue(any("--previous" in args for args in calls))
        self.assertTrue(
            all("--limit-bytes=16384" in args for args in calls if "logs" in args)
        )

    def test_unavailable_diagnostics_never_hide_rollout_failure(self):
        original = subprocess.TimeoutExpired(
            ["kubectl", "rollout"], 255, output="private-token"
        )

        def command(args, **kwargs):
            if "rollout" in args:
                raise original
            raise OSError("private-token")

        evidence = {}
        with (
            patch.object(smoke, "execute", side_effect=command),
            self.assertRaises(subprocess.TimeoutExpired) as caught,
        ):
            smoke.rollout(["kubectl"], "evaluation-runner", evidence, seconds=180)
        self.assertIs(caught.exception, original)
        self.assertEqual(
            evidence["rollout_failure"]["diagnostic_errors"],
            ["pod_events_unavailable", "pod_status_unavailable"],
        )
        self.assertNotIn("private-token", json.dumps(evidence))

    def test_successful_rollout_does_not_collect_logs_or_change_deadlines(self):
        evidence = {}
        with patch.object(smoke, "execute") as command:
            smoke.rollout(["kubectl"], "prefect", evidence)
        command.assert_called_once_with(
            ["kubectl", "rollout", "status", "deployment/prefect", "--timeout=240s"],
            timeout=255,
        )
        self.assertEqual(evidence, {})

    def test_malformed_diagnostics_preserve_the_original_failure(self):
        original = subprocess.CalledProcessError(1, ["kubectl", "rollout"])
        with (
            patch.object(
                smoke,
                "execute",
                side_effect=[original, '{"items":[null]}', '{"items":[null]}'],
            ),
            self.assertRaises(subprocess.CalledProcessError) as caught,
        ):
            report = {}
            smoke.rollout(["kubectl"], "prefect", report)
        self.assertIs(caught.exception, original)
        self.assertEqual(
            report["rollout_failure"]["diagnostic_errors"],
            ["pod_events_unavailable", "pod_status_unavailable"],
        )

    def test_runtime_is_mandatory_in_required_ci(self):
        workflow = yaml.safe_load(
            (smoke.REPOSITORY_ROOT / ".github/workflows/llmops-ci.yml").read_text(
                encoding="utf-8"
            )
        )
        checks = [
            step
            for step in workflow["jobs"]["integration"]["steps"]
            if "--evaluation-runtime" in step.get("run", "")
        ]
        self.assertEqual(len(checks), 1)
        self.assertNotIn("if", checks[0])
        self.assertNotIn("continue-on-error", checks[0])
        self.assertIn("--evaluate ", checks[0]["run"])
        self.assertEqual(workflow["jobs"]["merge-readiness"]["needs"], ["integration"])

    def deployment_failure(self, *, at_rollout=False, network_result=None):
        events = []
        settings = {
            "repository": "bridge-smoke/local",
            "cluster": PROJECT,
            "namespace": "govbiz-msa",
        }
        report = {
            "compose_project": PROJECT,
            "database_restore": {"status": "PASS"},
            "volume_restore": {"status": "PASS", "writers_stopped": True},
        }
        containers = {
            name: {"Id": "a" * 64, "Image": IMAGE_ID}
            for name in check_evaluation.COMPONENTS
        }

        @contextmanager
        def restored(*args):
            events.append("pvc-created")
            try:
                yield "govbiz-evaluation-restore-test", {"status": "VERIFIED"}
            finally:
                events.append("pvc-deleted")

        def command(args, *, data=None, **kwargs):
            if "get" in args:
                if "deployment" in args:
                    return json.dumps({"spec": {"replicas": 0}})
                if "pods" in args:
                    if "pvc-created" in events:
                        events.append("diagnosed")
                    return '{"items":[]}'
                if "events" in args:
                    return '{"items":[]}'
                if "secret" in args:
                    return json.dumps(
                        {
                            "data": {
                                "LLMOPS_ARTIFACT_TOKEN": base64.b64encode(
                                    b"token"
                                ).decode()
                            }
                        }
                    )
            if args[:3] == ["docker", "image", "inspect"]:
                return IMAGE_ID
            if args[:3] == ["docker", "image", "rm"]:
                events.append("tag-deleted")
            if at_rollout and "rollout" in args:
                raise subprocess.CalledProcessError(1, args, stderr="private-token")
            if not at_rollout and data and json.loads(data).get("kind") == "Deployment":
                raise ValueError("deployment failed")
            return ""

        env = {
            key: "token"
            for key in (
                "LLMOPS_ARTIFACT_TOKEN",
                "LLMOPS_BUDGET_TOKEN",
                "LANGFUSE_PUBLIC_KEY",
                "LANGFUSE_SECRET_KEY",
            )
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(smoke.fork_cluster, "require_dev"),
            patch.object(smoke, "execute", side_effect=command) as execute,
            patch.object(smoke, "stopped_sources", return_value=(containers, {})),
            patch.object(smoke, "collect", return_value={}),
            patch.object(smoke.snapshot.storage, "inspect", return_value={}),
            patch.object(smoke.snapshot.storage, "environment", return_value=env),
            patch.object(
                smoke.evaluation_network_probe,
                "exercise",
                return_value=network_result
                if network_result is not None
                else {
                    "status": "ENFORCED",
                    "policyProfile": "evaluation_chart",
                    "networkPolicyEnforcementVerified": True,
                    "cleanupComplete": True,
                },
            ) as network_probe,
            patch.object(smoke, "langfuse_url", return_value="http://172.20.0.2:3000"),
            patch.object(smoke.pvc, "restored_pvcs", side_effect=restored),
            patch.object(
                smoke.check_evaluation,
                "render_bundle",
                return_value={"prefect": [{"kind": "Deployment"}]},
            ) as render,
            self.assertRaises(
                subprocess.CalledProcessError if at_rollout else ValueError
            ),
        ):
            smoke.verify(
                Path(directory),
                settings,
                [],
                {},
                "kind",
                "helm",
                "secret",
                {},
                EXPECTED,
                report,
            )
        self.assertEqual(network_probe.call_args.args[1], PROJECT + "-control-plane")
        self.assertEqual(network_probe.call_args.kwargs, {"helm": "helm"})
        if network_result is not None:
            self.assertEqual(events, [])
            render.assert_not_called()
            self.assertEqual(
                report["evaluation_kubernetes_runtime"]["network_policy_probe"],
                network_result,
            )
            self.assertFalse(
                any(
                    call.args[0][:3] == ["docker", "image", "tag"]
                    for call in execute.call_args_list
                )
            )
            return
        self.assertEqual(
            events,
            [
                "pvc-created",
                *(["diagnosed"] if at_rollout else []),
                "pvc-deleted",
                "tag-deleted",
                "tag-deleted",
            ],
        )
        values = render.call_args.args[0]
        self.assertEqual(values["prefect"]["image"], PREFECT_IMAGE)
        commands = [call.args[0] for call in execute.call_args_list]
        local_images = [
            f"govbiz/{name}:{PROJECT}"
            for name in ("evaluation-runner", "ops-artifacts")
        ]
        self.assertEqual(
            [args for args in commands if args[:3] == ["docker", "image", "tag"]],
            [["docker", "image", "tag", IMAGE_ID, image] for image in local_images],
        )
        self.assertEqual(
            [args for args in commands if args[:3] == ["kind", "load", "docker-image"]],
            [["kind", "load", "docker-image", *local_images, "--name", PROJECT]],
        )
        self.assertEqual(
            [args for args in commands if args[:3] == ["docker", "image", "rm"]],
            [["docker", "image", "rm", image] for image in reversed(local_images)],
        )
        evidence = report["evaluation_kubernetes_runtime"]
        self.assertEqual(evidence["status"], "FAIL")
        self.assertFalse(evidence["cleanup_complete"])
        self.assertNotIn("token", json.dumps(evidence))
        self.assertEqual("rollout_failure" in evidence, at_rollout)

    def test_deployment_failure_cleans_pvcs_and_tags_without_reporting_success(self):
        self.deployment_failure()

    def test_rollout_is_diagnosed_before_namespace_and_tags_are_deleted(self):
        self.deployment_failure(at_rollout=True)

    def test_network_failure_or_wrong_profile_blocks_runtime_before_creating_pvcs(self):
        for change in (
            {"status": "NOT_ENFORCED"},
            {"status": "INCONCLUSIVE"},
            {"status": "ERROR"},
            {"policyProfile": "cni"},
            {"networkPolicyEnforcementVerified": False},
            {"cleanupComplete": False},
        ):
            with self.subTest(change=change):
                self.deployment_failure(
                    network_result={
                        "status": "ENFORCED",
                        "policyProfile": "evaluation_chart",
                        "networkPolicyEnforcementVerified": True,
                        "cleanupComplete": True,
                        **change,
                    }
                )


if __name__ == "__main__":
    unittest.main()
