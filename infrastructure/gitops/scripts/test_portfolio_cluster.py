import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import patch

from portfolio_cluster import ROOT, pull_secret, read_token, runtime_secrets, verify_context


class PortfolioClusterTests(unittest.TestCase):
    def test_migrated_cli_refuses_before_token_or_cluster_access(self):
        for action in ("prepare", "activate", "status"):
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / "scripts/portfolio_cluster.py"), action,
                 "--token-file", "/nonexistent-token-file"], capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("No token was read and no cluster was changed", result.stderr)

    def test_pull_secret_contains_only_ghcr_auth_in_expected_namespace(self):
        secret = pull_secret("test-user", "test-token")
        self.assertEqual(secret["metadata"], {"name": "ghcr-pull", "namespace": "govbiz-msa"})
        self.assertEqual(secret["type"], "kubernetes.io/dockerconfigjson")
        config = json.loads(secret["stringData"][".dockerconfigjson"])
        self.assertEqual(set(config["auths"]), {"ghcr.io"})
        self.assertEqual(base64.b64decode(config["auths"]["ghcr.io"]["auth"]), b"test-user:test-token")

    def test_runtime_credentials_are_isolated_and_matching(self):
        data = {s["metadata"]["name"]: s["stringData"] for s in runtime_secrets()}
        for owner in ("core", "catalog", "ops"):
            key = "DB_PASSWORD" if owner == "ops" else "SPRING_DATASOURCE_PASSWORD"
            self.assertEqual(data[owner + "-runtime"][key], data[owner + "-mysql-runtime"]["MYSQL_PASSWORD"])
        self.assertNotEqual(data["core-mysql-runtime"]["MYSQL_PASSWORD"], data["catalog-mysql-runtime"]["MYSQL_PASSWORD"])
        self.assertEqual(data["core-runtime"]["DOCUMENT_INTERNAL_TOKEN"], data["ai-runtime"]["DOCUMENT_INTERNAL_TOKEN"])
        self.assertEqual(data["core-runtime"]["CATALOG_INTERNAL_TOKEN"], data["catalog-runtime"]["CATALOG_INTERNAL_TOKEN"])
        self.assertNotEqual(runtime_secrets(), runtime_secrets())

    def test_token_rejects_broad_permissions_symlinks_and_whitespace(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "token"
            token.write_text("test-token")
            token.chmod(0o644)
            with self.assertRaises(ValueError):
                read_token(token)
            token.chmod(0o600)
            self.assertEqual(read_token(token), "test-token")
            link = Path(directory) / "link"
            link.symlink_to(token)
            with self.assertRaises(ValueError):
                read_token(link)
            token.write_text("test token")
            with self.assertRaises(ValueError):
                read_token(token)

    def test_rejects_remote_cluster_before_mutation(self):
        config = {"clusters": [{"cluster": {"server": "https://real-cluster.example"}}]}
        with patch("portfolio_cluster.run", return_value=json.dumps(config)):
            with self.assertRaises(ValueError):
                verify_context(["kubectl"])


if __name__ == "__main__":
    unittest.main()
