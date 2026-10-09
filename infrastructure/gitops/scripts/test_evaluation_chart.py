"""Real offline Helm rendering and SQLite checks for the evaluation migration."""

import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import check_evaluation as check
import yaml


def bundle():
    values = {
        name: {
            "component": name,
            "image": "ghcr.io/fixture/" + name + "@sha256:" + "a" * 64,
            "storage": {
                "existingClaim": "restored-results",
                "node": "fixture-control-plane",
            },
        }
        for name in check.COMPONENTS
    }
    values["prefect"]["storage"]["existingClaim"] = "restored-prefect"
    values["evaluation-runner"]["runner"] = {
        "opsApiUrl": "http://ops-service.govbiz-msa.svc.cluster.local:8000",
        "langfuseUrl": "http://langfuse-web.govbiz-observability.svc.cluster.local:3000",
    }
    values["ops-artifacts"]["evidenceImage"] = values["evaluation-runner"]["image"]
    return values


def workload(objects):
    return next(row for row in objects if row["kind"] == "Deployment")


class EvaluationChartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resources = check.render_bundle(bundle())

    def test_independent_dormant_releases_cannot_own_or_delete_data(self):
        for component, rows in self.resources.items():
            with self.subTest(component=component):
                self.assertCountEqual(
                    [row["kind"] for row in rows],
                    ["Deployment", "NetworkPolicy"]
                    if component == "evaluation-runner"
                    else ["Deployment", "Service", "NetworkPolicy"],
                )
                deploy = workload(rows)
                self.assertEqual(deploy["spec"]["replicas"], 0)
                self.assertEqual(deploy["spec"]["strategy"], {"type": "Recreate"})
                self.assertEqual(deploy["metadata"]["namespace"], "govbiz-evaluation")
                pod = deploy["spec"]["template"]["spec"]
                self.assertFalse(pod["automountServiceAccountToken"])
                self.assertTrue(pod["securityContext"]["runAsNonRoot"])
                self.assertEqual(len(pod["containers"]), 1)
                self.assertNotIn("hostNetwork", pod)
                self.assertTrue(
                    all("hostPath" not in volume for volume in pod["volumes"])
                )
                for container in pod["containers"] + pod.get("initContainers", []):
                    self.assertTrue(
                        container["securityContext"]["readOnlyRootFilesystem"]
                    )
                    self.assertFalse(
                        container["securityContext"]["allowPrivilegeEscalation"]
                    )
                    self.assertEqual(
                        container["securityContext"]["capabilities"], {"drop": ["ALL"]}
                    )
                    self.assertNotIn("envFrom", container)
                if component != "evaluation-runner":
                    service = next(row for row in rows if row["kind"] == "Service")
                    self.assertEqual(service["spec"]["type"], "ClusterIP")

    def test_ingress_requires_exact_namespace_pod_and_port(self):
        for component, rows in self.resources.items():
            policy = next(row for row in rows if row["kind"] == "NetworkPolicy")
            self.assertEqual(
                policy["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"], "-1"
            )
            spec = policy["spec"]
            self.assertEqual(spec["podSelector"], workload(rows)["spec"]["selector"])
            self.assertEqual(spec["policyTypes"], ["Ingress", "Egress"])
            if component == "evaluation-runner":
                self.assertEqual(spec["ingress"], [])
                continue
            self.assertEqual(len(spec["ingress"]), 1)
            rule = spec["ingress"][0]
            self.assertEqual(
                rule["ports"],
                [{"protocol": "TCP", "port": 4200 if component == "prefect" else 8010}],
            )
            peers = [
                {
                    "namespaceSelector": {
                        "matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}
                    },
                    "podSelector": {
                        "matchLabels": {"app.kubernetes.io/name": "ops-service"}
                    },
                }
            ]
            if component == "prefect":
                peers.append(
                    {
                        "podSelector": {
                            "matchLabels": {
                                "app.kubernetes.io/name": "evaluation-runner"
                            }
                        }
                    }
                )
            self.assertEqual(rule["from"], peers)

    def test_egress_denies_server_connections_and_limits_runner_peers(self):
        for component, rows in self.resources.items():
            policy = next(row for row in rows if row["kind"] == "NetworkPolicy")["spec"]
            expected = (
                check.runner_egress(bundle()[component]["runner"])
                if component == "evaluation-runner"
                else []
            )
            self.assertEqual(policy["egress"], expected)
        rules = check.runner_egress(bundle()["evaluation-runner"]["runner"])
        self.assertEqual(
            [r["ports"] for r in rules],
            [
                [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}],
                [{"protocol": "TCP", "port": 4200}],
                [{"protocol": "TCP", "port": 8000}],
                [{"protocol": "TCP", "port": 3000}],
            ],
        )
        self.assertEqual(
            rules[-1]["to"],
            [
                {
                    "namespaceSelector": {
                        "matchLabels": {
                            "kubernetes.io/metadata.name": "govbiz-observability"
                        }
                    },
                    "podSelector": {
                        "matchLabels": {"app.kubernetes.io/name": "langfuse-web"}
                    },
                }
            ],
        )

    def test_compose_langfuse_egress_is_exactly_one_private_ipv4_and_port(self):
        for address in ("10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.5.10"):
            values = bundle()
            runner = values["evaluation-runner"]["runner"]
            runner["langfuseUrl"] = "http://" + address + ":3000"
            rendered = check.render_bundle(values)
            policy = next(
                row
                for row in rendered["evaluation-runner"]
                if row["kind"] == "NetworkPolicy"
            )
            self.assertEqual(policy["spec"]["egress"], check.runner_egress(runner))
            self.assertEqual(
                policy["spec"]["egress"][-1],
                {
                    "to": [{"ipBlock": {"cidr": address + "/32"}}],
                    "ports": [{"protocol": "TCP", "port": 3000}],
                },
            )

    def test_unknown_langfuse_routes_fail_in_python_and_direct_helm(self):
        for origin in (
            "http://langfuse:3000",
            "http://example.com:3000",
            "https://172.20.0.2:443",
            "http://8.8.8.8:3000",
            "http://127.0.0.1:3000",
            "http://169.254.169.254:3000",
            "http://0.0.0.0:3000",
            "http://172.15.0.1:3000",
            "http://172.32.0.1:3000",
            "http://100.64.0.1:3000",
            "http://10.0.0.999:3000",
            "http://10.01.0.1:3000",
            "http://10.0.0.1:8000",
            "http://10.0.0.1:3000/path",
            "http://u:p@10.0.0.1:3000",
            "http://[fd00::1]:3000",
            "http://10.0.0.1:3000?x=1",
            "http://10.0.0.1:3000\n",
        ):
            with self.subTest(origin=origin):
                values = bundle()["evaluation-runner"]
                values["runner"]["langfuseUrl"] = origin
                with self.assertRaises(ValueError):
                    check.runner_egress(values["runner"])
                self.assertNotEqual(
                    self.render_one("evaluation-runner", values).returncode, 0
                )

    def test_ops_url_cannot_escape_its_namespace_pod_and_port(self):
        for origin in (
            "http://ops-service:8000",
            "http://ops-service.other.svc.cluster.local:8000",
            "http://ops-service.govbiz-msa.svc.cluster.local:8001",
            "http://172.20.0.2:8000",
        ):
            with self.subTest(origin=origin):
                values = bundle()["evaluation-runner"]
                values["runner"]["opsApiUrl"] = origin
                with self.assertRaises(ValueError):
                    check.runner_egress(values["runner"])
                self.assertNotEqual(
                    self.render_one("evaluation-runner", values).returncode, 0
                )

    def test_shared_results_have_one_writer_and_matching_immutable_fixtures(self):
        pods = {
            name: workload(rows)["spec"]["template"]["spec"]
            for name, rows in self.resources.items()
        }
        for name, readonly in (("evaluation-runner", False), ("ops-artifacts", True)):
            data = next(row for row in pods[name]["volumes"] if row["name"] == "data")
            mount = next(
                row
                for row in pods[name]["containers"][0]["volumeMounts"]
                if row["name"] == "data"
            )
            self.assertEqual(
                data["persistentVolumeClaim"],
                {"claimName": "restored-results", "readOnly": readonly},
            )
            self.assertEqual(mount["readOnly"], readonly)
        self.assertEqual(
            pods["evaluation-runner"]["nodeSelector"],
            pods["ops-artifacts"]["nodeSelector"],
        )
        self.assertEqual(
            pods["ops-artifacts"]["initContainers"][0]["image"],
            pods["evaluation-runner"]["containers"][0]["image"],
        )
        self.assertNotIn(
            "data",
            [
                row["name"]
                for row in pods["ops-artifacts"]["initContainers"][0]["volumeMounts"]
            ],
        )

    @unittest.skipUnless(os.name == "posix", "POSIX volume ownership regression")
    def test_evidence_init_can_copy_into_writable_mount_owned_by_another_user(self):
        # Kubernetes mounts an emptyDir owned by root with fsGroup write access.
        # An unprivileged process may create files but cannot copystat that root.
        # /tmp provides the same ownership restriction without root/chown access.
        target = Path(tempfile.gettempdir())
        before = target.stat()
        if before.st_uid == os.getuid():
            self.skipTest(
                "Use an unprivileged test user with a root-owned temporary directory"
            )
        name = "govbiz-evidence-copy-" + uuid4().hex
        outputs = [target / name, target / (name + ".json")]
        self.assertTrue(all(not path.exists() for path in outputs))
        container = workload(self.resources["ops-artifacts"])["spec"]["template"][
            "spec"
        ]["initContainers"][0]
        try:
            with tempfile.TemporaryDirectory(
                prefix="govbiz-evidence-source-"
            ) as directory:
                source = Path(directory)
                (source / name).mkdir()
                content = "한글 평가 자료\n".encode()
                (source / name / "fixture.txt").write_bytes(content)
                (source / (name + ".json")).write_text(
                    '{"fixture":true}', encoding="utf-8"
                )
                program = (
                    container["command"][-1]
                    .replace(
                        "'/app/evaluation/support-program-evidence'", repr(str(source))
                    )
                    .replace("'/evidence'", repr(str(target)))
                )
                for _ in range(2):  # An init retry must safely reuse its own copies.
                    result = subprocess.run(
                        [sys.executable, "-B", "-c", program],
                        capture_output=True,
                        timeout=15,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    self.assertEqual((outputs[0] / "fixture.txt").read_bytes(), content)
                    self.assertEqual(outputs[1].read_text(), '{"fixture":true}')
                self.assertEqual((source / name / "fixture.txt").read_bytes(), content)
            after = target.stat()
            self.assertEqual(
                (after.st_uid, after.st_gid, after.st_mode),
                (before.st_uid, before.st_gid, before.st_mode),
            )
        finally:
            if outputs[0].exists():
                shutil.rmtree(outputs[0])
            outputs[1].unlink(missing_ok=True)

    def test_runner_is_free_only_and_secrets_do_not_enter_prefect_or_artifacts(self):
        envs = {
            name: {
                row["name"]: row
                for row in workload(objects)["spec"]["template"]["spec"]["containers"][
                    0
                ]["env"]
            }
            for name, objects in self.resources.items()
        }
        for flag in (
            "LLMOPS_LIVE_ENABLED",
            "LLMOPS_RAG_LIVE_ENABLED",
            "LLMOPS_SCHEDULES_ENABLED",
        ):
            self.assertEqual(envs["evaluation-runner"][flag]["value"], "false")
        self.assertEqual(envs["evaluation-runner"]["OPENAI_API_KEY"]["value"], "")
        self.assertEqual(
            envs["evaluation-runner"]["PREFECT_API_URL"]["value"],
            "http://prefect:4200/api",
        )
        expected = {
            "prefect": set(),
            "ops-artifacts": {"LLMOPS_ARTIFACT_TOKEN"},
            "evaluation-runner": {
                "LLMOPS_BUDGET_TOKEN",
                "LANGFUSE_PUBLIC_KEY",
                "LANGFUSE_SECRET_KEY",
            },
        }
        for name, env in envs.items():
            self.assertEqual(
                {key for key, row in env.items() if "valueFrom" in row}, expected[name]
            )
        self.assertEqual(
            envs["prefect"]["PREFECT_API_DATABASE_MIGRATE_ON_START"]["value"], "false"
        )
        self.assertIn(
            "--no-services",
            workload(self.resources["prefect"])["spec"]["template"]["spec"][
                "containers"
            ][0]["command"],
        )

    def render_one(self, component, value, namespace="govbiz-evaluation", release=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "values.yaml"
            path.write_text(yaml.safe_dump(value), encoding="utf-8")
            return subprocess.run(
                [
                    "helm",
                    "template",
                    release or component,
                    str(check.CHART),
                    "-n",
                    namespace,
                    "-f",
                    str(path),
                ],
                capture_output=True,
                check=False,
                text=True,
                timeout=15,
            )

    def test_chart_rejects_unsafe_and_unsupported_inputs(self):
        cases = [
            ("prefect", {"replicas": 2}),
            ("prefect", {"replicas": True}),
            ("prefect", {"replicas": -1}),
            ("prefect", {"image": "prefect:latest"}),
            ("prefect", {"storage": {"existingClaim": "", "node": "node"}}),
            ("prefect", {"storage": {"existingClaim": "claim", "node": ""}}),
            ("evaluation-runner", {"env": {"LLMOPS_LIVE_ENABLED": "true"}}),
            ("evaluation-runner", {"secretKeys": ["OPENAI_API_KEY"]}),
            ("evaluation-runner", {"command": ["sh"]}),
            ("prefect", {"volumes": [{"hostPath": {"path": "/"}}]}),
            ("ops-artifacts", {"evidenceImage": "runner:latest"}),
            ("ops-artifacts", {"runner": {"opsApiUrl": "http://ops:8000"}}),
        ]
        for url in (
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "http://pending.invalid",
            "http://user:pass@ops:8000",
            "http://ops:8000/path",
        ):
            cases.append(
                (
                    "evaluation-runner",
                    {
                        "runner": {
                            "opsApiUrl": url,
                            "langfuseUrl": "http://langfuse:3000",
                        }
                    },
                )
            )
        for component, changes in cases:
            with self.subTest(component=component, changes=changes):
                result = self.render_one(component, bundle()[component] | changes)
                self.assertNotEqual(result.returncode, 0)
        for namespace, release in (
            ("govbiz-msa", "prefect"),
            ("govbiz-evaluation", "other"),
        ):
            self.assertNotEqual(
                self.render_one(
                    "prefect", bundle()["prefect"], namespace, release
                ).returncode,
                0,
            )

    def test_all_three_can_be_explicitly_enabled_without_adding_scheduling_or_paid_calls(
        self,
    ):
        values = bundle()
        for value in values.values():
            value["replicas"] = 1
        resources = check.render_bundle(values)
        self.assertTrue(
            all(workload(rows)["spec"]["replicas"] == 1 for rows in resources.values())
        )

    def test_shared_templates_keep_prefect_version_and_require_real_candidate_inputs(
        self,
    ):
        root = check.CHART.parents[1]
        templates = {
            name: yaml.safe_load(
                (root / "environments/evaluation" / (name + ".yaml")).read_text()
            )
            for name in check.COMPONENTS
        }
        compose = yaml.safe_load(
            (root.parent / "llmops/compose.yaml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            templates["prefect"]["image"], compose["services"]["prefect"]["image"]
        )
        for name, value in templates.items():
            self.assertEqual(value["replicas"], 0)
            self.assertNotEqual(self.render_one(name, value).returncode, 0)

    def test_unpinned_helm_cannot_render_a_candidate(self):
        with (
            patch.object(
                check.subprocess, "check_output", return_value="v3.0.0"
            ) as command,
            self.assertRaisesRegex(ValueError, "Pinned Helm"),
        ):
            check.render_bundle(bundle())
        self.assertEqual(command.call_count, 1)

    def test_cross_release_mismatch_is_rejected_before_helm(self):
        for change in (
            "claim",
            "node",
            "prefect_claim",
            "fixtures",
            "missing",
            "mode",
            "runner_only",
        ):
            values = bundle()
            if change in {"claim", "node"}:
                values["ops-artifacts"]["storage"][
                    "existingClaim" if change == "claim" else "node"
                ] = "different"
            elif change == "prefect_claim":
                values["prefect"]["storage"]["existingClaim"] = "restored-results"
            elif change == "fixtures":
                values["ops-artifacts"]["evidenceImage"] = "different"
            elif change == "missing":
                del values["prefect"]
            elif change == "mode":
                values["prefect"]["allowLocalImages"] = True
            else:
                values["evaluation-runner"]["replicas"] = 1
            with (
                self.subTest(change=change),
                patch.object(check.subprocess, "check_output") as command,
            ):
                with self.assertRaises(ValueError):
                    check.render_bundle(values)
                command.assert_not_called()

    def test_explicit_local_images_are_never_pulled(self):
        values = bundle()
        for name, value in values.items():
            value["allowLocalImages"] = True
            if name != "prefect":
                value["image"] = "govbiz/" + name + ":rehearsal"
        values["ops-artifacts"]["evidenceImage"] = values["evaluation-runner"]["image"]
        for rows in check.render_bundle(values).values():
            pod = workload(rows)["spec"]["template"]["spec"]
            self.assertTrue(
                all(
                    c["imagePullPolicy"] == "Never"
                    for c in pod["containers"] + pod.get("initContainers", [])
                )
            )

    def test_ci_prefect_requires_an_immutable_reference_instead_of_a_local_alias(self):
        for image in ("govbiz/prefect:rehearsal", "prefecthq/prefect:3.8.6-python3.12"):
            values = bundle()
            for name, value in values.items():
                value["allowLocalImages"] = True
                value["image"] = "govbiz/" + name + ":rehearsal"
            values["ops-artifacts"]["evidenceImage"] = values["evaluation-runner"][
                "image"
            ]
            values["prefect"]["image"] = image
            with (
                self.subTest(image=image),
                self.assertRaises(subprocess.CalledProcessError) as caught,
            ):
                check.render_bundle(values)
            self.assertIn(
                b"An immutable image@sha256 digest is required", caught.exception.stderr
            )

    def test_restored_sqlite_guard_preserves_history_and_allows_server_recovery(
        self,
    ):
        command = workload(self.resources["prefect"])["spec"]["template"]["spec"][
            "initContainers"
        ][0]["command"]
        script = command[2]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "prefect.db"

            def run():
                return subprocess.run(
                    [sys.executable, "-c", script, str(path)],
                    capture_output=True,
                    check=False,
                    timeout=10,
                )

            self.assertNotEqual(run().returncode, 0)
            self.assertFalse(path.exists())
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript(
                    "CREATE TABLE alembic_version(version_num TEXT); "
                    "INSERT INTO alembic_version VALUES ('fixture'); "
                    "CREATE TABLE deployment_schedule(active INTEGER); "
                    "CREATE TABLE flow_run(state_type TEXT); "
                    "INSERT INTO flow_run VALUES ('COMPLETED');"
                )
            before = path.read_bytes()
            self.assertEqual(run().returncode, 0)
            self.assertEqual(path.read_bytes(), before)
            for query in (
                "INSERT INTO deployment_schedule VALUES (1)",
                "INSERT INTO flow_run VALUES ('RUNNING')",
                "INSERT INTO flow_run VALUES (NULL)",
            ):
                with closing(sqlite3.connect(path)) as db, db:
                    db.execute(query)
                # Draining is a cutover check, not a condition for server restart.
                current = path.read_bytes()
                self.assertEqual(run().returncode, 0)
                self.assertEqual(path.read_bytes(), current)
                with closing(sqlite3.connect(path)) as db, db:
                    db.execute("DELETE FROM deployment_schedule")
                    db.execute(
                        "DELETE FROM flow_run WHERE state_type IS NULL OR state_type != 'COMPLETED'"
                    )
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("DELETE FROM alembic_version")
            self.assertNotEqual(run().returncode, 0)

    def test_cli_never_claims_storage_restore_or_prints_private_values(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, value in bundle().items():
                (Path(directory) / (name + ".yaml")).write_text(
                    yaml.safe_dump(value), encoding="utf-8"
                )
            for failure in (False, True):
                stream = io.StringIO()
                options = (
                    {"side_effect": ValueError("PRIVATE")}
                    if failure
                    else {"return_value": self.resources}
                )
                with (
                    patch(
                        "sys.argv", ["check_evaluation.py", "--values-dir", directory]
                    ),
                    patch.object(check, "render_bundle", **options),
                    redirect_stdout(stream),
                ):
                    self.assertEqual(check.main(), int(failure))
                result = json.loads(stream.getvalue())
                self.assertFalse(result["clusterChanged"])
                self.assertFalse(result["databaseChanged"])
                self.assertNotIn("PRIVATE", stream.getvalue())
                if not failure:
                    self.assertFalse(result["storageRestored"])
                    self.assertFalse(result["runtimeVerified"])


if __name__ == "__main__":
    unittest.main()
