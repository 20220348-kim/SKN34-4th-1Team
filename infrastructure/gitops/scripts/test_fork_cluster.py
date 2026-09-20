"""Offline ownership, authentication and dev/GitOps separation checks."""
import copy
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import yaml

import fork_cluster as cluster
from repository import Fork


class Response(io.BytesIO):
    def __init__(self, payload, headers=None):
        super().__init__(json.dumps(payload).encode())
        self.headers = headers or {}


class ForkBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.fork = Fork("alice/SKN34-4th-1Team", "main")
        self.settings = cluster.initial_settings(self.fork)

    def test_each_fork_gets_a_distinct_cluster_not_previous_portfolio(self):
        other = cluster.initial_settings(Fork("bob/SKN34-4th-1Team", "main"))
        self.assertNotEqual(self.settings["cluster"], other["cluster"])
        self.assertNotEqual(self.settings["cluster"], "govbiz-portfolio")
        self.assertEqual(self.settings["platform"], "linux/amd64")
        self.assertEqual(self.settings["mode"], "dev")

    def test_local_state_is_private_and_origin_is_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            cluster.write_json(state / "settings.json", self.settings)
            self.assertEqual((state / "settings.json").stat().st_mode & 0o777, 0o600)
            with patch("fork_cluster.from_origin", return_value=self.fork):
                self.assertEqual(cluster.load_settings(state), self.settings)
            with patch("fork_cluster.from_origin", return_value=Fork("bob/other")):
                with self.assertRaisesRegex(ValueError, "origin changed"):
                    cluster.load_settings(state)

    def test_modified_cluster_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            changed = self.settings | {"cluster": "govbiz-portfolio"}
            cluster.write_json(state / "settings.json", changed)
            with self.assertRaisesRegex(ValueError, "Invalid dedicated"):
                cluster.load_settings(state)

    def test_every_kubectl_command_uses_explicit_context_and_kubeconfig(self):
        kube, nk, ak = cluster.commands(Path("/tmp/test-state"), self.settings)
        self.assertEqual(kube, ["kubectl", "--kubeconfig", Path("/tmp/test-state/kubeconfig"),
                                "--context", "kind-" + self.settings["cluster"]])
        self.assertEqual(nk[-2:], ["-n", "govbiz-msa"])
        self.assertEqual(ak[-2:], ["-n", "argocd"])

    def test_broken_symlink_cannot_redirect_kind_kubeconfig_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "kubeconfig").symlink_to(state / "does-not-exist")
            with self.assertRaisesRegex(ValueError, "kubeconfig must not be a symlink"):
                cluster.commands(state, self.settings)

    def context_outputs(self, marker=None):
        return [json.dumps({"clusters": [{"cluster": {"server": "https://127.0.0.1:12345"}}]}),
                json.dumps({"items": [{"metadata": {"name": self.settings["cluster"] + "-control-plane"}}]}),
                json.dumps({"data": marker or {"repository": self.settings["repository"], "stateId": self.settings["stateId"]}})]

    def test_loopback_is_not_sufficient_without_owner_marker(self):
        with patch("fork_cluster.run", side_effect=self.context_outputs({"repository": "bob/other", "stateId": "x"})):
            with self.assertRaisesRegex(ValueError, "ownership marker"):
                cluster.verify_context(["kubectl"], self.settings)
        with patch("fork_cluster.run", side_effect=self.context_outputs()):
            cluster.verify_context(["kubectl"], self.settings)

    def test_remote_api_and_another_kind_node_are_rejected(self):
        with patch("fork_cluster.run", return_value=json.dumps({"clusters": [{"cluster": {"server": "https://api.example:443"}}]})):
            with self.assertRaisesRegex(ValueError, "loopback"):
                cluster.verify_context(["kubectl"], self.settings)
        outputs = self.context_outputs()
        outputs[1] = json.dumps({"items": [{"metadata": {"name": "govbiz-portfolio-control-plane"}}]})
        with patch("fork_cluster.run", side_effect=outputs):
            with self.assertRaisesRegex(ValueError, "Unexpected cluster nodes"):
                cluster.verify_context(["kubectl"], self.settings)

    def test_any_fork_owner_can_use_only_their_read_packages_token(self):
        for owner in ("alice", "bob"):
            with patch("fork_cluster.urlopen", return_value=Response({"login": owner}, {"X-OAuth-Scopes": "read:packages"})):
                self.assertEqual(cluster.verify_token("a-test-token", Fork(owner + "/project")), owner)
        for payload, scopes in (({"login": "bob"}, "read:packages"), ({"login": "alice"}, "read:packages,repo"),
                                ({"login": "alice"}, "write:packages"), ({"login": "alice"}, "")):
            with patch("fork_cluster.urlopen", return_value=Response(payload, {"X-OAuth-Scopes": scopes})):
                with self.assertRaises(ValueError):
                    cluster.verify_token("a-test-token", self.fork)

    def test_pull_rights_are_verified_for_all_immutable_images_without_printing_token(self):
        digest = "sha256:" + "a" * 64
        record = {"images": {service: self.fork.image(service) + "@" + digest for service in cluster.SERVICES}}
        requests = []

        def respond(request, timeout):
            requests.append(request)
            return Response({"token": "ephemeral-scoped-token"}) if "/token?" in request.full_url else Response({}, {"Docker-Content-Digest": digest})

        with patch("fork_cluster.urlopen", side_effect=respond):
            cluster.verify_pull_rights("alice", "private-token", record)
        self.assertEqual(len(requests), 8)
        self.assertEqual(sum(r.get_method() == "HEAD" for r in requests), 4)
        self.assertTrue(all("private-token" not in r.full_url for r in requests))

    def test_public_pull_uses_no_personal_credential_and_checks_every_digest(self):
        digest = "sha256:" + "a" * 64
        record = {"visibility": "public", "images": {s: self.fork.image(s) + "@" + digest for s in cluster.SERVICES}}
        requests = []
        def respond(request, timeout):
            requests.append(request)
            return Response({"token": "anonymous-scoped-token"}) if "/token?" in request.full_url else Response({}, {"Docker-Content-Digest": digest})
        with patch("fork_cluster.urlopen", side_effect=respond):
            cluster.verify_pull_rights(None, None, record)
        self.assertEqual(len(requests), 8)
        self.assertTrue(all("Authorization" not in r.headers for r in requests if "/token?" in r.full_url))
        self.assertTrue(all(r.headers["Authorization"] == "Bearer anonymous-scoped-token" for r in requests if "/manifests/" in r.full_url))
        with patch("fork_cluster.urlopen", side_effect=[Response({"token": "anonymous"}), Response({}, {"Docker-Content-Digest": "wrong"})]), \
                self.assertRaisesRegex(ValueError, "different digest"):
            cluster.verify_pull_rights(None, None, record)

    def test_public_credentials_command_never_reads_applies_or_deletes_a_secret(self):
        record = {"visibility": "public", "images": {}}
        with tempfile.TemporaryDirectory() as directory, patch("fork_cluster.verify_context"), \
                patch("fork_cluster.checked_release", return_value=record), patch("fork_cluster.verify_pull_rights") as verify, \
                patch("fork_cluster.authenticate") as authenticate, patch("fork_cluster.apply") as apply:
            cluster.credentials(SimpleNamespace(helm="helm"), Path(directory), self.settings)
        verify.assert_called_once_with(None, None, record)
        authenticate.assert_not_called()
        apply.assert_not_called()
        with patch("fork_cluster.read_token") as read, patch("fork_cluster.getpass.getpass") as prompt, \
                self.assertRaisesRegex(ValueError, "do not require a PAT"):
            cluster.authenticate(SimpleNamespace(token_file="unused"), self.settings, record)
        read.assert_not_called()
        prompt.assert_not_called()

    def test_failed_anonymous_pull_stops_bootstrap_before_cluster_or_secret_writes(self):
        args = SimpleNamespace(local_images=None, helm="helm", kind="kind", token_file=None)
        with tempfile.TemporaryDirectory() as directory, patch("fork_cluster.doctor"), \
                patch("fork_cluster.checked_release", return_value={"visibility": "public", "images": {}}), \
                patch("fork_cluster.render_services", return_value={}), patch("fork_cluster.run", return_value="") as execute, \
                patch("fork_cluster.verify_pull_rights", side_effect=ValueError("anonymous denied")), \
                patch("fork_cluster.authenticate") as authenticate, patch("fork_cluster.apply") as apply:
            with self.assertRaisesRegex(ValueError, "anonymous denied"):
                cluster.up(args, Path(directory), self.settings)
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.args[0], ["kind", "get", "clusters"])
        authenticate.assert_not_called()
        apply.assert_not_called()

    def test_development_cannot_race_self_heal(self):
        with self.assertRaisesRegex(ValueError, "GitOps owns"):
            cluster.require_dev(Path("/tmp/state"), self.settings | {"mode": "gitops"})
        with patch("fork_cluster.verify_context"), patch("fork_cluster.applications", return_value=[{"metadata": {"name": "app"}}]):
            with self.assertRaisesRegex(ValueError, "Argo Applications still exist"):
                cluster.require_dev(Path("/tmp/state"), self.settings)
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "dev.lock").touch()
            with self.assertRaisesRegex(ValueError, "Another development or bootstrap"):
                with cluster.locked(state):
                    self.fail("An existing lock must not be acquired")

    def test_bootstrap_actions_and_watcher_share_a_lock_in_both_directions(self):
        import dev

        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.assertIs(cluster.locked, dev.locked)
            with dev.locked(state):
                for action in (cluster.up, cluster.gitops, cluster.credentials):
                    with self.assertRaisesRegex(ValueError, "Another development or bootstrap"):
                        action(None, state, self.settings)
                with self.assertRaisesRegex(ValueError, "Another development or bootstrap"):
                    cluster.development(state, self.settings)

            def attempt_watch(*args):
                self.assertTrue((state / "dev.lock").exists())
                with self.assertRaisesRegex(ValueError, "Another development or bootstrap"):
                    with dev.locked(state):
                        self.fail("Watcher must not begin during bootstrap")

            for action, implementation in ((cluster.up, "_up"), (cluster.gitops, "_gitops")):
                with patch("fork_cluster." + implementation, side_effect=attempt_watch):
                    action(None, state, self.settings)
                self.assertFalse((state / "dev.lock").exists())
            with patch("fork_cluster._development", side_effect=attempt_watch):
                cluster.development(state, self.settings)
            self.assertFalse((state / "dev.lock").exists())
            with patch("fork_cluster.verify_context", side_effect=attempt_watch), patch("fork_cluster.checked_release"), \
                    patch("fork_cluster.authenticate"), patch("fork_cluster.apply"):
                cluster.credentials(SimpleNamespace(helm="helm"), state, self.settings)
            self.assertFalse((state / "dev.lock").exists())

    def test_operation_lock_is_released_on_exception_without_stale_pid_takeover(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            for failure in (RuntimeError("test failure"), KeyboardInterrupt()):
                with self.assertRaises(type(failure)):
                    with cluster.locked(state):
                        raise failure
                self.assertFalse((state / "dev.lock").exists())
            (state / "dev.lock").write_text("999999999\n")
            with self.assertRaisesRegex(ValueError, "do not automatically delete"):
                with cluster.locked(state):
                    self.fail("A seemingly stale PID must not be taken over")
            self.assertEqual((state / "dev.lock").read_text(), "999999999\n")

    def test_lock_cleanup_never_deletes_a_replacement_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "dev.lock"
            with self.assertRaisesRegex(ValueError, "replacement was not removed"):
                with cluster.locked(state):
                    path.unlink()
                    path.write_text("other-owner\n")
            self.assertEqual(path.read_text(), "other-owner\n")

    def test_gitops_refuses_unrestored_local_images_before_reading_release(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "dev-images.json").write_text("{}")
            with patch("fork_cluster.checked_release") as check:
                with self.assertRaisesRegex(ValueError, "restore"):
                    cluster.gitops(None, state, self.settings)
            check.assert_not_called()

    def test_dev_transition_waits_for_inflight_argo_operation_before_orphan_deletion(self):
        settings = self.settings | {"mode": "gitops"}
        for operation in ({"operation": {"sync": {}}}, {"status": {"operationState": {"phase": "Running"}}},
                          {"status": {"operationState": {"phase": "Terminating"}}}):
            app = {"metadata": {"name": "govbiz-fork-core-service"}} | operation
            with tempfile.TemporaryDirectory() as directory:
                with patch("fork_cluster.verify_context"), patch("fork_cluster.applications", return_value=[app]), patch("fork_cluster.run") as execute:
                    with self.assertRaisesRegex(ValueError, "queued/running"):
                        cluster.development(Path(directory), settings)
                self.assertEqual(settings["mode"], "gitops")
                commands = [call.args[0] for call in execute.call_args_list]
                self.assertTrue(any("patch" in command for command in commands))
                self.assertFalse(any("delete" in command for command in commands))

    def test_generated_argo_is_limited_to_actual_fork_four_services_and_namespace(self):
        resources = cluster.argo_resources(self.settings)
        self.assertEqual(len(resources), 5)
        project = resources[0]["spec"]
        self.assertEqual(project["sourceRepos"], [self.fork.url])
        self.assertEqual(project["clusterResourceWhitelist"], [])
        self.assertEqual(project["namespaceResourceWhitelist"], [{"group": "apps", "kind": "Deployment"}, {"group": "", "kind": "Service"}])
        for service, app in zip(cluster.SERVICES, resources[1:], strict=True):
            self.assertNotIn("finalizers", app["metadata"])
            spec = app["spec"]
            self.assertEqual(spec["source"]["repoURL"], self.fork.url)
            self.assertEqual(spec["source"]["targetRevision"], "main")
            self.assertEqual(spec["source"]["path"], "infrastructure/gitops/charts/govbiz-service")
            self.assertEqual(spec["source"]["helm"]["valueFiles"], [f"../../environments/fork/{service}.yaml"])
            self.assertEqual(spec["destination"]["namespace"], "govbiz-msa")
            self.assertEqual(spec["syncPolicy"]["automated"], {"enabled": True, "prune": False, "selfHeal": True})

    def test_local_images_do_not_accept_registry_or_latest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "images.json"
            images = {name: "govbiz-" + name + ":check-1" for name in (*cluster.SERVICES, "elasticsearch")}
            path.write_text(json.dumps(images))
            self.assertEqual(cluster.local_images(path), images)
            for replacement in ("ghcr.io/alice/image:latest", "govbiz-core-service:latest"):
                altered = images | {"core-service": replacement}
                path.write_text(json.dumps(altered))
                with self.assertRaises(ValueError):
                    cluster.local_images(path)

    @unittest.skipUnless(shutil.which("helm"), "Helm required for actual local-mode render regression")
    def test_actual_local_helm_render_accepts_empty_json_pull_secret_array(self):
        images = {service: "govbiz-" + service + ":regression-1" for service in cluster.SERVICES}
        manifests = cluster.render_services(shutil.which("helm"), images)
        self.assertEqual(set(manifests), set(cluster.SERVICES))
        for service, output in manifests.items():
            deployment = next(document for document in yaml.safe_load_all(output) if document["kind"] == "Deployment")
            pod = deployment["spec"]["template"]["spec"]
            self.assertNotIn("imagePullSecrets", pod)
            self.assertEqual(pod["containers"][0]["image"], images[service])
            self.assertEqual(pod["containers"][0]["imagePullPolicy"], "Never")

    def test_failed_helm_preflight_prevents_cluster_creation_or_image_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(local_images="fixture.json", helm="helm")
            images = {service: "govbiz-" + service + ":fixture-1" for service in (*cluster.SERVICES, "elasticsearch")}
            with patch("fork_cluster.doctor"), patch("fork_cluster.local_images", return_value=images), \
                    patch("fork_cluster.render_services", side_effect=ValueError("Invalid Helm values")), \
                    patch("fork_cluster.run") as execute, patch("fork_cluster.load_image") as load:
                with self.assertRaisesRegex(ValueError, "Invalid Helm values"):
                    cluster.up(args, Path(directory), self.settings)
            execute.assert_not_called()
            load.assert_not_called()

    def test_only_both_previously_recorded_docker_and_cri_ids_allow_reuse(self):
        identity, cri = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        image = "govbiz-elasticsearch:test-1"
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            cluster.write_json(state / "loaded-images.json", {"schemaVersion": 1, "repository": self.settings["repository"],
                "cluster": self.settings["cluster"], "stateId": self.settings["stateId"],
                "images": {image: {"dockerId": identity, "criId": cri}}})
            with patch("fork_cluster.run", return_value=identity) as execute, patch("fork_cluster.node_image_id", return_value=cri):
                cluster.load_image(SimpleNamespace(kind="kind"), self.settings, image, state)
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(execute.call_args.args[0][:3], ["docker", "image", "inspect"])

    def test_missing_or_unrecorded_kind_id_imports_and_records_both_identities(self):
        identity, cri = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        image = "govbiz-elasticsearch:test-1"
        for previous in (None, identity, cri):
            with tempfile.TemporaryDirectory() as directory:
                state = Path(directory)
                with patch("fork_cluster.run", return_value=identity) as execute, \
                        patch("fork_cluster.node_image_id", side_effect=[previous, cri]):
                    cluster.load_image(SimpleNamespace(kind="kind"), self.settings, image, state)
                saved = json.loads((state / "loaded-images.json").read_text())
                self.assertEqual(saved["images"][image], {"dockerId": identity, "criId": cri})
                self.assertEqual(saved["stateId"], self.settings["stateId"])
            calls = [call.args[0] for call in execute.call_args_list]
            self.assertEqual(len(calls), 4)
            self.assertEqual(calls[1][:5], ["docker", "image", "save", "--platform", "linux/amd64"])
            self.assertEqual(calls[2][:3], ["kind", "load", "image-archive"])

    def test_image_cache_of_another_state_and_concurrent_tag_changes_are_rejected(self):
        identity, cri = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        image = "govbiz-elasticsearch:test-1"
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            cluster.write_json(state / "loaded-images.json", {"schemaVersion": 1, "repository": self.settings["repository"],
                "cluster": self.settings["cluster"], "stateId": "another-initialization", "images": {}})
            with patch("fork_cluster.run", return_value=identity):
                with self.assertRaisesRegex(ValueError, "does not belong"):
                    cluster.load_image(SimpleNamespace(kind="kind"), self.settings, image, state)
            (state / "loaded-images.json").unlink()
            with patch("fork_cluster.run", side_effect=[identity, None, None, "sha256:" + "c" * 64]), \
                    patch("fork_cluster.node_image_id", side_effect=[None, cri]):
                with self.assertRaisesRegex(ValueError, "changed during import"):
                    cluster.load_image(SimpleNamespace(kind="kind"), self.settings, image, state)
            self.assertFalse((state / "loaded-images.json").exists())

    def test_kind_inspection_errors_are_not_treated_as_cache_misses(self):
        command = ["docker", "exec", "node", "crictl", "inspecti", "image"]
        missing = subprocess.CompletedProcess(command, 1, stdout="", stderr="image not found")
        with patch("fork_cluster.subprocess.run", return_value=missing):
            self.assertIsNone(cluster.node_image_id(self.settings, "govbiz-ai-service:one"))
        for result in (subprocess.CompletedProcess(command, 1, stdout="", stderr="Docker daemon is unavailable"),
                       subprocess.CompletedProcess(command, 2, stdout="", stderr="not found")):
            with patch("fork_cluster.subprocess.run", return_value=result):
                with self.assertRaises(subprocess.CalledProcessError):
                    cluster.node_image_id(self.settings, "govbiz-ai-service:one")

    def test_runtime_secret_values_are_never_written_by_apply(self):
        resources = cluster.runtime_secrets()
        with patch("fork_cluster.run") as execute:
            cluster.apply(["kubectl", "--kubeconfig", "state/kubeconfig"], resources)
        args, kwargs = execute.call_args
        self.assertIn("--server-side", args[0])
        self.assertEqual(args[0][-2:], ["-f", "-"])
        self.assertNotIn(resources[0]["stringData"]["MYSQL_PASSWORD"], " ".join(args[0]))
        self.assertIn("stringData:", kwargs["data"])


if __name__ == "__main__":
    unittest.main()
