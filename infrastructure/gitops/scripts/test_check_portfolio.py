import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

import yaml

from check_msa import ROOT
from check_portfolio import errors, fork_errors, free_runtime_errors
from fork_cluster import Fork


@unittest.skipUnless(shutil.which("helm"), "Helm required for rendered policy tests")
class PortfolioPolicies(unittest.TestCase):
    def check_change(self, relative, mutate):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("charts", "environments/portfolio", "argocd/portfolio"):
                shutil.copytree(ROOT / name, root / name)
            path = root / relative
            data = yaml.safe_load(path.read_text())
            mutate(data)
            path.write_text(yaml.safe_dump(data))
            self.assertTrue(errors(root))

    def test_current_portfolio_policy(self):
        self.assertEqual(errors(), [])

    def test_private_pull_reference_required(self):
        self.check_change("environments/portfolio/ai-service.yaml", lambda v: v.update(imagePullSecrets=[]))

    def test_registry_and_receipt_identity_required(self):
        self.check_change("environments/portfolio/ai-service.yaml", lambda v: v["image"].update(repository="evil.example/image"))

    def test_no_paid_llm_or_external_collection(self):
        self.check_change("environments/portfolio/ai-service.yaml", lambda v: v["env"].update(OPENAI_BASE_URL="https://api.openai.com/v1"))
        self.check_change("environments/portfolio/catalog-service.yaml", lambda v: v["env"].update(BIZINFO_SYNC_ENABLED="true"))

    def test_argo_cannot_manage_cluster_or_secrets(self):
        self.check_change("argocd/portfolio/project.yaml", lambda v: v["spec"].update(clusterResourceWhitelist=[{"group": "*", "kind": "*"}]))


@unittest.skipUnless(shutil.which("helm"), "Helm required for rendered policy tests")
class ForkPolicies(unittest.TestCase):
    def prepare(self, root, fork):
        shutil.copytree(ROOT / "charts", root / "charts")
        shutil.copytree(ROOT / "environments/portfolio", root / "environments/portfolio")
        destination = root / "environments/fork"
        destination.mkdir()
        record = {"repository": fork.repository, "branch": fork.branch, "verifiedRevision": "a" * 40,
                  "runId": 123, "runUrl": f"https://github.com/{fork.repository}/actions/runs/123", "images": {}}
        for service in ("core-service", "catalog-service", "ai-service", "ops-service"):
            values = yaml.safe_load((root / f"environments/portfolio/{service}.yaml").read_text())
            values["image"]["repository"] = fork.image(service)
            values["image"]["digest"] = "sha256:" + "b" * 64
            record["images"][service] = fork.image(service) + "@" + values["image"]["digest"]
            (destination / (service + ".yaml")).write_text(yaml.safe_dump(values))
        (destination / "release.json").write_text(json.dumps(record))
        return destination

    def test_two_different_forks_render_without_account_specific_edits(self):
        for owner in ("alice", "bob"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fork = Fork(owner + "/project", "develop")
                self.prepare(root, fork)
                self.assertEqual(fork_errors(fork, root), [])

    def test_missing_release_never_falls_back_to_historical_images(self):
        with tempfile.TemporaryDirectory() as directory:
            problems = fork_errors(Fork("alice/project"), Path(directory))
            self.assertIn("No verified personal release", problems[0])

    def test_public_release_requires_empty_pull_auth_for_all_four_services(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fork = Fork("alice/project")
            destination = self.prepare(root, fork)
            record_path = destination / "release.json"
            record = json.loads(record_path.read_text())
            record["visibility"] = "public"
            record_path.write_text(json.dumps(record))
            for service in ("core-service", "catalog-service", "ai-service", "ops-service"):
                path = destination / (service + ".yaml")
                values = yaml.safe_load(path.read_text())
                values["imagePullSecrets"] = []
                path.write_text(yaml.safe_dump(values))
            self.assertEqual(fork_errors(fork, root), [])
            record.pop("visibility")  # legacy records must still require private pull authentication
            record_path.write_text(json.dumps(record))
            self.assertTrue(fork_errors(fork, root))

    def test_release_of_another_owner_and_paid_api_environment_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fork = Fork("alice/project")
            destination = self.prepare(root, fork)
            self.assertTrue(fork_errors(Fork("bob/project"), root))
            path = destination / "ai-service.yaml"
            values = yaml.safe_load(path.read_text())
            values["env"]["OPENAI_BASE_URL"] = "https://api.openai.com/v1"
            path.write_text(yaml.safe_dump(values))
            self.assertTrue(fork_errors(fork, root))

    def test_mutating_both_template_and_fork_cannot_enable_paid_apis_or_external_jobs(self):
        for service, setting, value in (("ai-service", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
                                        ("catalog-service", "BIZINFO_SYNC_ENABLED", "true"),
                                        ("core-service", "ACCOUNT_PASSWORD_RESET_MAIL_ENABLED", "true"),
                                        ("core-service", "SMTP_AUTH", "true")):
            with self.subTest(service=service, setting=setting), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fork = Fork("alice/project")
                self.prepare(root, fork)
                for environment in ("portfolio", "fork"):
                    path = root / f"environments/{environment}/{service}.yaml"
                    values = yaml.safe_load(path.read_text())
                    values["env"][setting] = value
                    path.write_text(yaml.safe_dump(values))
                self.assertTrue(fork_errors(fork, root))


class FreeRuntimePolicies(unittest.TestCase):
    def test_current_templates_are_free_and_queue_toggle_is_rejected(self):
        for service in ("core-service", "catalog-service", "ai-service", "ops-service"):
            values = yaml.safe_load((ROOT / f"environments/portfolio/{service}.yaml").read_text())
            self.assertEqual(free_runtime_errors(service, values), [])
        values["env"]["SMTP_HOST"] = "smtp.example.com"
        self.assertTrue(free_runtime_errors("ops-service", values))
        self.assertTrue(free_runtime_errors("core-service", {"env": {"EXAMPLE_QUEUE_ENABLED": "true"}}))


if __name__ == "__main__":
    unittest.main()
