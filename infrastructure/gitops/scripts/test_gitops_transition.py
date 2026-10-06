"""Private Argo preparation, rendered offline with no deployment or API writes."""

import copy
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import gitops_preservation as preservation
import gitops_runtime as runtime
import gitops_transition as transition
import test_gitops_preservation as fixtures
import yaml
from repository import Fork


@unittest.skipUnless(shutil.which("helm"), "Pinned Helm required for real rendering")
class TransitionPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.PreservationTests.setUpClass()
        cls.fork = Fork("alice/project", "main")
        cls.sha = "a" * 40
        cls.files = {
            runtime.CHART_PATH + "/" + name: payload
            for name, payload in fixtures.PreservationTests.chart.items()
        }
        cls.images = {}
        for i, service in enumerate(transition.SERVICES):
            values = yaml.safe_load(runtime.portfolio_defaults(service)[0])
            values["image"]["repository"] = cls.fork.image(service)
            values["image"]["digest"] = "sha256:" + str(i) * 64
            values["imagePullSecrets"] = []
            cls.images[service] = (
                values["image"]["repository"] + "@" + values["image"]["digest"]
            )
            cls.files[transition.PREFIX + f"environments/fork/{service}.yaml"] = (
                yaml.safe_dump(values).encode()
            )
            cls.files[transition.PREFIX + f"rendered/{service}.json"] = b"[]"
        cls.record = {
            "repository": cls.fork.repository,
            "branch": cls.fork.branch,
            "verifiedRevision": cls.sha,
            "visibility": "public",
            "runId": 123,
            "images": cls.images,
        }
        references, chart = runtime.published_defaults(cls.files)
        cls.values = {}
        review = preservation.review(
            fixtures.PreservationTests.connected,
            fixtures.PreservationTests.connected_services,
            references,
            chart,
            prepared_values=cls.values,
        )
        if review["status"] != "MATCHES_INSPECTED_FIELDS":
            raise AssertionError(review)
        cls.observed = {
            "status": "BLOCKED",
            "stateId": "fixture-state",
            "blockers": sorted(transition.PRESERVABLE_BLOCKERS),
            "preservationReview": {
                "connectionRecordConflict": False,
                "helmPreservation": review,
            },
        }

    def setUp(self):
        self.publication = copy.deepcopy((self.record, self.files, self.sha))
        self.observed = copy.deepcopy(type(self).observed)
        self.values = copy.deepcopy(type(self).values)

    def build(self):
        return transition.build_plan(
            self.fork, self.publication, self.observed, self.values
        )

    def test_private_plan_preserves_connections_and_pins_all_images_and_migration(self):
        before = copy.deepcopy((self.publication, self.values, self.observed))
        with patch.object(
            runtime.cluster, "run", side_effect=AssertionError("cluster write")
        ):
            plan = self.build()
        self.assertEqual(before, (self.publication, self.values, self.observed))
        self.assertEqual(plan["status"], "PREPARED_NOT_APPLIED")
        self.assertTrue(plan["configurationValuesIncluded"])
        for key in (
            "automaticSyncEnabled",
            "deploymentAuthorized",
            "existingRuntimeVerified",
            "sharedBootstrapPolicyVerified",
            "servicesChanged",
            "databaseChanged",
            "secretValuesRead",
        ):
            self.assertFalse(plan[key])
        self.assertEqual(
            plan["runtimePreflight"]["blockers"], self.observed["blockers"]
        )
        for service, app in zip(
            transition.SERVICES, plan["resources"][1:], strict=True
        ):
            spec = app["spec"]
            self.assertEqual(spec["source"]["targetRevision"], self.sha)
            self.assertNotIn("valueFiles", spec["source"]["helm"])
            self.assertEqual(
                spec["syncPolicy"]["automated"],
                {"enabled": False, "prune": False, "selfHeal": False},
            )
            self.assertEqual(spec["syncPolicy"]["retry"]["limit"], 0)
            self.assertNotIn("operation", app)
            for item in plan["rendered"][service]:
                if item["kind"] in {"Deployment", "Job"}:
                    for container in item["spec"]["template"]["spec"]["containers"]:
                        self.assertEqual(container["image"], self.images[service])
        core = plan["resources"][1]["spec"]["source"]["helm"]["valuesObject"]
        self.assertEqual(core["env"]["ACCOUNT_DEV_LOGIN_EMAIL"], "PRIVATE@example.test")
        self.assertEqual(core["env"]["COMBINATION_REVIEW_QUEUE_ENABLED"], "true")
        self.assertIn("ACCOUNT_DEV_LOGIN_PASSWORD", core["secretKeys"])
        self.assertNotIn("ACCOUNT_DEV_LOGIN_PASSWORD", core["env"])
        ops = plan["rendered"]["ops-service"]
        job = next(item for item in ops if item["kind"] == "Job")
        self.assertEqual(
            job["metadata"]["annotations"]["argocd.argoproj.io/hook"], "PreSync"
        )
        self.assertEqual(
            plan["resourcesSha256"],
            transition.digest(transition.encoded(plan["resources"])),
        )
        for service, resources in plan["rendered"].items():
            self.assertEqual(
                plan["renderedSha256"][service],
                transition.digest(transition.encoded(resources)),
            )

    def test_unpreserved_and_unknown_blockers_cannot_be_exported(self):
        for blocker in (
            "local_development_images",
            "service_routing_differs",
            "service_execution_or_storage_differs",
            "new_unknown_blocker",
        ):
            with self.subTest(blocker=blocker):
                self.observed["blockers"] = [blocker]
                with self.assertRaisesRegex(ValueError, "preservation is incomplete"):
                    self.build()

    def test_conflicting_connections_unknown_or_missing_preservation_cannot_be_exported(
        self,
    ):
        for change in (
            {"status": "UNKNOWN"},
            {"preservationReview": {"connectionRecordConflict": True}},
            {
                "preservationReview": {
                    "connectionRecordConflict": False,
                    "helmPreservation": {"status": "UNKNOWN"},
                }
            },
        ):
            with self.subTest(change=change):
                self.observed = type(self).observed | change
                with self.assertRaisesRegex(ValueError, "preservation is incomplete"):
                    self.build()

    def test_missing_values_and_image_or_storage_overrides_fail(self):
        original = copy.deepcopy(self.values)
        del self.values["ai-service"]
        with self.assertRaisesRegex(ValueError, "preservation is incomplete"):
            self.build()
        for key, value in (
            ("image", {"repository": "unverified"}),
            ("localMode", True),
            ("replicaCount", 2),
        ):
            self.values = copy.deepcopy(original)
            values = yaml.safe_load(self.values["core-service"])
            values[key] = value
            self.values["core-service"] = yaml.safe_dump(values).encode()
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "publication contract"),
            ):
                self.build()

    def test_missing_migration_hook_blocks_even_when_deployments_match(self):
        self.publication[1].pop(runtime.CHART_PATH + "/templates/ops-migration.yaml")
        with self.assertRaisesRegex(ValueError, "transition policy"):
            self.build()

    def test_wrong_helm_version_blocks(self):
        with (
            patch.object(transition.subprocess, "check_output", return_value="v3.0.0"),
            self.assertRaisesRegex(ValueError, "Pinned Helm"),
        ):
            self.build()

    def test_rendered_image_or_environment_drift_blocks(self):
        real_output = transition.subprocess.check_output
        for old, new, reason in (
            (
                self.images["core-service"],
                "ghcr.io/alice/other@sha256:" + "f" * 64,
                "published image",
            ),
            ("PRIVATE@example.test", "changed@example.test", "captured environment"),
        ):

            def changed(command, *args, old=old, new=new, **kwargs):
                result = real_output(command, *args, **kwargs)
                if command[1:3] == ["template", "core-service"]:
                    return result.replace(old.encode(), new.encode())
                return result

            with (
                self.subTest(reason=reason),
                patch.object(
                    transition.subprocess, "check_output", side_effect=changed
                ),
                self.assertRaisesRegex(ValueError, reason),
            ):
                self.build()

    @unittest.skipUnless(os.name == "posix", "Private output uses POSIX permissions")
    def test_complete_preparation_reads_only_deployments_and_services_and_writes_private_plan(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            settings = runtime.cluster.initial_settings(self.fork)
            deployments = copy.deepcopy(fixtures.PreservationTests.connected)
            services = copy.deepcopy(fixtures.PreservationTests.connected_services)
            for group in (deployments, services):
                for name, item in group.items():
                    item["metadata"].update(
                        uid=name + item["kind"], resourceVersion="1"
                    )

            def read(command, **kwargs):
                self.assertEqual(command[:3], ["kubectl", "-n", "govbiz-msa"])
                self.assertEqual(command[3], "get")
                self.assertIn(command[4], ("deployment", "service"))
                group = deployments if command[4] == "deployment" else services
                return json.dumps(group[command[5]])

            with (
                patch.object(
                    transition.deployment,
                    "verified_release",
                    side_effect=[copy.deepcopy(self.publication) for _ in range(4)],
                ) as verify,
                patch.object(runtime.cluster, "load_settings", return_value=settings),
                patch.object(runtime.cluster, "require_dev"),
                patch.object(
                    runtime.cluster,
                    "commands",
                    return_value=([], ["kubectl", "-n", "govbiz-msa"], []),
                ),
                patch.object(runtime.cluster, "run", side_effect=read) as commands,
                patch.object(
                    runtime,
                    "portfolio_defaults",
                    side_effect=AssertionError("checkout values"),
                ),
                patch.object(
                    runtime,
                    "chart_inputs",
                    side_effect=AssertionError("checkout chart"),
                ),
            ):
                report = transition.prepare(
                    Path("fixture-root"), self.fork, state, "gitops-transition-full"
                )
                checked = transition.verify_saved(
                    Path("fixture-root"), self.fork, state, "gitops-transition-full"
                )
            self.assertEqual(checked["status"], "REVALIDATED_NOT_APPLIED")
            self.assertFalse(checked["deploymentAuthorized"])
            self.assertEqual(verify.call_count, 4)
            self.assertEqual(commands.call_count, 32)
            self.assertEqual(report["status"], "PREPARED_NOT_APPLIED")
            self.assertNotIn("PRIVATE", json.dumps(report))
            plan = json.loads(
                (state / "gitops-transition-full/transition.json").read_bytes()
            )
            self.assertIn("PRIVATE@example.test", json.dumps(plan))
            self.assertEqual(plan["stateId"], settings["stateId"])
            self.assertIn(
                "connected_or_unverified_ops", plan["runtimePreflight"]["blockers"]
            )


@unittest.skipUnless(os.name == "posix", "Private POSIX output; Windows uses WSL")
class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.state = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.fork = Fork("alice/project", "main")
        self.name = "gitops-transition-test"
        self.publication = ({"runId": 123}, {}, "a" * 40)
        self.plan = {
            "schema": "msa-gitops-transition-v1",
            "status": "PREPARED_NOT_APPLIED",
            "sourceSha": "a" * 40,
            "publisherRunId": 123,
            "stateId": "fixture",
            "automaticSyncEnabled": False,
            "existingRuntimeVerified": False,
            "deploymentAuthorized": False,
            "publishedReferenceVerified": True,
            "sharedBootstrapPolicyVerified": False,
            "secretValuesRead": False,
            "servicesChanged": False,
            "databaseChanged": False,
            "pendingChecks": ["backup_and_restore"],
            "resources": ["PRIVATE local configuration"],
            "configurationValuesIncluded": True,
        }

    def prepare(self, releases=None, observation=None):
        with (
            patch.object(
                transition.deployment,
                "verified_release",
                side_effect=releases
                or [self.publication, copy.deepcopy(self.publication)],
            ) as verify,
            patch.object(
                runtime,
                "preflight",
                side_effect=observation,
                return_value={"status": "BLOCKED"},
            ) as observe,
            patch.object(transition, "build_plan", return_value=self.plan),
        ):
            result = transition.prepare(
                Path("fixture-root"), self.fork, self.state, self.name
            )
        self.assertEqual(verify.call_count, 2)
        for call in verify.call_args_list:
            self.assertEqual(call.kwargs, {"verify_public_manifests": True})
        self.assertTrue(observe.call_args.kwargs["review_preservation"])
        self.assertIn("prepared_values", observe.call_args.kwargs)
        return result

    def test_export_is_private_and_report_contains_no_configuration(self):
        result = self.prepare()
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertFalse(result["configurationValuesIncluded"])
        output = self.state / self.name
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        path = output / "transition.json"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(path.read_bytes()), self.plan)
        self.assertEqual((output / ".gitignore").read_text(), "*\n")

    def test_publication_changed_or_verification_failure_writes_nothing(self):
        for confirmation in (
            self.publication[:2] + ("b" * 40,),
            ValueError("PRIVATE CI changed"),
        ):
            with self.subTest(confirmation=confirmation), self.assertRaises(ValueError):
                self.prepare(releases=[self.publication, confirmation])
            self.assertEqual(list(self.state.iterdir()), [])

    def test_missing_publication_never_reads_cluster(self):
        with patch.object(runtime, "preflight") as read, self.assertRaises(ValueError):
            self.prepare(releases=[ValueError("No complete verified publication")])
        read.assert_not_called()
        self.assertEqual(list(self.state.iterdir()), [])

    def test_existing_output_unsafe_names_and_symlink_are_rejected(self):
        existing = self.state / self.name
        existing.mkdir()
        (existing / "keep").write_text("keep")
        for name in (
            self.name,
            "../outside",
            "/absolute",
            "gitops-transition-x/y",
            "gitops-transition-x\\y",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                transition.output_path(self.state, name)
        link = self.state / "gitops-transition-link"
        link.symlink_to(self.state / "missing")
        with self.assertRaises(ValueError):
            transition.output_path(self.state, link.name)
        self.assertEqual((existing / "keep").read_text(), "keep")

    def test_shared_state_and_symlinked_state_fail(self):
        self.state.chmod(0o777)
        try:
            with self.assertRaises(ValueError):
                transition.output_path(self.state, self.name)
        finally:
            self.state.chmod(0o700)
        link = self.state / "link"
        link.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(ValueError):
            transition.output_path(link, self.name)

    def test_partial_write_is_removed_without_touching_siblings(self):
        sibling = self.state / "keep"
        sibling.write_text("keep")
        real_open = transition.os.open

        def fail(path, *args):
            if Path(path).name == "transition.json":
                raise OSError("PRIVATE disk failure")
            return real_open(path, *args)

        with (
            patch.object(transition.os, "open", side_effect=fail),
            self.assertRaises(OSError),
        ):
            transition.write_plan(self.state / self.name, self.plan)
        self.assertEqual(list(self.state.iterdir()), [sibling])
        self.assertEqual(sibling.read_text(), "keep")

    def test_cli_failure_never_prints_external_exception_or_local_values(self):
        output = io.StringIO()
        with (
            patch(
                "sys.argv",
                [
                    "gitops_transition.py",
                    "--state-dir",
                    str(self.state),
                    "--output-name",
                    self.name,
                ],
            ),
            patch.object(transition, "from_origin", return_value=self.fork),
            patch.object(
                transition,
                "prepare",
                side_effect=subprocess.CalledProcessError(
                    1, ["PRIVATE"], stderr=b"PRIVATE"
                ),
            ),
            redirect_stdout(output),
        ):
            self.assertEqual(transition.main(), 1)
        self.assertNotIn("PRIVATE", output.getvalue())
        self.assertFalse(json.loads(output.getvalue())["deploymentAuthorized"])

    def test_cli_explains_missing_publication_without_exposing_errors(self):
        output = io.StringIO()
        blocker = {"status": "BLOCKED", "stage": "required_ci", "advisoryOnly": True}
        with (
            patch(
                "sys.argv",
                [
                    "gitops_transition.py",
                    "--state-dir",
                    str(self.state),
                    "--output-name",
                    self.name,
                ],
            ),
            patch.object(transition, "from_origin", return_value=self.fork),
            patch.object(
                transition,
                "prepare",
                side_effect=ValueError("No complete verified publication: PRIVATE"),
            ),
            patch.object(
                transition.deployment, "publication_blocker", return_value=blocker
            ) as explain,
            redirect_stdout(output),
        ):
            self.assertEqual(transition.main(), 1)
        explain.assert_called_once_with(self.fork)
        report = json.loads(output.getvalue())
        self.assertEqual(report["reason"], "publication_not_verified")
        self.assertEqual(report["publicationBlocker"], blocker)
        self.assertNotIn("PRIVATE", output.getvalue())


if __name__ == "__main__":
    unittest.main()
