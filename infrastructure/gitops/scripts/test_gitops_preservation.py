"""Local Helm rehearsal without Secret reads, publication or deployment."""

import copy
import io
import json
import shutil
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import deployment
import gitops_preservation as preservation
import gitops_runtime as runtime
import yaml
from repository import Fork


@unittest.skipUnless(shutil.which("helm"), "Pinned Helm required for real rendering")
class PreservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.references = {
            service: runtime.portfolio_defaults(service)
            for service in runtime.cluster.SERVICES
        }
        cls.chart = runtime.chart_inputs()
        cls.base, cls.base_services = runtime.rendered_defaults(
            "helm", cls.references, cls.chart
        )
        connected = copy.deepcopy(cls.references)
        for service in ("core-service", "ops-service"):
            values = yaml.safe_load(connected[service][0])
            if service == "core-service":
                values["env"].update(
                    RABBITMQ_HOST="rabbitmq",
                    RABBITMQ_PORT="5672",
                    RABBITMQ_USERNAME="govbiz",
                    RABBITMQ_VHOST="govbiz",
                    ACCOUNT_DEV_LOGIN_ENABLED="true",
                    ACCOUNT_DEV_LOGIN_EMAIL="PRIVATE@example.test",
                )
                values["env"].update(
                    {key: "true" for key in runtime.connected_runtime.QUEUES}
                )
                values["secretKeys"] += [
                    "RABBITMQ_PASSWORD",
                    "ACCOUNT_DEV_LOGIN_PASSWORD",
                ]
            else:
                values["opsSync"] = {"enabled": True}
                values["env"].update(
                    PREFECT_API_URL="http://PRIVATE-prefect:4200/api",
                    LLMOPS_ARTIFACT_URL="http://PRIVATE-artifacts:8010",
                )
                values["secretKeys"].append("LLMOPS_ARTIFACT_TOKEN")
            rows = [
                {"name": key, "value": value} for key, value in values["env"].items()
            ]
            rows += [
                {
                    "name": key,
                    "valueFrom": {
                        "secretKeyRef": {"name": values["secretName"], "key": key}
                    },
                }
                for key in values["secretKeys"]
            ]
            connected[service] = yaml.safe_dump(values).encode(), rows
        cls.connected, cls.connected_services = runtime.rendered_defaults(
            "helm", connected, cls.chart
        )

    def setUp(self):
        self.deployments = copy.deepcopy(self.connected)
        self.services = copy.deepcopy(self.connected_services)

    def container(self, service="core-service", position=0):
        return self.deployments[service]["spec"]["template"]["spec"]["containers"][
            position
        ]

    def review(self):
        return preservation.review(
            self.deployments, self.services, self.references, self.chart
        )

    def test_connected_queues_login_and_ops_sync_render_without_values_in_report(self):
        before = copy.deepcopy(
            (self.deployments, self.services, self.references, self.chart)
        )
        with patch.object(
            runtime.cluster,
            "run",
            side_effect=AssertionError("Cluster access forbidden"),
        ):
            report = self.review()
        self.assertEqual(report["status"], "MATCHES_INSPECTED_FIELDS")
        self.assertNotIn("PRIVATE", json.dumps(report))
        for name in (
            "configurationValuesIncluded",
            "overlayWritten",
            "imagesVerified",
            "deploymentAuthorized",
        ):
            self.assertFalse(report[name])
        self.assertEqual(
            before, (self.deployments, self.services, self.references, self.chart)
        )
        self.assertTrue(
            all(
                item["status"] == "MATCHES_INSPECTED_FIELDS"
                for item in report["services"].values()
            )
        )

    def test_bootstrap_values_still_match(self):
        self.deployments, self.services = copy.deepcopy((self.base, self.base_services))
        self.assertEqual(self.review()["status"], "MATCHES_INSPECTED_FIELDS")

    def test_preserved_reference_retains_secret_refs_instead_of_values(self):
        result, rows = preservation.reference(
            "core-service",
            self.deployments["core-service"],
            self.references["core-service"],
        )
        values = yaml.safe_load(result)
        self.assertIn("ACCOUNT_DEV_LOGIN_PASSWORD", values["secretKeys"])
        self.assertNotIn("ACCOUNT_DEV_LOGIN_PASSWORD", values["env"])
        self.assertEqual(values["env"]["COMBINATION_REVIEW_QUEUE_ENABLED"], "true")
        self.assertEqual(
            runtime.environment_rows(rows),
            runtime.environment_rows(self.container()["env"]),
        )

    def test_literal_credentials_never_reach_helm(self):
        for name in ("CUSTOM_PASSWORD", "TOKEN", "OPENAI_API_KEY", "CLIENT_SECRET"):
            with self.subTest(name=name):
                self.container()["env"].append({"name": name, "value": "PRIVATE"})
                with patch.object(runtime, "rendered_defaults") as render:
                    report = self.review()
                render.assert_not_called()
                self.assertEqual(
                    report["services"]["core-service"]["reasons"],
                    ["literal_credential_requires_secret"],
                )
                self.assertNotIn("PRIVATE", json.dumps(report))
                self.container()["env"].pop()

    def test_unsupported_references_are_not_flattened(self):
        refs = [
            {"secretKeyRef": {"name": "PRIVATE-other", "key": "CUSTOM"}},
            {"secretKeyRef": {"name": "core-runtime", "key": "PRIVATE-renamed"}},
            {
                "secretKeyRef": {
                    "name": "core-runtime",
                    "key": "CUSTOM",
                    "optional": True,
                }
            },
            {"configMapKeyRef": {"name": "PRIVATE-map", "key": "CUSTOM"}},
            {"fieldRef": {"fieldPath": "metadata.name"}},
        ]
        for ref in refs:
            with self.subTest(ref=ref):
                self.container()["env"].append({"name": "CUSTOM", "valueFrom": ref})
                report = self.review()
                self.assertEqual(
                    report["services"]["core-service"]["reasons"],
                    ["unsupported_environment_reference"],
                )
                self.assertNotIn("PRIVATE", json.dumps(report))
                self.container()["env"].pop()

    def test_env_from_and_unknown_sidecars_block(self):
        self.container()["envFrom"] = [{"secretRef": {"name": "PRIVATE"}}]
        self.assertEqual(
            self.review()["services"]["core-service"]["reasons"],
            ["env_from_requires_review"],
        )
        del self.container()["envFrom"]
        self.deployments["core-service"]["spec"]["template"]["spec"][
            "containers"
        ].append({"name": "PRIVATE"})
        self.assertEqual(
            self.review()["services"]["core-service"]["reasons"],
            ["unsupported_container_layout"],
        )

    def test_sync_environment_and_image_must_match_api_container(self):
        sync = self.container("ops-service", 1)
        sync["env"].append({"name": "CUSTOM", "value": "PRIVATE"})
        self.assertEqual(
            self.review()["services"]["ops-service"]["reasons"],
            ["ops_sync_environment_differs"],
        )
        sync["env"].pop()
        sync["image"] = "PRIVATE"
        self.assertEqual(
            self.review()["services"]["ops-service"]["reasons"],
            ["ops_sync_image_differs"],
        )

    def test_sync_command_and_security_changes_are_not_hidden(self):
        sync = self.container("ops-service", 1)
        sync["command"] = ["PRIVATE"]
        sync["securityContext"]["runAsUser"] = 9999
        report = self.review()
        self.assertEqual(report["status"], "BLOCKED")
        changes = report["services"]["ops-service"]["differences"]
        self.assertIn("containers.ops-sync.command", changes["execution"])
        self.assertIn("containers.ops-sync.securityContext", changes["policy"])
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_service_routing_and_missing_probes_remain_differences(self):
        self.services["core-service"]["spec"]["selector"] = {"PRIVATE": "PRIVATE"}
        del self.container()["readinessProbe"]
        report = self.review()
        self.assertEqual(report["status"], "BLOCKED")
        changes = report["services"]["core-service"]["differences"]
        self.assertIn("selector_does_not_match_pod", changes["routing"])
        self.assertIn("containers.core-service.readinessProbe", changes["policy"])
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_ambiguous_env_is_rejected_without_private_error_text(self):
        self.container()["env"] += [{"name": "CUSTOM", "value": "PRIVATE"}] * 2
        report = self.review()
        self.assertEqual(
            report["services"]["core-service"]["reasons"], ["invalid_environment"]
        )
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_failed_helm_cannot_leave_partial_success_or_values(self):
        for error in (
            subprocess.CalledProcessError(
                1, "PRIVATE", output="PRIVATE", stderr="PRIVATE"
            ),
            subprocess.TimeoutExpired("PRIVATE", 30),
            ValueError("PRIVATE"),
        ):
            with patch.object(runtime, "rendered_defaults", side_effect=error):
                report = self.review()
            self.assertEqual(report["status"], "UNKNOWN")
            self.assertNotIn("PRIVATE", json.dumps(report))
            self.assertTrue(
                all(item["status"] == "UNKNOWN" for item in report["services"].values())
            )


class PreservationCliTests(unittest.TestCase):
    def test_opt_in_preserves_existing_block_and_does_not_query_publication(self):
        output = io.StringIO()
        result = {
            "status": "BLOCKED",
            "blockers": ["connected_or_unverified_ops"],
            "preservationReview": {
                "helmPreservation": {"status": "MATCHES_INSPECTED_FIELDS"}
            },
        }
        fork = Fork("alice/project", "main")
        with (
            patch(
                "sys.argv",
                [
                    "deployment.py",
                    "plan-gitops",
                    "--state-dir",
                    "fixture",
                    "--review-preservation",
                ],
            ),
            patch.object(deployment, "from_origin", return_value=fork),
            patch.object(runtime, "preflight", return_value=result) as check,
            patch.object(deployment, "verified_release") as publication,
            redirect_stdout(output),
        ):
            self.assertEqual(deployment.main(), 1)
        check.assert_called_once_with(
            Path("fixture"), fork, "helm", review_preservation=True
        )
        publication.assert_not_called()
        report = json.loads(output.getvalue())
        self.assertEqual(report["reason"], "runtime_transition_required")
        self.assertNotIn("resources", report)

    def test_option_requires_local_plan_before_any_external_calls(self):
        for args in (
            ["plan-gitops"],
            ["verify-public"],
            ["verify-public", "--state-dir", "fixture"],
        ):
            with (
                patch("sys.argv", ["deployment.py", *args, "--review-preservation"]),
                patch.object(deployment, "from_origin") as origin,
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as stopped,
            ):
                deployment.main()
            self.assertEqual(stopped.exception.code, 2)
            origin.assert_not_called()


if __name__ == "__main__":
    unittest.main()
