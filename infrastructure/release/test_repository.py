from pathlib import Path
import subprocess
import tempfile
import unittest

from repository import Fork, from_ci, from_origin, repository_from_url, validate_branch


class RepositoryTests(unittest.TestCase):
    def test_two_owners_and_two_projects_never_share_image_names(self):
        images = {Fork(repo).image("core-service") for repo in
                  ("Alice/SKN34-4th-1Team", "Bob/SKN34-4th-1Team", "Alice/Other")}
        self.assertEqual(len(images), 3)
        self.assertIn("ghcr.io/alice/skn34-4th-1team-core-service", images)

    def test_origin_supports_https_and_both_ssh_forms(self):
        for value in ("https://github.com/Alice/Project.git", "https://github.com/Alice/Project/",
                      "git@github.com:Alice/Project.git", "ssh://git@github.com/Alice/Project.git"):
            self.assertEqual(repository_from_url(value), "Alice/Project")

    def test_credential_urls_unrelated_hosts_and_shell_payloads_rejected(self):
        for value in ("https://secret@github.com/a/b", "https://github.com.evil/a/b", "/tmp/repo",
                      "git@evil:a/b", "https://github.com/a/b?token=secret", "https://github.com/a/b#main",
                      "https://github.com/a/../../b", "https://github.com/a/b\ncommand", "-C/tmp/repo"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                repository_from_url(value)

    def test_unsafe_refspecs_rejected(self):
        for branch in ("", "--upload-pack=x", "main:other", "../main", "a//b", "a/.b", "x.lock",
                       "main~1", "HEAD", "a\\b", "a/", "a.", "a@{x}", "a b"):
            with self.subTest(branch=branch), self.assertRaises(ValueError):
                validate_branch(branch)
        self.assertEqual(validate_branch("release/next-1.2"), "release/next-1.2")

    def test_ci_uses_only_trusted_context_and_rejects_missing_identity(self):
        fork = from_ci({"GITHUB_REPOSITORY": "Alice/Project", "GOVBIZ_RELEASE_BRANCH": "develop",
                        "INPUT_REPOSITORY": "Mallory/Other"})
        self.assertEqual(fork.repository, "Alice/Project")
        self.assertEqual(fork.branch, "develop")
        with self.assertRaises(ValueError):
            from_ci({"INPUT_REPOSITORY": "Alice/Project"})

    def test_education_publish_is_denied_but_identity_can_be_inspected(self):
        fork = Fork("SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team")
        with self.assertRaises(ValueError):
            fork.require_personal_publish()
        self.assertEqual(Fork("Alice/Project").require_personal_publish().owner, "Alice")

    def test_clone_origin_not_upstream_or_current_feature_branch_selects_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.run(["git", "-C", directory, *args], check=True, capture_output=True)
            git("init", "-b", "feature/work")
            git("remote", "add", "origin", "git@github.com:Alice/Project.git")
            git("remote", "add", "upstream", "https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team.git")
            git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
            self.assertEqual(from_origin(Path(directory)), Fork("Alice/Project", "develop"))
            self.assertEqual(from_origin(Path(directory), "main").branch, "main")


if __name__ == "__main__":
    unittest.main()
