"""Local Argo planning conflicts without credentials, Docker or cluster mutations."""

import copy
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import deployment
import gitops_runtime as runtime
from repository import Fork

FORK = Fork("alice/project", "main")


class RuntimePreflightTests(unittest.TestCase):
    def setUp(self):
        stack = self.enterContext(ExitStack())
        self.state = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        self.settings = runtime.cluster.initial_settings(FORK)
        self.deployments = {
            service: {
                "kind": "Deployment",
                "metadata": {
                    "name": service,
                    "namespace": "govbiz-msa",
                    "uid": service + "-uid",
                    "resourceVersion": "1",
                },
                "spec": {
                    "selector": {"matchLabels": {"app": service}},
                    "replicas": 1,
                    "strategy": {"type": "Recreate"},
                    "template": {
                        "metadata": {"labels": {"app": service}},
                        "spec": {
                            "volumes": [
                                {"name": "tmp", "emptyDir": {"sizeLimit": "256Mi"}}
                            ],
                            "containers": [
                                {
                                    "name": service,
                                    "volumeMounts": [
                                        {"name": "tmp", "mountPath": "/tmp"}
                                    ],
                                    "env": copy.deepcopy(
                                        runtime.portfolio_defaults(service)[1]
                                    ),
                                }
                            ],
                        },
                    },
                },
            }
            for service in runtime.cluster.SERVICES
        }
        self.services = {
            service: {
                "kind": "Service",
                "metadata": {
                    "name": service,
                    "namespace": "govbiz-msa",
                    "uid": service + "-service-uid",
                    "resourceVersion": "1",
                },
                "spec": {
                    "selector": {"app": service},
                    "ports": [{"port": 8080}],
                },
            }
            for service in runtime.cluster.SERVICES
        }
        self.deployment = self.deployments["ops-service"]
        self.real_render = runtime.rendered_defaults
        self.render = stack.enter_context(
            patch.object(
                runtime,
                "rendered_defaults",
                return_value=copy.deepcopy((self.deployments, self.services)),
            )
        )
        self.load = stack.enter_context(
            patch.object(runtime.cluster, "load_settings", return_value=self.settings)
        )
        self.owner = stack.enter_context(patch.object(runtime.cluster, "require_dev"))
        stack.enter_context(
            patch.object(
                runtime.cluster,
                "commands",
                return_value=(["kubectl"], ["kubectl", "-n", "govbiz-msa"], []),
            )
        )
        self.command = stack.enter_context(
            patch.object(runtime.cluster, "run", side_effect=self.read)
        )

    def read(self, command, *, capture, timeout):
        if self.settings["mode"] == "gitops":
            self.argo_owner.assert_called()
            if command == ["get", "appproject", "govbiz-fork", "-o", "json"]:
                self.assertTrue(capture)
                self.assertEqual(timeout, 15)
                return json.dumps(self.project)
        else:
            self.owner.assert_called()
        service = command[-3]
        kind = command[-4]
        self.assertIn(kind, ("deployment", "service"))
        self.assertIn(service, runtime.cluster.SERVICES)
        self.assertEqual(
            command,
            [
                "kubectl",
                "-n",
                "govbiz-msa",
                "get",
                kind,
                service,
                "-o",
                "json",
            ],
        )
        self.assertTrue(capture)
        self.assertEqual(timeout, 15)
        if kind == "service":
            return json.dumps(self.services[service])
        return json.dumps(
            self.deployment if service == "ops-service" else self.deployments[service]
        )

    def enable_gitops(self):
        self.settings["mode"] = "gitops"
        self.project, *self.apps = runtime.argo_resources(FORK)
        self.project["metadata"]["uid"] = "project-uid"
        for app in self.apps:
            app["metadata"]["uid"] = app["metadata"]["name"] + "-uid"
            source = app["spec"]["source"]
            source["targetRevision"] = "a" * 40
            source["helm"].pop("valueFiles")
            source["helm"]["valuesObject"] = {"env": {"PRIVATE_VALUE": "do-not-print"}}
            app["spec"]["syncPolicy"]["automated"] = {
                "enabled": False,
                "prune": False,
                "selfHeal": False,
            }
            app["spec"]["syncPolicy"]["retry"]["limit"] = 0
            app["status"] = {
                "sync": {"status": "Synced", "revision": "a" * 40},
                "health": {"status": "Healthy"},
                "operationState": {"phase": "Succeeded"},
            }
        self.argo_owner = self.enterContext(
            patch.object(runtime.cluster, "verify_context")
        )
        self.applications = self.enterContext(
            patch.object(
                runtime.cluster,
                "applications",
                side_effect=lambda *args: copy.deepcopy(self.apps),
            )
        )

    def test_gitops_followup_preserves_ownership_and_captures_only_stable_inputs(self):
        self.enable_gitops()
        before = copy.deepcopy(
            (self.apps, self.project, self.deployments, self.services)
        )
        captured = {}
        report = runtime.preflight(
            self.state,
            FORK,
            review_preservation=True,
            published_files=self.published_files(),
            prepared_values=captured,
        )
        self.owner.assert_not_called()
        self.assertEqual(self.argo_owner.call_count, 2)
        self.assertEqual(set(captured), set(runtime.cluster.SERVICES))
        self.assertEqual(
            set(report["argoObservation"]["applications"]),
            set(runtime.cluster.SERVICES),
        )
        self.assertEqual(report["argoObservation"]["projectUid"], "project-uid")
        self.assertNotIn("do-not-print", json.dumps(report))
        self.assertFalse(report["deploymentAuthorized"])
        self.assertFalse(report["servicesChanged"])
        self.assertEqual(
            before, (self.apps, self.project, self.deployments, self.services)
        )
        self.assertEqual(list(self.state.iterdir()), [])

    def test_evaluation_handoff_apps_do_not_break_ops_source_observation(self):
        self.enable_gitops()
        before = runtime.argo_observation(self.state, self.settings)
        evaluation = {
            "metadata": {"name": "govbiz-evaluation-prefect", "namespace": "argocd"},
            "spec": {
                "project": "govbiz-evaluation",
                "destination": {
                    "server": "https://kubernetes.default.svc",
                    "namespace": "govbiz-evaluation",
                },
            },
        }
        for name in ("prefect", "ops-artifacts", "evaluation-runner"):
            app = copy.deepcopy(evaluation)
            app["metadata"]["name"] = "govbiz-evaluation-" + name
            self.apps.append(app)
        self.assertEqual(runtime.argo_observation(self.state, self.settings), before)
        for field in ("project", "namespace", "name"):
            bad = copy.deepcopy(evaluation)
            if field == "project":
                bad["spec"][field] = "govbiz-fork"
            elif field == "namespace":
                bad["spec"]["destination"][field] = "govbiz-msa"
            else:
                bad["metadata"][field] = "unexpected"
            self.apps.append(bad)
            with self.subTest(field=field), self.assertRaises(ValueError):
                runtime.argo_observation(self.state, self.settings)
            self.apps.pop()

    def test_gitops_active_unpinned_or_foreign_applications_are_rejected(self):
        self.enable_gitops()
        original = copy.deepcopy(self.apps)
        for path, value in (
            (("metadata", "uid"), ""),
            (("metadata", "namespace"), "other"),
            (("metadata", "deletionTimestamp"), "now"),
            (("spec", "project"), "other"),
            (("spec", "destination", "namespace"), "other"),
            (("spec", "destination", "server"), "https://foreign.invalid"),
            (("spec", "sources"), []),
            (("spec", "source", "repoURL"), "https://github.com/other/repository.git"),
            (("spec", "source", "path"), "another-chart"),
            (("spec", "source", "targetRevision"), "main"),
            (("spec", "source", "helm", "parameters"), []),
            (("spec", "source", "helm", "releaseName"), "other"),
            (("spec", "source", "helm", "kubeVersion"), "1.20.0"),
            (("spec", "syncPolicy", "automated", "enabled"), True),
            (("spec", "syncPolicy", "automated", "enabled"), 0),
            (("spec", "syncPolicy", "automated", "prune"), True),
            (("spec", "syncPolicy", "automated", "selfHeal"), True),
            (("spec", "syncPolicy", "retry", "limit"), 1),
            (("spec", "syncPolicy", "retry", "limit"), False),
            (("operation",), {"sync": {}}),
            (("status", "operationState", "phase"), "Running"),
            (("status", "operationState", "phase"), "Failed"),
            (("status", "sync", "status"), "OutOfSync"),
            (("status", "sync", "revision"), "b" * 40),
            (("status", "health", "status"), "Progressing"),
        ):
            self.apps = copy.deepcopy(original)
            target = self.apps[0]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            captured = {}
            with (
                self.subTest(path=path, value=value),
                self.assertRaisesRegex(ValueError, "manual Applications"),
            ):
                runtime.preflight(
                    self.state,
                    FORK,
                    review_preservation=True,
                    published_files=self.published_files(),
                    prepared_values=captured,
                )
            self.assertEqual(captured, {})

    def stopped_ops_app(self):
        app = next(
            app
            for app in self.apps
            if app["metadata"]["name"] == "govbiz-fork-ops-service"
        )
        app["status"]["sync"]["status"] = "OutOfSync"
        app["status"]["resources"] = [
            {
                "group": "apps",
                "kind": "Deployment",
                "namespace": "govbiz-msa",
                "name": "ops-service",
                "status": "OutOfSync",
            }
        ]
        return app

    def test_stopped_backup_allows_only_ops_drift_without_loosening_planning(self):
        self.enable_gitops()
        before = runtime.argo_observation(self.state, self.settings)
        self.stopped_ops_app()
        self.assertEqual(
            runtime.argo_observation(self.state, self.settings, stopped_ops=True),
            before,
        )
        with self.assertRaises(ValueError):
            runtime.argo_observation(self.state, self.settings)
        self.owner.assert_not_called()

    def test_stopped_backup_rejects_unknown_other_or_prunable_drift(self):
        self.enable_gitops()
        app = self.stopped_ops_app()
        row = copy.deepcopy(app["status"]["resources"][0])
        for resources in (
            None,
            [],
            [{}],
            [row, row],
            [row | {"name": "other"}],
            [row | {"namespace": "other"}],
            [row | {"kind": "Service"}],
            [row | {"status": "Unknown"}],
            [row | {"requiresPruning": True}],
            [row, {"status": "Synced", "requiresPruning": True}],
        ):
            app["status"]["resources"] = resources
            with self.subTest(resources=resources), self.assertRaises(ValueError):
                runtime.argo_observation(self.state, self.settings, stopped_ops=True)
        app["status"]["resources"] = [row]
        other = next(item for item in self.apps if item is not app)
        other["status"]["sync"]["status"] = "OutOfSync"
        with self.assertRaises(ValueError):
            runtime.argo_observation(self.state, self.settings, stopped_ops=True)

    def test_stopped_backup_keeps_manual_operation_and_ownership_guards(self):
        self.enable_gitops()
        app = self.stopped_ops_app()
        original = copy.deepcopy(app)
        for path, value in (
            (("metadata", "uid"), ""),
            (("spec", "syncPolicy", "automated", "enabled"), True),
            (("spec", "syncPolicy", "automated", "selfHeal"), True),
            (("spec", "syncPolicy", "retry", "limit"), 1),
            (("operation",), {"sync": {}}),
            (("status", "operationState", "phase"), "Running"),
            (("status", "operationState", "phase"), "Failed"),
            (("status", "health", "status"), "Degraded"),
        ):
            app.clear()
            app.update(copy.deepcopy(original))
            target = app
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError):
                runtime.argo_observation(self.state, self.settings, stopped_ops=True)

    def test_gitops_project_and_application_set_cannot_be_adopted(self):
        self.enable_gitops()
        original_project, original_apps = copy.deepcopy((self.project, self.apps))
        for change in ("policy", "project_uid", "missing", "extra", "duplicate"):
            self.project, self.apps = copy.deepcopy((original_project, original_apps))
            if change == "policy":
                self.project["spec"]["clusterResourceWhitelist"] = [
                    {"group": "*", "kind": "*"}
                ]
            elif change == "project_uid":
                self.project["metadata"].pop("uid")
            elif change == "missing":
                self.apps.pop()
            elif change == "extra":
                self.apps.append(copy.deepcopy(self.apps[0]))
            else:
                self.apps[-1] = copy.deepcopy(self.apps[0])
            with self.subTest(change=change), self.assertRaises(ValueError):
                runtime.preflight(self.state, FORK)

    def test_gitops_change_during_observation_does_not_release_private_values(self):
        self.enable_gitops()
        original = copy.deepcopy(self.apps)
        for change in ("uid", "values", "active"):
            self.apps = copy.deepcopy(original)
            count = 0

            def changing(*args):
                nonlocal count
                count += 1
                if count == 2:
                    if change == "uid":
                        self.apps[0]["metadata"]["uid"] = "replacement"
                    elif change == "values":
                        self.apps[0]["spec"]["source"]["helm"]["valuesObject"][
                            "changed"
                        ] = True
                    else:
                        self.apps[0]["operation"] = {"sync": {}}
                return copy.deepcopy(self.apps)

            self.applications.side_effect = changing
            captured = {}
            with self.subTest(change=change), self.assertRaises(ValueError):
                runtime.preflight(
                    self.state,
                    FORK,
                    review_preservation=True,
                    published_files=self.published_files(),
                    prepared_values=captured,
                )
            self.assertEqual(captured, {})

    def test_gitops_wrong_or_changed_cluster_owner_stops_planning(self):
        self.enable_gitops()
        for observations in (
            [ValueError("wrong owner")],
            [None, ValueError("changed owner")],
        ):
            self.argo_owner.side_effect = observations
            captured = {}
            with (
                self.subTest(count=len(observations)),
                self.assertRaisesRegex(ValueError, "owner"),
            ):
                runtime.preflight(
                    self.state,
                    FORK,
                    review_preservation=True,
                    published_files=self.published_files(),
                    prepared_values=captured,
                )
            self.assertEqual(captured, {})

    def test_bootstrap_only_observation_is_not_deployment_approval(self):
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["status"], "NO_LOCAL_OVERRIDES")
        self.assertEqual(report["blockers"], [])
        for name in ("servicesChanged", "databaseChanged", "deploymentAuthorized"):
            self.assertFalse(report[name])
        self.assertEqual(self.command.call_count, 16)
        self.assertEqual(self.owner.call_count, 2)
        self.assertEqual(
            set(report["inspectedServices"]), set(runtime.cluster.SERVICES)
        )
        self.assertEqual(
            set(report["preservationReview"]["serviceReviews"]),
            {"core-service", "catalog-service", "ai-service"},
        )
        self.assertEqual(list(self.state.iterdir()), [])

    def published_files(self):
        return {
            runtime.CHART_PATH + "/" + name: payload
            for name, payload in runtime.chart_inputs().items()
        } | {
            f"infrastructure/gitops/environments/fork/{service}.yaml": runtime.portfolio_defaults(
                service
            )[0]
            for service in runtime.cluster.SERVICES
        }

    def test_private_values_are_returned_only_after_stable_published_observation(self):
        captured = {}
        report = runtime.preflight(
            self.state,
            FORK,
            review_preservation=True,
            published_files=self.published_files(),
            prepared_values=captured,
        )
        self.assertEqual(set(captured), set(runtime.cluster.SERVICES))
        self.assertFalse(report["deploymentAuthorized"])
        self.assertFalse(report["preservationReview"]["configurationValuesIncluded"])
        self.assertEqual(self.command.call_count, 16)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_private_values_do_not_escape_if_runtime_changes_after_capture(self):
        captured = {}
        original = self.read
        count = 0

        def changed(command, **kwargs):
            nonlocal count
            count += 1
            if count == 9:
                self.deployments["core-service"]["metadata"]["resourceVersion"] = "2"
            return original(command, **kwargs)

        self.command.side_effect = changed
        with self.assertRaisesRegex(ValueError, "changed during preflight"):
            runtime.preflight(
                self.state,
                FORK,
                review_preservation=True,
                published_files=self.published_files(),
                prepared_values=captured,
            )
        self.assertEqual(captured, {})

    def test_private_capture_requires_published_preservation_and_empty_destination(
        self,
    ):
        for options in (
            {"prepared_values": {}},
            {"review_preservation": True, "prepared_values": {}},
            {
                "review_preservation": True,
                "published_files": self.published_files(),
                "prepared_values": {"stale": b"value"},
            },
        ):
            with (
                self.subTest(options=options),
                self.assertRaisesRegex(ValueError, "Preparation requires"),
            ):
                runtime.preflight(self.state, FORK, **options)
        self.command.assert_not_called()

    def test_preservation_rehearsal_does_not_remove_existing_blockers(self):
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        container["env"].append({"name": "CUSTOM", "value": "PRIVATE"})
        details = {"status": "MATCHES_INSPECTED_FIELDS"}
        with patch("gitops_preservation.review", return_value=details) as rehearse:
            report = runtime.preflight(self.state, FORK, review_preservation=True)
        self.assertEqual(report["status"], "BLOCKED")
        self.assertIn("ops_environment_differs", report["blockers"])
        self.assertEqual(report["preservationReview"]["helmPreservation"], details)
        self.assertFalse(report["deploymentAuthorized"])
        self.assertEqual(rehearse.call_args.args[-1], "helm")
        self.assertEqual(self.command.call_count, 16)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_changes_during_preservation_rehearsal_invalidate_the_observation(self):
        def change(*args):
            self.deployment["metadata"]["resourceVersion"] = "2"
            return {"status": "MATCHES_INSPECTED_FIELDS"}

        with (
            patch("gitops_preservation.review", side_effect=change),
            self.assertRaisesRegex(ValueError, "changed during preflight"),
        ):
            runtime.preflight(self.state, FORK, review_preservation=True)

    def test_unsuccessful_preservation_blocks_even_without_local_overrides(self):
        for status in ("BLOCKED", "UNKNOWN"):
            with (
                self.subTest(status=status),
                patch("gitops_preservation.review", return_value={"status": status}),
            ):
                report = runtime.preflight(self.state, FORK, review_preservation=True)
            self.assertEqual(report["status"], status)
            self.assertEqual(report["blockers"], ["preservation_not_verified"])
            self.assertFalse(report["deploymentAuthorized"])

    def test_connected_ops_is_detected_without_saved_activation_records(self):
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        for env in (
            [],
            [{"name": "PREFECT_API_URL", "value": "http://private/?token=PRIVATE"}],
            [
                {
                    "name": "PREFECT_API_URL",
                    "valueFrom": {"secretKeyRef": {"name": "private", "key": "url"}},
                }
            ],
        ):
            with self.subTest(env=env):
                container["env"] = env
                report = runtime.preflight(self.state, FORK)
                self.assertIn("connected_or_unverified_ops", report["blockers"])
                self.assertIn("ops_environment_differs", report["blockers"])
                self.assertNotIn("PRIVATE", json.dumps(report))
                self.assertNotIn("private", json.dumps(report))

    def publication_files(self):
        files = {
            runtime.CHART_PATH + "/" + name: payload
            for name, payload in runtime.chart_inputs().items()
        }
        files.update(
            {
                f"infrastructure/gitops/environments/fork/{service}.yaml": runtime.portfolio_defaults(
                    service
                )[0]
                for service in runtime.cluster.SERVICES
            }
        )
        return files

    def test_published_references_do_not_fall_back_to_checkout_inputs(self):
        files = self.publication_files()
        with (
            patch.object(
                runtime, "chart_inputs", side_effect=AssertionError("checkout")
            ),
            patch.object(
                runtime, "portfolio_defaults", side_effect=AssertionError("checkout")
            ),
        ):
            report = runtime.preflight(self.state, FORK, published_files=files)
        self.assertEqual(report["status"], "NO_LOCAL_OVERRIDES")
        review = report["preservationReview"]
        self.assertEqual(review["reference"], "verified_publication_ops_defaults")
        self.assertTrue(
            all(
                item["reference"] == "verified_publication_service_defaults"
                for item in review["serviceReviews"].values()
            )
        )
        self.assertEqual(
            self.render.call_args.args[2], runtime.published_defaults(files)[1]
        )
        self.assertEqual(self.command.call_count, 16)
        self.assertFalse(report["deploymentAuthorized"])

    def test_published_input_changes_during_rehearsal_invalidate_result(self):
        files = self.publication_files()

        def change(*args):
            files[runtime.CHART_PATH + "/values.yaml"] += b"\n"
            return {"status": "MATCHES_INSPECTED_FIELDS"}

        with (
            patch("gitops_preservation.review", side_effect=change),
            self.assertRaisesRegex(ValueError, "Published inputs changed"),
        ):
            runtime.preflight(
                self.state, FORK, review_preservation=True, published_files=files
            )

    def test_placement_changes_block_checkout_and_published_reviews(self):
        for service in runtime.cluster.SERVICES:
            pod = self.deployments[service]["spec"]["template"]["spec"]
            pod["nodeSelector"] = {"PRIVATE-label": "PRIVATE-node"}
            pod["schedulerName"] = "PRIVATE-scheduler"
        for files in (None, self.publication_files()):
            with self.subTest(published=files is not None):
                report = runtime.preflight(self.state, FORK, published_files=files)
                self.assertEqual(report["status"], "BLOCKED")
                self.assertEqual(report["blockers"], ["service_runtime_policy_differs"])
                for details in report["preservationReview"]["policyReviews"].values():
                    self.assertEqual(
                        details["changedFields"], ["nodeSelector", "schedulerName"]
                    )
                self.assertFalse(report["deploymentAuthorized"])
                self.assertNotIn("PRIVATE", json.dumps(report))

    def test_sync_container_and_saved_bridge_are_blocked(self):
        containers = self.deployment["spec"]["template"]["spec"]["containers"]
        containers.append(copy.deepcopy(containers[0]) | {"name": "ops-sync"})
        record = runtime.ops_runtime.connection(self.settings, "personal-compose")
        for name in (runtime.ops_runtime.BRIDGE, runtime.ops_runtime.PROFILE):
            path = self.state / name
            path.write_text(json.dumps(record))
            report = runtime.preflight(self.state, FORK)
            self.assertEqual(report["status"], "BLOCKED")
            self.assertEqual(
                report["blockers"],
                ["connected_or_unverified_ops", "ops_container_layout_differs"],
            )
            self.assertEqual(json.loads(path.read_text()), record)
            path.unlink()

    def test_local_profiles_and_development_images_must_not_be_discarded(self):
        profile = {key: self.settings[key] for key in ("repository", "stateId")}
        profile.update(
            schemaVersion=1,
            features=["ai"],
            origin="http://localhost:5173",
            revision="a" * 32,
            modelKeys=[],
        )
        (self.state / "integrations.json").write_text(json.dumps(profile))
        (self.state / "dev-images.json").write_text("PRIVATE image configuration")
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(
            report["blockers"],
            ["local_integration_profile", "local_development_images"],
        )
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_foreign_state_or_unowned_cluster_stops_before_reading_deployment(self):
        self.load.return_value = self.settings | {"repository": "bob/project"}
        with self.assertRaisesRegex(ValueError, "another repository"):
            runtime.preflight(self.state, FORK)
        self.owner.assert_not_called()
        self.command.assert_not_called()
        self.load.return_value = self.settings
        self.owner.side_effect = ValueError("wrong cluster owner")
        with self.assertRaisesRegex(ValueError, "wrong cluster owner"):
            runtime.preflight(self.state, FORK)
        self.command.assert_not_called()

    def test_foreign_connection_record_is_not_treated_as_bootstrap(self):
        record = runtime.ops_runtime.connection(self.settings, "other-compose") | {
            "stateId": "b" * 32
        }
        (self.state / runtime.ops_runtime.BRIDGE).write_text(json.dumps(record))
        with self.assertRaises(ValueError):
            runtime.preflight(self.state, FORK)
        self.command.assert_not_called()

    def test_deployment_or_local_state_changes_cannot_pass(self):
        first = [
            json.dumps(resources[service])
            for resources in (self.deployments, self.services)
            for service in runtime.cluster.SERVICES
        ]
        changed = copy.deepcopy(self.deployments["core-service"])
        changed["metadata"]["resourceVersion"] = "2"
        self.command.side_effect = first + [json.dumps(changed)]
        with self.assertRaisesRegex(ValueError, "changed during preflight"):
            runtime.preflight(self.state, FORK)
        self.command.side_effect = self.read
        self.load.side_effect = [self.settings, self.settings | {"stateId": "b" * 32}]
        with self.assertRaisesRegex(ValueError, "changed during preflight"):
            runtime.preflight(self.state, FORK)
        self.load.side_effect = None
        with (
            patch.object(
                runtime,
                "local_inputs",
                side_effect=[
                    {
                        "integration": None,
                        "development_images": False,
                        "connections": {},
                    },
                    {
                        "integration": None,
                        "development_images": True,
                        "connections": {},
                    },
                ],
            ),
            self.assertRaisesRegex(ValueError, "changed during preflight"),
        ):
            runtime.preflight(self.state, FORK)

    def test_missing_or_deleting_deployment_is_not_a_clean_runtime(self):
        for change in (
            {"uid": None},
            {"deletionTimestamp": "now"},
            {"namespace": "other"},
        ):
            original = copy.deepcopy(self.deployment)
            self.deployment["metadata"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                runtime.preflight(self.state, FORK)
            self.deployment = original

    def test_environment_diff_names_are_complete_but_values_and_references_are_hidden(
        self,
    ):
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        env = {row["name"]: row for row in container["env"]}
        env["PREFECT_API_URL"]["value"] = "https://PRIVATE-prefect/?token=PRIVATE"
        env["DB_PASSWORD"]["valueFrom"]["secretKeyRef"]["name"] = "PRIVATE-secret"
        env.pop("DB_HOST")
        env["LLMOPS_ARTIFACT_TOKEN"] = {
            "name": "LLMOPS_ARTIFACT_TOKEN",
            "value": "PRIVATE-token",
        }
        env["LLMOPS_ARTIFACT_URL"] = {
            "name": "LLMOPS_ARTIFACT_URL",
            "value": "https://PRIVATE-artifacts",
        }
        container["env"] = list(reversed(env.values()))
        report = runtime.preflight(self.state, FORK)
        details = report["preservationReview"]
        self.assertEqual(
            details["environmentChanges"]["ops-service"],
            {
                "changed": ["DB_PASSWORD", "PREFECT_API_URL"],
                "runtimeOnly": ["LLMOPS_ARTIFACT_TOKEN", "LLMOPS_ARTIFACT_URL"],
                "missing": ["DB_HOST"],
            },
        )
        self.assertEqual(details["reference"], "checkout_portfolio_ops_defaults")
        self.assertEqual(len(details["referenceSha256"]), 64)
        self.assertFalse(details["configurationValuesIncluded"])
        self.assertFalse(details["overlayGenerated"])
        self.assertIn("ops_environment_differs", report["blockers"])
        self.assertNotIn("PRIVATE", json.dumps(report))
        self.assertNotIn("https://", json.dumps(report))

    def test_environment_order_is_ignored_and_missing_expected_values_block(self):
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        container["env"].reverse()
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["status"], "NO_LOCAL_OVERRIDES")
        self.assertEqual(
            report["preservationReview"]["environmentChanges"]["ops-service"],
            {
                "changed": [],
                "runtimeOnly": [],
                "missing": [],
            },
        )
        container["env"] = [row for row in container["env"] if row["name"] != "DB_NAME"]
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["blockers"], ["ops_environment_differs"])

    def test_env_from_is_reported_as_uninspected_and_blocks_without_secret_access(self):
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        container["envFrom"] = [{"secretRef": {"name": "PRIVATE-secret"}}]
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["blockers"], ["ops_env_from_uninspected"])
        self.assertEqual(
            report["preservationReview"]["uninspectedEnvFrom"], ["ops-service"]
        )
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_ambiguous_environment_is_rejected_instead_of_silently_overwritten(self):
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        for env in (
            [
                {"name": "DUPLICATE", "value": "PRIVATE-one"},
                {"name": "DUPLICATE", "value": "PRIVATE-two"},
            ],
            [{"name": "INVALID PRIVATE", "value": "PRIVATE"}],
            [{"name": "VALUE", "value": "PRIVATE", "valueFrom": {"secretKeyRef": {}}}],
            [{"name": "VALUE", "value": 1}],
            [{"name": "VALUE", "valueFrom": {}}],
        ):
            container["env"] = env
            with self.subTest(env=env), self.assertRaises(ValueError):
                runtime.preflight(self.state, FORK)

    def test_changed_reference_file_cannot_return_a_stable_comparison(self):
        defaults = runtime.portfolio_defaults
        for target in runtime.cluster.SERVICES:
            seen = set()

            def changing(service):
                payload, env = defaults(service)
                if service == target and service in seen:
                    payload += b"\n"
                seen.add(service)
                return payload, env

            with (
                self.subTest(service=target),
                patch.object(runtime, "portfolio_defaults", side_effect=changing),
                self.assertRaisesRegex(ValueError, "changed during preflight"),
            ):
                runtime.preflight(self.state, FORK)

    def test_saved_feature_names_and_connection_disagreement_are_preserved(self):
        profile = {key: self.settings[key] for key in ("repository", "stateId")}
        profile.update(
            schemaVersion=1,
            features=["mail", "ai"],
            origin="http://localhost:5173",
            revision="a" * 32,
            modelKeys=["OPENAI_MODEL"],
        )
        (self.state / "integrations.json").write_text(json.dumps(profile))
        for name, project in (
            (runtime.ops_runtime.PROFILE, "project-one"),
            (runtime.ops_runtime.BRIDGE, "project-two"),
        ):
            (self.state / name).write_text(
                json.dumps(runtime.ops_runtime.connection(self.settings, project))
            )
        report = runtime.preflight(self.state, FORK)
        details = report["preservationReview"]
        self.assertEqual(details["integrationFeatures"], ["ai", "mail"])
        self.assertEqual(details["modelSettingNames"], ["OPENAI_MODEL"])
        self.assertTrue(details["connectionRecordConflict"])
        self.assertNotIn("project-one", json.dumps(report))
        self.assertNotIn("localhost", json.dumps(report))

    @unittest.skipUnless(
        shutil.which("helm"), "Pinned Helm required for real rendering"
    )
    def test_reference_environment_matches_actual_helm_rendering(self):
        references = {
            service: runtime.portfolio_defaults(service)
            for service in runtime.cluster.SERVICES
        }
        expected, expected_services = self.real_render(
            "helm", references, runtime.chart_inputs()
        )
        for service, workload in self.deployments.items():
            workload["spec"] = copy.deepcopy(expected[service]["spec"])
            container = workload["spec"]["template"]["spec"]["containers"][0]
            for field in ("startupProbe", "livenessProbe", "readinessProbe"):
                container[field]["successThreshold"] = 1
                container[field]["httpGet"]["scheme"] = "HTTP"
            container["ports"][0]["protocol"] = "TCP"
            self.services[service]["spec"] = copy.deepcopy(
                expected_services[service]["spec"]
            )
            self.services[service]["spec"].update(
                clusterIP="10.96.0.10",
                clusterIPs=["10.96.0.10"],
                ipFamilies=["IPv4"],
                ipFamilyPolicy="SingleStack",
                sessionAffinity="None",
                internalTrafficPolicy="Cluster",
            )
            self.services[service]["spec"]["ports"][0]["protocol"] = "TCP"
        self.render.return_value = expected, expected_services
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["status"], "NO_LOCAL_OVERRIDES")
        self.assertEqual(report["blockers"], [])
        self.assertEqual(len(report["preservationReview"]["chartSha256"]), 64)

    def test_policy_changes_block_and_keep_sensitive_values_out_of_report(self):
        for workload in self.deployments.values():
            pod = workload["spec"]["template"]["spec"]
            pod.update(
                securityContext={"runAsUser": 0},
                automountServiceAccountToken=True,
                serviceAccountName="PRIVATE-account",
                hostNetwork=True,
                hostPID=True,
                hostIPC=True,
                shareProcessNamespace=True,
                dnsPolicy="None",
                dnsConfig={"nameservers": ["PRIVATE-dns"]},
                hostAliases=[{"ip": "PRIVATE-ip", "hostnames": ["PRIVATE-host"]}],
                terminationGracePeriodSeconds=1,
                resources={"limits": {"cpu": "2"}},
            )
            container = pod["containers"][0]
            container.update(
                securityContext={"privileged": True},
                lifecycle={"preStop": {"exec": {"command": ["PRIVATE-command"]}}},
                resources={"requests": {"cpu": "100m"}},
                ports=[{"containerPort": 8080, "hostIP": "PRIVATE-host-ip"}],
            )
            for field in ("startupProbe", "livenessProbe", "readinessProbe"):
                container[field] = {
                    "httpGet": {
                        "path": "/PRIVATE-path",
                        "port": 8080,
                        "httpHeaders": [
                            {"name": "Authorization", "value": "PRIVATE-token"}
                        ],
                    }
                }
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["blockers"], ["service_runtime_policy_differs"])
        for service in runtime.cluster.SERVICES:
            self.assertEqual(
                report["preservationReview"]["policyReviews"][service]["changedFields"],
                sorted(
                    [
                        "securityContext",
                        "automountServiceAccountToken",
                        "serviceAccountName",
                        "hostNetwork",
                        "hostPID",
                        "hostIPC",
                        "shareProcessNamespace",
                        "dnsPolicy",
                        "dnsConfig",
                        "hostAliases",
                        "terminationGracePeriodSeconds",
                        "resources",
                        *(
                            f"containers.{service}.{field}"
                            for field in (
                                "securityContext",
                                "lifecycle",
                                "resources",
                                "ports",
                                "startupProbe",
                                "livenessProbe",
                                "readinessProbe",
                            )
                        ),
                    ]
                ),
            )
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_api_defaults_and_equivalent_quantities_are_not_differences(self):
        for service, workload in self.deployments.items():
            pod = workload["spec"]["template"]["spec"]
            pod.update(
                dnsPolicy="ClusterFirst",
                terminationGracePeriodSeconds=30,
                hostNetwork=False,
                hostPID=False,
                hostIPC=False,
                shareProcessNamespace=False,
            )
            actual = pod["containers"][0]
            expected = self.render.return_value[0][service]["spec"]["template"]["spec"][
                "containers"
            ][0]
            for field in ("startupProbe", "livenessProbe", "readinessProbe"):
                expected[field] = {"httpGet": {"port": "http"}}
                actual[field] = {
                    "httpGet": {"port": "http", "path": "/", "scheme": "HTTP"},
                    "initialDelaySeconds": 0,
                    "timeoutSeconds": 1,
                    "periodSeconds": 10,
                    "successThreshold": 1,
                    "failureThreshold": 3,
                }
            expected["resources"] = {
                "requests": {"cpu": "100m", "memory": "128Mi"},
                "limits": {"cpu": "1", "memory": "1Gi"},
            }
            actual["resources"] = {
                "requests": {"cpu": "0.1", "memory": "134217728"},
                "limits": {"cpu": "1000m", "memory": "1024Mi"},
            }
        before = copy.deepcopy(self.deployments)
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["status"], "NO_LOCAL_OVERRIDES")
        self.assertEqual(self.deployments, before)

    def test_missing_health_resource_and_security_settings_cannot_pass(self):
        pod = self.deployment["spec"]["template"]["spec"]
        pod["securityContext"] = {"runAsNonRoot": True}
        pod["automountServiceAccountToken"] = False
        container = pod["containers"][0]
        container["securityContext"] = {
            "allowPrivilegeEscalation": False,
            "readOnlyRootFilesystem": True,
        }
        container["readinessProbe"] = {"httpGet": {"port": "http", "path": "/ready"}}
        container["resources"] = {"requests": {"cpu": "100m"}, "limits": {"cpu": "1"}}
        self.render.return_value[0]["ops-service"] = copy.deepcopy(self.deployment)
        for parent, field, expected_field in (
            (pod, "securityContext", "securityContext"),
            (pod, "automountServiceAccountToken", "automountServiceAccountToken"),
            (container, "securityContext", "containers.ops-service.securityContext"),
            (container, "readinessProbe", "containers.ops-service.readinessProbe"),
            (container, "resources", "containers.ops-service.resources"),
        ):
            value = parent.pop(field)
            with self.subTest(field=expected_field):
                report = runtime.preflight(self.state, FORK)
                self.assertEqual(report["blockers"], ["service_runtime_policy_differs"])
                self.assertEqual(
                    report["preservationReview"]["policyReviews"]["ops-service"][
                        "changedFields"
                    ],
                    [expected_field],
                )
            parent[field] = value

    def test_resource_quantity_comparison_is_exact_and_rejects_unknown_values(self):
        for left, right in (
            ("100m", "0.1"),
            ("1.5Gi", "1536Mi"),
            ("1k", "1e3"),
            ("1G", "1000M"),
            ("1u", "1000n"),
            (1.5, "1500m"),
        ):
            with self.subTest(left=left, right=right):
                self.assertEqual(
                    runtime.resource_settings({"limits": {"memory": left}}),
                    runtime.resource_settings({"limits": {"memory": right}}),
                )
        self.assertNotEqual(
            runtime.resource_settings({"limits": {"memory": "1G"}}),
            runtime.resource_settings({"limits": {"memory": "1Gi"}}),
        )
        self.assertNotEqual(
            runtime.resource_settings({"limits": {"cpu": "1"}}),
            runtime.resource_settings({"requests": {"cpu": "1"}}),
        )
        for value in (
            "PRIVATE",
            "NaN",
            float("inf"),
            True,
            "1e9999",
            "-1",
            "1K",
            "1E99",
        ):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(
                    ValueError, "Unsupported runtime resource quantity"
                ),
            ):
                runtime.resource_settings({"limits": {"cpu": value}})

    def test_probe_and_resource_extensions_are_not_silently_ignored(self):
        actual = copy.deepcopy(self.deployment)
        container = actual["spec"]["template"]["spec"]["containers"][0]
        container["readinessProbe"] = {"httpGet": {"port": "http"}}
        expected = copy.deepcopy(actual)
        container["readinessProbe"]["terminationGracePeriodSeconds"] = 12
        container["resources"] = {"claims": [{"name": "PRIVATE-claim"}]}
        report = runtime.policy_review(actual, expected)
        self.assertEqual(
            report["changedFields"],
            [
                "containers.ops-service.readinessProbe",
                "containers.ops-service.resources",
            ],
        )
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_port_order_and_default_protocol_do_not_hide_real_changes(self):
        actual = copy.deepcopy(self.deployment)
        container = actual["spec"]["template"]["spec"]["containers"][0]
        container["ports"] = [
            {"name": "http", "containerPort": 8080},
            {"name": "metrics", "containerPort": 8081},
        ]
        expected = copy.deepcopy(actual)
        container["ports"].reverse()
        for port in container["ports"]:
            port["protocol"] = "TCP"
        self.assertEqual(runtime.policy_review(actual, expected)["changedFields"], [])
        container["ports"][0]["protocol"] = "UDP"
        self.assertEqual(
            runtime.policy_review(actual, expected)["changedFields"],
            ["containers.ops-service.ports"],
        )

    def test_other_service_overrides_are_detected_without_saved_profiles(self):
        for service, variable in (
            ("core-service", "ACCOUNT_DEV_LOGIN_ENABLED"),
            ("catalog-service", "BIZINFO_SYNC_ENABLED"),
            ("ai-service", "OPENAI_BASE_URL"),
        ):
            container = self.deployments[service]["spec"]["template"]["spec"][
                "containers"
            ][0]
            env = {row["name"]: row for row in container["env"]}
            env[variable]["value"] = "PRIVATE-override"
            env["EXTRA_SETTING"] = {"name": "EXTRA_SETTING", "value": "PRIVATE-value"}
            secret = next(key for key, row in env.items() if "valueFrom" in row)
            env[secret]["valueFrom"]["secretKeyRef"]["name"] = "PRIVATE-secret"
            missing = next(
                key for key, row in env.items() if "value" in row and key != variable
            )
            env.pop(missing)
            container["env"] = list(reversed(env.values()))
            with self.subTest(service=service):
                report = runtime.preflight(self.state, FORK)
                self.assertEqual(report["blockers"], ["service_environment_differs"])
                review = report["preservationReview"]["serviceReviews"][service]
                self.assertEqual(
                    review["environmentChanges"][service],
                    {
                        "changed": sorted([variable, secret]),
                        "runtimeOnly": ["EXTRA_SETTING"],
                        "missing": [missing],
                    },
                )
                self.assertEqual(
                    review["reference"], "checkout_portfolio_service_defaults"
                )
                self.assertEqual(len(review["referenceSha256"]), 64)
                self.assertNotIn("PRIVATE", json.dumps(report))

    def test_other_service_env_from_and_unknown_containers_block(self):
        for service in ("core-service", "catalog-service", "ai-service"):
            pod = self.deployments[service]["spec"]["template"]["spec"]
            original = copy.deepcopy(pod["containers"])
            for missing in (False, True):
                pod["containers"] = [] if missing else copy.deepcopy(original)
                pod["containers"].append(
                    {
                        "name": "extra-container",
                        "envFrom": [{"configMapRef": {"name": "PRIVATE-config"}}],
                    }
                )
                with self.subTest(service=service, missing=missing):
                    report = runtime.preflight(self.state, FORK)
                    self.assertEqual(
                        report["blockers"],
                        [
                            "service_container_layout_differs",
                            "service_env_from_uninspected",
                        ],
                    )
                    review = report["preservationReview"]["serviceReviews"][service]
                    self.assertEqual(
                        review["containers"],
                        {
                            "runtimeOnly": ["extra-container"],
                            "missing": [service] if missing else [],
                        },
                    )
                    self.assertEqual(review["uninspectedEnvFrom"], ["extra-container"])
                    self.assertNotIn("PRIVATE", json.dumps(report))
            pod["containers"] = original

    def test_each_service_must_have_stable_identity_and_spec(self):
        for service in runtime.cluster.SERVICES:
            for field in (
                "uid",
                "resourceVersion",
                "namespace",
                "name",
                "deletionTimestamp",
                "spec",
            ):
                calls = 0

                def changing(command, **kwargs):
                    nonlocal calls
                    calls += 1
                    data = json.loads(self.read(command, **kwargs))
                    if (
                        calls > 8
                        and command[-4] == "deployment"
                        and command[-3] == service
                    ):
                        if field == "spec":
                            data["spec"]["replicas"] = 0
                        else:
                            data["metadata"][field] = "changed"
                    return json.dumps(data)

                with (
                    self.subTest(service=service, field=field),
                    self.assertRaises(ValueError),
                ):
                    self.command.side_effect = changing
                    runtime.preflight(self.state, FORK)
        self.command.side_effect = self.read

    def test_missing_other_deployment_is_not_a_clean_runtime(self):
        for service in ("core-service", "catalog-service", "ai-service"):

            def missing(command, **kwargs):
                if command[-3] == service:
                    raise subprocess.CalledProcessError(1, command, output="PRIVATE")
                return self.read(command, **kwargs)

            with (
                self.subTest(service=service),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                self.command.side_effect = missing
                runtime.preflight(self.state, FORK)

    def test_service_environment_order_does_not_create_a_difference(self):
        for workload in self.deployments.values():
            workload["spec"]["template"]["spec"]["containers"][0]["env"].reverse()
        self.assertEqual(
            runtime.preflight(self.state, FORK)["status"], "NO_LOCAL_OVERRIDES"
        )

    def test_storage_and_startup_changes_block_without_exposing_values(self):
        for service in runtime.cluster.SERVICES:
            spec = self.deployments[service]["spec"]
            pod = spec["template"]["spec"]
            container = pod["containers"][0]
            spec["replicas"] = 0
            spec["strategy"] = {"type": "RollingUpdate"}
            pod["volumes"].append(
                {
                    "name": "private-volume",
                    "persistentVolumeClaim": {"claimName": "PRIVATE-pvc"},
                }
            )
            pod["initContainers"] = [
                {
                    "name": "private-init",
                    "image": "PRIVATE-image",
                    "args": ["PRIVATE-token"],
                }
            ]
            container["volumeMounts"].append(
                {"name": "private-volume", "mountPath": "/PRIVATE-path"}
            )
            container["volumeDevices"] = [
                {"name": "device", "devicePath": "/PRIVATE-device"}
            ]
            container["command"] = ["PRIVATE-command"]
            container["args"] = ["PRIVATE-password"]
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(report["blockers"], ["service_execution_or_storage_differs"])
        for service in runtime.cluster.SERVICES:
            self.assertEqual(
                report["preservationReview"]["runtimeReviews"][service][
                    "changedFields"
                ],
                sorted(
                    [
                        "replicas",
                        "strategy",
                        "volumes",
                        "initContainers",
                        *(
                            f"containers.{service}.{field}"
                            for field in (
                                "command",
                                "args",
                                "volumeMounts",
                                "volumeDevices",
                            )
                        ),
                    ]
                ),
            )
        self.assertNotIn("PRIVATE", json.dumps(report))
        self.assertNotIn("private-", json.dumps(report))

    def test_removing_or_repointing_storage_is_a_difference(self):
        original = copy.deepcopy(self.deployment)
        for replacement in ([], [{"name": "tmp", "hostPath": {"path": "/PRIVATE"}}]):
            self.deployment["spec"]["template"]["spec"]["volumes"] = replacement
            report = runtime.preflight(self.state, FORK)
            self.assertEqual(
                report["preservationReview"]["runtimeReviews"]["ops-service"][
                    "changedFields"
                ],
                ["volumes"],
            )
        self.deployment = original
        self.deployment["spec"]["template"]["spec"]["containers"][0][
            "volumeMounts"
        ] = []
        report = runtime.preflight(self.state, FORK)
        self.assertEqual(
            report["preservationReview"]["runtimeReviews"]["ops-service"][
                "changedFields"
            ],
            ["containers.ops-service.volumeMounts"],
        )

    def test_volume_order_is_ignored_but_duplicate_volume_names_are_rejected(self):
        actual = copy.deepcopy(self.deployment)
        pod = actual["spec"]["template"]["spec"]
        pod["volumes"].append({"name": "cache", "emptyDir": {}})
        pod["containers"][0]["volumeMounts"].append(
            {"name": "cache", "mountPath": "/cache"}
        )
        expected = copy.deepcopy(actual)
        pod["volumes"].reverse()
        pod["containers"][0]["volumeMounts"].reverse()
        pod["containers"][0]["command"] = []
        self.assertEqual(
            runtime.execution_review(actual, expected)["changedFields"], []
        )
        pod["volumes"].append(copy.deepcopy(pod["volumes"][0]))
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            runtime.execution_review(actual, expected)

    def test_chart_change_during_observation_rejects_the_report(self):
        chart = runtime.chart_inputs()
        with (
            patch.object(
                runtime,
                "chart_inputs",
                side_effect=[chart, chart | {"templates/new.yaml": b"changed"}],
            ),
            self.assertRaisesRegex(ValueError, "changed during preflight"),
        ):
            runtime.preflight(self.state, FORK)

    def test_helm_failure_stops_the_observation(self):
        self.render.side_effect = subprocess.CalledProcessError(
            1, "PRIVATE command", stderr="PRIVATE detail"
        )
        with self.assertRaises(subprocess.CalledProcessError):
            runtime.preflight(self.state, FORK, "/custom/helm")
        self.assertEqual(self.render.call_args.args[0], "/custom/helm")
        self.assertEqual(self.command.call_count, 8)

    def test_each_service_routing_difference_blocks_planning(self):
        for service in runtime.cluster.SERVICES:
            with self.subTest(service=service):
                self.services[service]["spec"]["selector"] = {"app": "PRIVATE"}
                report = runtime.preflight(self.state, FORK)
                self.assertEqual(report["blockers"], ["service_routing_differs"])
                self.assertEqual(
                    report["preservationReview"]["networkReviews"][service],
                    {
                        "changedFields": ["service.selector"],
                        "routingErrors": ["selector_does_not_match_pod"],
                    },
                )
                self.assertNotIn("PRIVATE", json.dumps(report))
                self.services[service]["spec"]["selector"] = {"app": service}

    def test_service_identity_and_spec_must_remain_stable(self):
        for service in runtime.cluster.SERVICES:
            for field in (
                "kind",
                "uid",
                "resourceVersion",
                "namespace",
                "name",
                "deletionTimestamp",
                "spec",
            ):
                calls = 0

                def changing(command, **kwargs):
                    nonlocal calls
                    data = json.loads(self.read(command, **kwargs))
                    if command[-4:-2] == ["service", service]:
                        calls += 1
                        if calls == 2:
                            if field == "spec":
                                data["spec"]["ports"] = []
                            elif field == "kind":
                                data["kind"] = "Deployment"
                            else:
                                data["metadata"][field] = "changed"
                    return json.dumps(data)

                with (
                    self.subTest(service=service, field=field),
                    self.assertRaises(ValueError),
                ):
                    self.command.side_effect = changing
                    runtime.preflight(self.state, FORK)

    def test_missing_or_foreign_service_cannot_produce_a_clean_report(self):
        for service in runtime.cluster.SERVICES:

            def missing(command, **kwargs):
                if command[-4:-2] == ["service", service]:
                    raise subprocess.CalledProcessError(1, command, output="PRIVATE")
                return self.read(command, **kwargs)

            with (
                self.subTest(service=service),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                self.command.side_effect = missing
                runtime.preflight(self.state, FORK)
            self.command.side_effect = self.read
            original = copy.deepcopy(self.services[service]["metadata"])
            for change in (
                {"uid": None},
                {"resourceVersion": ""},
                {"namespace": "other"},
                {"deletionTimestamp": "now"},
            ):
                self.services[service]["metadata"] = original | change
                with (
                    self.subTest(service=service, change=change),
                    self.assertRaises(ValueError),
                ):
                    runtime.preflight(self.state, FORK)
            self.services[service]["metadata"] = original

    def test_local_helm_requires_one_matching_service_per_release(self):
        for variant in ("missing", "duplicate", "name", "namespace"):

            def helm(command, **kwargs):
                service = command[2]
                network = copy.deepcopy(self.services[service])
                if variant in ("name", "namespace"):
                    network["metadata"][variant] = "other"
                networks = (
                    []
                    if variant == "missing"
                    else [network] * (2 if variant == "duplicate" else 1)
                )
                return subprocess.CompletedProcess(
                    command,
                    0,
                    stdout=runtime.yaml.safe_dump_all(
                        [self.deployments[service], *networks]
                    ).encode(),
                )

            with (
                self.subTest(variant=variant),
                patch.object(runtime.subprocess, "run", side_effect=helm),
                self.assertRaisesRegex(ValueError, "reference Service"),
            ):
                self.real_render(
                    "helm",
                    {
                        name: runtime.portfolio_defaults(name)
                        for name in runtime.cluster.SERVICES
                    },
                    runtime.chart_inputs(),
                )

    def test_local_helm_uses_captured_inputs_and_rejects_wrong_environment(self):
        references = {
            service: runtime.portfolio_defaults(service)
            for service in runtime.cluster.SERVICES
        }
        chart = runtime.chart_inputs()
        temporary_roots = []

        def helm(command, **kwargs):
            self.assertEqual(command[0], "/custom/helm")
            self.assertEqual(command[1], "template")
            service = command[2]
            chart_path = Path(command[3])
            temporary_roots.append(chart_path.parent)
            self.assertNotEqual(
                chart_path, runtime.cluster.ROOT / "charts/govbiz-service"
            )
            self.assertEqual(
                (chart_path / "values.yaml").read_bytes(), chart["values.yaml"]
            )
            self.assertEqual(Path(command[-1]).read_bytes(), references[service][0])
            self.assertEqual(
                kwargs, {"capture_output": True, "check": True, "timeout": 30}
            )
            item = copy.deepcopy(self.deployments[service]) | {"kind": "Deployment"}
            item["spec"]["template"]["spec"]["containers"][0]["env"] = []
            return subprocess.CompletedProcess(
                command, 0, stdout=json.dumps(item).encode()
            )

        with (
            patch.object(runtime.subprocess, "run", side_effect=helm),
            self.assertRaisesRegex(ValueError, "differs from Helm"),
        ):
            self.real_render("/custom/helm", references, chart)
        self.assertTrue(temporary_roots)
        self.assertTrue(all(not root.exists() for root in temporary_roots))


class RuntimePlanCliTests(unittest.TestCase):
    def invoke(self, preflight):
        output = io.StringIO()
        with (
            patch(
                "sys.argv",
                [
                    "deployment.py",
                    "plan-gitops",
                    "--state-dir",
                    "fixture-state",
                    "--helm",
                    "/custom/helm",
                ],
            ),
            patch.object(deployment, "from_origin", return_value=FORK),
            patch.object(runtime, "preflight", **preflight) as check,
            patch.object(
                deployment,
                "verified_release",
                side_effect=ValueError("No complete verified publication"),
            ) as publication,
            patch.object(
                deployment, "publication_blocker", return_value={"status": "UNKNOWN"}
            ) as diagnosis,
            redirect_stdout(output),
        ):
            self.assertEqual(deployment.main(), 1)
        check.assert_called_once_with(Path("fixture-state"), FORK, "/custom/helm")
        self.assertEqual(diagnosis.called, publication.called)
        return json.loads(output.getvalue()), output.getvalue(), publication

    def test_local_conflicts_block_before_publication_queries(self):
        report, _, publication = self.invoke(
            {
                "return_value": {
                    "status": "BLOCKED",
                    "blockers": ["connected_or_unverified_ops"],
                }
            }
        )
        publication.assert_not_called()
        self.assertEqual(report["reason"], "runtime_transition_required")
        self.assertNotIn("resources", report)
        self.assertFalse(report["clusterVerified"])

    def test_local_check_does_not_replace_publication_checks(self):
        report, _, publication = self.invoke(
            {"return_value": {"status": "NO_LOCAL_OVERRIDES"}}
        )
        publication.assert_called_once()
        self.assertTrue(publication.call_args.kwargs["verify_public_manifests"])
        self.assertEqual(report["reason"], "publication_not_available")
        self.assertNotIn("resources", report)

    def test_unknown_runtime_does_not_leak_environment_or_subprocess_output(self):
        for error in (
            ValueError("PRIVATE config"),
            subprocess.TimeoutExpired("PRIVATE command", 15, output="PRIVATE bytes"),
            subprocess.CalledProcessError(
                1, "PRIVATE command", output="PRIVATE bytes", stderr="PRIVATE error"
            ),
        ):
            report, output, publication = self.invoke({"side_effect": error})
            publication.assert_not_called()
            self.assertEqual(report["runtimePreflight"]["status"], "UNKNOWN")
            self.assertEqual(report["reason"], "verification_failed")
            self.assertNotIn("PRIVATE", output)
            self.assertNotIn("resources", report)

    def test_verify_public_rejects_state_option_without_cluster_reads(self):
        with (
            patch(
                "sys.argv",
                ["deployment.py", "verify-public", "--state-dir", "fixture-state"],
            ),
            patch.object(runtime, "preflight") as check,
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as stopped,
        ):
            deployment.main()
        self.assertEqual(stopped.exception.code, 2)
        check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
