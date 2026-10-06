"""Published-source compatibility checks without credentials or cluster writes."""

import copy
import io
import json
import shutil
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import deployment
import gitops_preservation as preservation
import gitops_runtime as runtime
import yaml
from repository import Fork


class PublishedReferenceTests(unittest.TestCase):
    def setUp(self):
        self.files = {
            runtime.CHART_PATH + "/" + name: payload
            for name, payload in runtime.chart_inputs().items()
        }
        for service in runtime.cluster.SERVICES:
            self.files[self.path(service)] = runtime.portfolio_defaults(service)[0]

    def path(self, service):
        return f"infrastructure/gitops/environments/fork/{service}.yaml"

    def test_only_captured_publication_is_read(self):
        before = copy.deepcopy(self.files)
        with (
            patch.object(
                runtime, "chart_inputs", side_effect=AssertionError("checkout")
            ),
            patch.object(
                runtime, "portfolio_defaults", side_effect=AssertionError("checkout")
            ),
        ):
            references, chart = runtime.published_defaults(self.files)
        self.assertEqual(set(references), set(runtime.cluster.SERVICES))
        self.assertIn("templates/deployment.yaml", chart)
        for service, (payload, _) in references.items():
            self.assertEqual(payload, self.files[self.path(service)])
        self.assertEqual(before, self.files)

    def test_missing_values_wrong_service_and_incomplete_chart_fail(self):
        del self.files[self.path("core-service")]
        with self.assertRaises(KeyError):
            runtime.published_defaults(self.files)
        self.files[self.path("core-service")] = self.files[self.path("ops-service")]
        with self.assertRaisesRegex(ValueError, "service differs"):
            runtime.published_defaults(self.files)
        self.files[self.path("core-service")] = runtime.portfolio_defaults(
            "core-service"
        )[0]
        del self.files[runtime.CHART_PATH + "/Chart.yaml"]
        with self.assertRaisesRegex(ValueError, "incomplete"):
            runtime.published_defaults(self.files)

    def test_unsafe_chart_paths_are_rejected_before_temporary_writes(self):
        for name in (
            "../escape",
            "/absolute",
            "x/../../escape",
            "C:/escape",
            "x\\escape",
            "x//escape",
        ):
            with self.subTest(name=name):
                files = self.files | {runtime.CHART_PATH + "/" + name: b"PRIVATE"}
                with self.assertRaisesRegex(ValueError, "Invalid published chart path"):
                    runtime.published_defaults(files)

    @unittest.skipUnless(
        shutil.which("helm"), "Pinned Helm required for real rendering"
    )
    def test_published_chart_and_values_differences_are_not_hidden_by_checkout(self):
        original, chart = runtime.published_defaults(self.files)
        deployments, services = runtime.rendered_defaults("helm", original, chart)
        values = yaml.safe_load(self.files[self.path("core-service")])
        values["resources"]["limits"]["memory"] = "900Mi"
        self.files[self.path("core-service")] = yaml.safe_dump(values).encode()
        name = runtime.CHART_PATH + "/templates/deployment.yaml"
        self.assertIn(b"timeoutSeconds: 8", self.files[name])
        self.files[name] = self.files[name].replace(
            b"timeoutSeconds: 8", b"timeoutSeconds: 20"
        )
        published, chart = runtime.published_defaults(self.files)
        with patch.object(
            runtime, "chart_inputs", side_effect=AssertionError("checkout")
        ):
            report = preservation.review(deployments, services, published, chart)
        self.assertEqual(report["status"], "BLOCKED")
        changes = report["services"]["core-service"]["differences"]["policy"]
        self.assertIn("containers.core-service.resources", changes)
        self.assertIn("containers.core-service.readinessProbe", changes)
        self.assertFalse(report["deploymentAuthorized"])


class PublishedRuntimeCliTests(unittest.TestCase):
    def setUp(self):
        self.fork = Fork("alice/project", "main")
        self.sha = "a" * 40
        self.record = {
            "verifiedRevision": self.sha,
            "runId": 123,
            "visibility": "public",
            "images": {},
        }
        self.publication = self.record, {"captured-chart": b"fixture"}, self.sha

    def invoke(self, observed=None, results=None):
        observed = (
            observed if observed is not None else {"status": "NO_LOCAL_OVERRIDES"}
        )
        output = io.StringIO()
        calls = Mock()
        with (
            patch(
                "sys.argv",
                [
                    "deployment.py",
                    "review-published-runtime",
                    "--state-dir",
                    "fixture",
                    "--helm",
                    "/custom/helm",
                ],
            ),
            patch.object(deployment, "from_origin", return_value=self.fork),
            patch.object(
                deployment,
                "verified_release",
                side_effect=results
                or [self.publication, copy.deepcopy(self.publication)],
            ) as verify,
            patch.object(
                runtime,
                "preflight",
                side_effect=observed if isinstance(observed, Exception) else None,
                return_value=observed,
            ) as preflight,
            patch.object(deployment, "gitops_plan") as plan,
            redirect_stdout(output),
        ):
            calls.attach_mock(verify, "verify")
            calls.attach_mock(preflight, "preflight")
            code = deployment.main()
        plan.assert_not_called()
        for call in verify.call_args_list:
            self.assertEqual(call.args[1:], (self.fork, "/custom/helm"))
            self.assertEqual(call.kwargs, {"verify_public_manifests": True})
        if preflight.called:
            preflight.assert_called_once_with(
                Path("fixture"),
                self.fork,
                "/custom/helm",
                review_preservation=True,
                published_files=self.publication[1],
            )
        report = json.loads(output.getvalue())
        self.assertNotIn("resources", report)
        self.assertNotIn("PRIVATE", output.getvalue())
        self.assertFalse(report["deploymentAuthorized"])
        self.assertFalse(report["clusterVerified"])
        return code, report, [call[0] for call in calls.mock_calls]

    def test_verified_publication_wraps_the_runtime_observation(self):
        code, report, order = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(order, ["verify", "preflight", "verify"])
        self.assertEqual(report["status"], "REVIEWED")
        self.assertEqual(report["sourceSha"], self.sha)
        self.assertEqual(report["publisherRunId"], 123)
        self.assertTrue(report["publishedReferenceVerified"])
        self.assertFalse(report["existingRuntimeVerified"])

    def test_preservation_success_does_not_clear_transition_blockers(self):
        observed = {
            "status": "BLOCKED",
            "blockers": ["connected_or_unverified_ops"],
            "preservationReview": {
                "helmPreservation": {"status": "MATCHES_INSPECTED_FIELDS"}
            },
        }
        code, report, order = self.invoke(observed)
        self.assertEqual(code, 1)
        self.assertEqual(order, ["verify", "preflight", "verify"])
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["reason"], "runtime_transition_required")
        self.assertTrue(report["publishedReferenceVerified"])
        self.assertEqual(report["runtimePreflight"], observed)

    def test_missing_private_or_unverified_publication_never_reads_runtime(self):
        for message in (
            "No complete verified publication",
            "Public receipts are required",
            "Deployment source blocked",
        ):
            with self.subTest(message=message):
                code, report, order = self.invoke(
                    results=[ValueError(message + ": PRIVATE")]
                )
                self.assertEqual(code, 1)
                self.assertEqual(order, ["verify"])
                self.assertFalse(report["publishedReferenceVerified"])
                self.assertNotIn("runtimePreflight", report)

    def test_source_or_ci_changes_during_runtime_review_discard_observation(self):
        for message in ("Source advanced", "Required CI evidence changed"):
            with self.subTest(message=message):
                code, report, order = self.invoke(
                    results=[self.publication, ValueError(message + ": PRIVATE")]
                )
                self.assertEqual(code, 1)
                self.assertEqual(order, ["verify", "preflight", "verify"])
                self.assertFalse(report["publishedReferenceVerified"])
                self.assertEqual(report["runtimePreflight"]["status"], "UNKNOWN")
                self.assertNotIn("sourceSha", report)

    def test_changed_publisher_or_captured_files_discard_observation(self):
        variants = [
            (self.record | {"runId": 124}, self.publication[1], self.sha),
            (self.record, {"captured-chart": b"PRIVATE"}, self.sha),
            (self.record, self.publication[1], "b" * 40),
        ]
        for confirmed in variants:
            with self.subTest(confirmed=confirmed):
                code, report, _ = self.invoke(results=[self.publication, confirmed])
                self.assertEqual(code, 1)
                self.assertEqual(report["reason"], "publication_changed")
                self.assertFalse(report["publishedReferenceVerified"])
                self.assertEqual(report["runtimePreflight"]["status"], "UNKNOWN")

    def test_runtime_query_failure_cannot_be_reported_as_verified(self):
        code, report, order = self.invoke(ValueError("PRIVATE query"))
        self.assertEqual(code, 1)
        self.assertEqual(order, ["verify", "preflight"])
        self.assertEqual(report["runtimePreflight"]["status"], "UNKNOWN")
        self.assertFalse(report["publishedReferenceVerified"])

    def test_unknown_runtime_remains_blocked(self):
        code, report, _ = self.invoke({"status": "UNKNOWN"})
        self.assertEqual(code, 1)
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["runtimePreflight"]["status"], "UNKNOWN")

    def test_required_state_and_incompatible_option_fail_before_network(self):
        for args in ([], ["--state-dir", "fixture", "--review-preservation"]):
            with (
                self.subTest(args=args),
                patch("sys.argv", ["deployment.py", "review-published-runtime", *args]),
                patch.object(deployment, "from_origin") as origin,
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as stopped,
            ):
                deployment.main()
            self.assertEqual(stopped.exception.code, 2)
            origin.assert_not_called()


if __name__ == "__main__":
    unittest.main()
