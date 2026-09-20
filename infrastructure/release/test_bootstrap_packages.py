import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import bootstrap_packages as bootstrap
from repository import Fork, SERVICES

FORK = Fork("alice/Example")
TOKEN = "ghp_" + "a" * 36


def package(**changes):
    return {"visibility": "private", "owner": {"login": "alice"}, "repository": None, **changes}


class BootstrapTests(unittest.TestCase):
    def test_only_minimal_package_pat_and_exact_personal_fork(self):
        repository = {"full_name": FORK.repository, "fork": True,
                      "owner": {"login": "alice", "type": "User"},
                      "parent": {"full_name": bootstrap.UPSTREAM}}
        for scope in ("write:packages", "read:packages, write:packages"):
            with patch.object(bootstrap, "api", side_effect=[
                    ({"login": "alice", "type": "User"}, {"X-OAuth-Scopes": scope}),
                    (repository, {})]):
                bootstrap.check_identity(FORK, TOKEN, True)
        for scopes in ("read:packages", "repo,write:packages", "delete:packages,write:packages", ""):
            with self.subTest(scopes=scopes), patch.object(bootstrap, "api", return_value=(
                    {"login": "alice", "type": "User"}, {"X-OAuth-Scopes": scopes})), self.assertRaises(ValueError):
                bootstrap.check_identity(FORK, TOKEN, True)

    def test_other_person_and_education_repo_rejected(self):
        with patch.object(bootstrap, "api", return_value=(
                {"login": "bob", "type": "User"}, {"X-OAuth-Scopes": "write:packages"})), self.assertRaises(ValueError):
            bootstrap.check_identity(FORK, TOKEN, True)
        with patch.object(bootstrap, "api") as api, self.assertRaises(ValueError):
            bootstrap.check_identity(Fork(bootstrap.UPSTREAM), TOKEN, True)
        api.assert_not_called()

    def test_unrelated_or_nonfork_repository_rejected(self):
        for repository in ({"full_name": FORK.repository, "fork": False},
                           {"full_name": FORK.repository, "fork": True, "parent": {"full_name": "other/repo"}}):
            with patch.object(bootstrap, "api", side_effect=[
                    ({"login": "alice", "type": "User"}, {"X-OAuth-Scopes": "write:packages"}),
                    (repository, {})]), self.assertRaises(ValueError):
                bootstrap.check_identity(FORK, TOKEN, True)

    def test_token_file_mode_symlink_and_format(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            path.write_text(TOKEN)
            path.chmod(0o600)
            self.assertEqual(bootstrap.credential(path), TOKEN)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                bootstrap.credential(path)
            path.chmod(0o600)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                bootstrap.credential(link)
            path.write_text("ghp_invalid\x00")
            with self.assertRaises(ValueError):
                bootstrap.credential(path)

    def test_noninteractive_hidden_input_rejected(self):
        with patch.object(bootstrap.sys.stdin, "isatty", return_value=False), self.assertRaises(ValueError):
            bootstrap.credential()

    def test_http_failures_do_not_expose_token_or_become_missing(self):
        for status in (301, 302, 401, 403, 429, 500):
            with patch.object(bootstrap, "build_opener") as opener:
                opener.return_value.open.side_effect = HTTPError("https://api.github.com", status, TOKEN, {}, None)
                with self.assertRaises(ValueError) as failure:
                    bootstrap.api("user", TOKEN, missing_ok=True)
                self.assertNotIn(TOKEN, str(failure.exception))
        with patch.object(bootstrap, "build_opener") as opener:
            opener.return_value.open.side_effect = HTTPError("https://api.github.com", 404, "fixture", {}, None)
            self.assertEqual(bootstrap.api("user", TOKEN, missing_ok=True), (None, {}))
            opener.return_value.open.side_effect = URLError(TOKEN)
            with self.assertRaises(ValueError) as failure:
                bootstrap.api("user", TOKEN, missing_ok=True)
            self.assertNotIn(TOKEN, str(failure.exception))
        self.assertIsNone(bootstrap.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid"))

    def test_any_public_foreign_or_wrong_repository_blocks_all_uploads(self):
        bad = (package(visibility="public"), package(owner={"login": "bob"}),
               package(repository={"full_name": "alice/Other"}))
        for current in bad:
            with patch.object(bootstrap, "check_identity"), patch.object(bootstrap, "metadata", return_value=current), \
                    patch.object(bootstrap, "docker") as docker, self.assertRaises(ValueError):
                bootstrap.prepare(FORK, TOKEN, create=True)
            docker.assert_not_called()

    def test_missing_verify_does_not_create_or_login(self):
        with patch.object(bootstrap, "check_identity"), patch.object(bootstrap, "metadata", return_value=None), \
                patch.object(bootstrap, "docker") as docker, self.assertRaises(ValueError):
            bootstrap.prepare(FORK, TOKEN)
        docker.assert_not_called()

    def test_verify_requires_exact_source_link(self):
        with patch.object(bootstrap, "check_identity"), patch.object(bootstrap, "metadata", return_value=package()), \
                patch.object(bootstrap, "docker") as docker, self.assertRaises(ValueError):
            bootstrap.prepare(FORK, TOKEN)
        docker.assert_not_called()

    def test_existing_private_packages_are_never_overwritten(self):
        with patch.object(bootstrap, "check_identity"), patch.object(bootstrap, "metadata", return_value=package()), \
                patch.object(bootstrap, "docker") as docker, patch("sys.stdout", new_callable=io.StringIO):
            bootstrap.prepare(FORK, TOKEN, create=True)
        docker.assert_not_called()

    def test_new_packages_contain_only_literal_empty_image_and_no_source_or_token(self):
        created = set()
        commands = []
        def metadata(fork, service, token):
            return package() if service in created else None
        def docker(*args, env, data=None):
            commands.append((args, env, data))
            if args[0] == "push":
                service = next(service for service in SERVICES if args[1].startswith(FORK.image(service) + ":"))
                created.add(service)
        with patch.object(bootstrap, "check_identity"), patch.object(bootstrap, "metadata", side_effect=metadata), \
                patch.object(bootstrap, "docker", side_effect=docker), patch("sys.stdout", new_callable=io.StringIO) as output:
            bootstrap.prepare(FORK, TOKEN, create=True)
        self.assertEqual(created, set(SERVICES))
        self.assertNotIn(TOKEN, output.getvalue())
        builds = [item for item in commands if item[0][0] == "build"]
        self.assertEqual(len(builds), 4)
        for args, env, data in commands:
            self.assertNotIn(TOKEN, str(args))
            self.assertNotIn(TOKEN, str(env))
            if args[0] == "build":
                self.assertEqual(args[-1], "-")
                self.assertEqual(data, bootstrap.EMPTY_DOCKERFILE)
                for forbidden in ("COPY", "ADD", "RUN", "ARG", "image.source", "image.revision", TOKEN):
                    self.assertNotIn(forbidden, data)
        directory = commands[0][1]["DOCKER_CONFIG"]
        self.assertFalse(Path(directory).exists())
        self.assertEqual(sum(args[:2] == ("image", "rm") for args, _, _ in commands), 4)
        self.assertEqual(commands[-1][0], ("logout", "ghcr.io"))

    def test_unexpected_public_creation_stops_remaining_pushes_and_cleans_login(self):
        uploaded = []
        def metadata(fork, service, token):
            return package(visibility="public") if uploaded else None
        def docker(*args, **kwargs):
            if args[0] == "push":
                uploaded.append(args[1])
        with patch.object(bootstrap, "check_identity"), patch.object(bootstrap, "metadata", side_effect=metadata), \
                patch.object(bootstrap, "docker", side_effect=docker) as command, self.assertRaises(ValueError):
            bootstrap.prepare(FORK, TOKEN, create=True)
        self.assertEqual(len(uploaded), 1)
        self.assertEqual(command.call_args.args, ("logout", "ghcr.io"))

    def test_github_actions_is_not_a_bootstrap_environment(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), patch.object(bootstrap, "check_identity") as identity, \
                self.assertRaises(ValueError):
            bootstrap.prepare(FORK, TOKEN, create=True)
        identity.assert_not_called()

    def test_docker_failure_redacts_process_input_output_and_environment(self):
        with patch.object(bootstrap.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "docker", output=TOKEN)), \
                self.assertRaises(ValueError) as failure:
            bootstrap.docker("login", env={}, data=TOKEN)
        self.assertNotIn(TOKEN, str(failure.exception))


if __name__ == "__main__":
    unittest.main()
