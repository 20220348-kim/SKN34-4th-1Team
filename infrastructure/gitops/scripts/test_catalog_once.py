import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml
import catalog_once
from catalog_once import job


class CatalogOnceTests(unittest.TestCase):
    def deployment(self):
        env = [{"name": name + "_SYNC_ENABLED", "value": "false"} for name in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")]
        env += [{"name": "SUPPORT_PROGRAM_INDEX_ENABLED", "value": "false"},
                {"name": "SPRING_DATASOURCE_PASSWORD", "valueFrom": {"secretKeyRef": {"name": "catalog-runtime", "key": "SPRING_DATASOURCE_PASSWORD"}}}]
        return {"spec": {"template": {"spec": {"containers": [{"name": "catalog-service", "image": "ghcr.io/alice/catalog@sha256:" + "a" * 64,
                   "env": env, "readinessProbe": {}, "volumeMounts": []}], "volumes": [], "automountServiceAccountToken": False}}}}

    def test_apply_is_bounded_not_retried_and_retains_receipt(self):
        spec = job(self.deployment(), "first", ["BIZINFO"], "0.99", True)["spec"]
        self.assertEqual(spec["backoffLimit"], 0)
        pod = spec["template"]["spec"]
        self.assertEqual(pod["restartPolicy"], "Never")
        self.assertEqual(pod["volumes"][-1]["persistentVolumeClaim"]["claimName"], "catalog-sync-receipts")
        self.assertNotIn("readinessProbe", pod["containers"][0])
        self.assertIn("--app.catalog-sync-once.max-usd=0.99", pod["containers"][0]["args"])

    def test_plan_never_publishes_or_claims_persistent_receipt(self):
        pod = job(self.deployment(), "first", ["MSIT"], "1", False)["spec"]["template"]["spec"]
        self.assertIn("--app.catalog-sync-once.apply=false", pod["containers"][0]["args"])
        self.assertIn("emptyDir", pod["volumes"][-1])

    def test_plan_collects_selected_source_without_ai_or_unrelated_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            source_key = Path(directory) / "keys.env"
            source_key.write_text("KSTARTUP_API_KEY=source-fixture\n")
            source_key.chmod(0o600)
            commands = []
            def run(command, **kwargs):
                commands.append((command, kwargs))
                if "deployment" in command:
                    return json.dumps(self.deployment())
                if "jobs" in command:
                    return '{"items": []}'
                return ""
            with patch("sys.argv", ["catalog_once.py", "--state-dir", directory,
                       "--run-id", "plan-only", "--sources", "KSTARTUP", "--max-usd", "1",
                       "--env-file", str(source_key)]), \
                    patch("catalog_once.load_settings", return_value={"repository": "alice/project"}), \
                    patch("catalog_once.commands", return_value=(["kubectl"], ["kubectl", "-n", "govbiz-msa"], [])), \
                    patch("catalog_once.verify_context"), patch("catalog_once.run", side_effect=run), \
                    patch("catalog_once.patch_secret") as secret:
                catalog_once.main()
            secret.assert_called_once_with(["kubectl", "-n", "govbiz-msa"], "catalog-runtime",
                                           {"KSTARTUP_API_KEY": "source-fixture"})
            self.assertFalse(any("exec" in command for command, _ in commands))
            self.assertFalse(any("apply" in command for command, _ in commands))
            submitted = [yaml.safe_load(kwargs["data"]) for command, kwargs in commands if "create" in command]
            self.assertEqual(len(submitted), 1)
            args = submitted[0]["spec"]["template"]["spec"]["containers"][0]["args"]
            self.assertIn("--app.catalog-sync-once.sources=KSTARTUP", args)
            self.assertIn("--app.catalog-sync-once.apply=false", args)

    def test_apply_requires_deployed_embedding_policy_before_secrets_or_job(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                if "deployment" in command:
                    return json.dumps(self.deployment())
                if "exec" in command:
                    raise subprocess.CalledProcessError(1, command)
                return ""
            with patch("sys.argv", ["catalog_once.py", "--state-dir", directory,
                       "--run-id", "apply", "--sources", "KSTARTUP", "--max-usd", "1", "--apply"]), \
                    patch("catalog_once.load_settings", return_value={"repository": "alice/project"}), \
                    patch("catalog_once.commands", return_value=(["kubectl"], ["kubectl", "-n", "govbiz-msa"], [])), \
                    patch("catalog_once.verify_context"), patch("catalog_once.run", side_effect=run), \
                    patch("catalog_once.patch_secret") as secret, self.assertRaises(SystemExit):
                catalog_once.main()
            secret.assert_not_called()
            self.assertTrue(any("exec" in command for command in commands))
            self.assertFalse(any("create" in command or "apply" in command for command in commands))

    def test_bad_budget_source_mutable_image_or_running_writer_rejected(self):
        for amount in ("0", "-1", "1.01", "NaN", "Infinity", "not-a-number"):
            with self.assertRaises(ValueError):
                job(self.deployment(), "test", ["BIZINFO"], amount, True)
        for sources in ([], ["INVALID"], ["BIZINFO", "BIZINFO"]):
            with self.assertRaises(ValueError):
                job(self.deployment(), "test", sources, "1", True)
        for env in ("BIZINFO_SYNC_ENABLED", "SUPPORT_PROGRAM_INDEX_ENABLED"):
            deployment = self.deployment()
            next(e for e in deployment["spec"]["template"]["spec"]["containers"][0]["env"] if e["name"] == env)["value"] = "true"
            with self.assertRaises(ValueError):
                job(deployment, "test", ["BIZINFO"], "1", True)


if __name__ == "__main__":
    unittest.main()
