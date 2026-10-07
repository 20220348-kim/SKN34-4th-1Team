"""Offline rendering and failure boundaries for the owned runtime CI fixture."""

import base64
import copy
import json
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
EXPECTED = {
    ID: {"flow_id": FLOW, "execution_spec_sha256": "b" * 64, "report_sha256": "c" * 64}
}


class RuntimeTests(unittest.TestCase):
    def test_real_chart_with_ci_images_is_free_and_uses_restored_claims(self):
        images = {
            name: f"govbiz/{name}:{PROJECT}" for name in check_evaluation.COMPONENTS
        }
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

    def test_deployment_failure_cleans_pvcs_and_tags_without_reporting_success(self):
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
            if data and json.loads(data).get("kind") == "Deployment":
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
            patch.object(smoke, "execute", side_effect=command),
            patch.object(smoke, "stopped_sources", return_value=(containers, {})),
            patch.object(smoke, "collect", return_value={}),
            patch.object(smoke.snapshot.storage, "inspect", return_value={}),
            patch.object(smoke.snapshot.storage, "environment", return_value=env),
            patch.object(smoke, "langfuse_url", return_value="http://172.20.0.2:3000"),
            patch.object(smoke.pvc, "restored_pvcs", side_effect=restored),
            patch.object(
                smoke.check_evaluation,
                "render_bundle",
                return_value={"prefect": [{"kind": "Deployment"}]},
            ),
            self.assertRaisesRegex(ValueError, "deployment failed"),
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
        self.assertEqual(
            events,
            ["pvc-created", "pvc-deleted", "tag-deleted", "tag-deleted", "tag-deleted"],
        )
        evidence = report["evaluation_kubernetes_runtime"]
        self.assertEqual(evidence["status"], "FAIL")
        self.assertFalse(evidence["cleanup_complete"])
        self.assertNotIn("token", json.dumps(evidence))


if __name__ == "__main__":
    unittest.main()
