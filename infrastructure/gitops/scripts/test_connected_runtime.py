"""Offline tests: secrets stay off Git/Argo, writer ownership remains isolated."""
import json
import shutil
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import yaml

import connected_runtime as connected
from check_msa import ROOT, policy_errors
from fork_cluster import argo_resources, initial_settings, write_json
from repository import Fork


class ConnectedRuntimeTests(unittest.TestCase):
    def test_broker_alone_never_enables_recurring_paid_prefetch(self):
        for features, expected in ((["rabbitmq", "ai", "mail"], "false"),
                                   (["rabbitmq", "ai", "index"], "true"),
                                   (["ai", "index"], "false")):
            core = connected.overrides(self.profile(features))["core-service"]["env"]
            self.assertEqual(core["ASSISTANT_PREFETCH_QUEUE_ENABLED"], expected)

    def profile(self, features=None):
        self.settings = initial_settings(Fork("alice/project", "main"))
        return {"schemaVersion": 1, "repository": self.settings["repository"], "stateId": self.settings["stateId"],
                "features": features or ["rabbitmq", "ai", "mail", "google", "kakao", "bizno", "collection", "index", "documents", "reports"],
                "origin": "http://127.0.0.1:5173", "revision": "a" * 32, "modelKeys": []}

    def test_secret_file_parsing_is_allowlisted_and_never_executes_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "keys"
            path.write_text("OPENAI_API_KEY='private-fixture'\nACCOUNT_JWT_SECRET=ignored\nDATA_GO_KR_SERVICE_KEY=common-fixture\n")
            path.chmod(0o600)
            result = connected.read_inputs([path])
            self.assertEqual(result["OPENAI_API_KEY"], "private-fixture")
            self.assertNotIn("ACCOUNT_JWT_SECRET", result)
            self.assertEqual(result["MSIT_API_KEY"], "common-fixture")
            path.write_text('OPENAI_API_KEY=$(echo secret-fixture)\n')
            with self.assertRaisesRegex(ValueError, "literal") as caught:
                connected.read_inputs([path])
            self.assertNotIn("secret-fixture", str(caught.exception))
            path.chmod(0o666)
            with self.assertRaises(ValueError):
                connected.read_inputs([path])

    def test_symlinks_and_other_fork_profiles_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            profile = self.profile()
            write_json(state / "integrations.json", profile)
            self.assertEqual(connected.load_profile(state, self.settings), profile)
            with self.assertRaisesRegex(ValueError, "another"):
                connected.load_profile(state, self.settings | {"repository": "bob/project"})
            path = state / "link"
            path.symlink_to(state / "integrations.json")
            with self.assertRaises(ValueError):
                connected.read_inputs([path])

    def test_live_features_do_not_change_images_databases_or_secret_values(self):
        overlay = connected.overrides(self.profile())
        self.assertNotIn("ops-service", overlay)
        for values in overlay.values():
            self.assertEqual(set(values), {"env", "secretKeys"})
            self.assertFalse(any(key.endswith(("PASSWORD", "API_KEY", "TOKEN", "SECRET")) for key in values["env"]))
            self.assertFalse(any("DATASOURCE" in key for key in values["env"]))
        core = overlay["core-service"]["env"]
        self.assertNotIn("BIZINFO_SYNC_ENABLED", core)
        self.assertNotIn("SUPPORT_PROGRAM_INDEX_ENABLED", core)
        self.assertEqual(core["ACCOUNT_DEV_LOGIN_ENABLED"], "false")
        self.assertEqual(overlay["catalog-service"]["env"]["BIZINFO_SYNC_ENABLED"], "true")
        self.assertEqual(overlay["ai-service"]["env"]["OPENAI_BASE_URL"], "https://api.openai.com/v1")

    def test_on_demand_features_do_not_start_background_collectors_or_reports(self):
        result = connected.overrides(self.profile(["rabbitmq", "ai", "mail"]))
        self.assertNotIn("BIZINFO_SYNC_ENABLED", result["catalog-service"]["env"])
        for key in ("DAILY_REPORT_ENABLED", "DAILY_REPORT_MAIL_ENABLED", "APPLICATION_FORM_ANALYSIS_ENABLED"):
            self.assertNotIn(key, result["core-service"]["env"])

    def test_bad_dependencies_and_external_origins_are_rejected(self):
        for features in (["collection"], ["ai", "documents"], ["ai", "rabbitmq", "reports"], ["unknown"]):
            with self.assertRaises(ValueError):
                connected.overrides(self.profile(features))
        for field, value in (("origin", "https://other.example"), ("revision", "secret"), ("modelKeys", ["DB_PASSWORD"])):
            profile = self.profile()
            profile[field] = value
            with self.assertRaises(ValueError):
                connected.overrides(profile)

    def test_secret_updates_are_scoped_and_missing_key_errors_are_redacted(self):
        inputs = {key: "private-fixture" for keys in connected.KEYS.values() for key in keys}
        result = connected.secret_updates(["ai", "mail", "collection", "google"], inputs)
        self.assertEqual(set(result["catalog-runtime"]), set(connected.KEYS["collection"]))
        self.assertNotIn("OPENAI_API_KEY", result["core-runtime"])
        self.assertNotIn("SPRING_DATASOURCE_PASSWORD", result["core-runtime"])
        self.assertNotIn("ACCOUNT_JWT_SECRET", result["core-runtime"])
        self.assertEqual(result["core-runtime"]["SMTP_PORT"], "587")
        with self.assertRaisesRegex(ValueError, "SMTP_PASSWORD") as caught:
            connected.secret_updates(["mail"], {"SMTP_HOST": "private-fixture", "SMTP_USERNAME": "private-fixture"})
        self.assertNotIn("private-fixture", str(caught.exception))

    def test_secret_values_are_stdin_only_and_failed_output_is_suppressed(self):
        with patch("connected_runtime.subprocess.run", return_value=SimpleNamespace(returncode=1, stderr="private-fixture", stdout="private-fixture")) as call:
            with self.assertRaises(ValueError) as caught:
                connected.patch_secret(["kubectl"], "core-runtime", {"SMTP_PASSWORD": "private-fixture"})
        self.assertNotIn("private-fixture", str(caught.exception))
        self.assertNotIn("private-fixture", str(call.call_args.args))
        self.assertIn("data", json.loads(call.call_args.kwargs["input"]))

    def test_argo_preserves_git_digest_promotions_with_local_integration_overlay(self):
        profile = self.profile()
        resources = argo_resources(self.settings, profile)
        for app in resources[1:]:
            source = app["spec"]["source"]
            self.assertEqual(source["targetRevision"], "main")
            self.assertNotIn("image", source["helm"].get("valuesObject", {}))
            self.assertTrue(app["spec"]["syncPolicy"]["automated"]["selfHeal"])
        self.assertNotIn("valuesObject", argo_resources(self.settings)[1]["spec"]["source"]["helm"])

    @unittest.skipUnless(shutil.which("helm"), "Helm render checks run in the dedicated Helm CI job")
    def test_real_helm_manifests_preserve_msa_policy(self):
        for service, values in connected.overrides(self.profile()).items():
            raw = subprocess.check_output(["helm", "template", service, str(ROOT / "charts/govbiz-service"), "-n", "govbiz-msa",
                                           "-f", str(ROOT / f"environments/fork/{service}.yaml"), "-f", "-"],
                                          input=yaml.safe_dump(values), text=True)
            self.assertEqual(policy_errors(service, list(yaml.safe_load_all(raw))), [])

    @unittest.skipUnless(shutil.which("helm"), "Helm render checks run in the dedicated Helm CI job")
    def test_rabbitmq_is_opt_in_private_persistent_and_secret_authenticated(self):
        command = ["helm", "template", "fork-data", str(ROOT / "charts/govbiz-local-data"), "-n", "govbiz-msa",
                   "--set", "allowDisposableData=true"]
        baseline = list(yaml.safe_load_all(subprocess.check_output(command, text=True)))
        self.assertFalse(any(r["metadata"]["name"] == "rabbitmq" for r in baseline))
        resources = list(yaml.safe_load_all(subprocess.check_output(command + ["--set", "rabbitmq.enabled=true", "--show-only", "templates/rabbitmq.yaml"], text=True)))
        self.assertEqual({r["kind"] for r in resources}, {"Service", "StatefulSet"})
        service, broker = resources
        self.assertEqual(service["spec"]["clusterIP"], "None")
        pod = broker["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertTrue(pod["securityContext"]["runAsNonRoot"])
        self.assertEqual(broker["spec"]["persistentVolumeClaimRetentionPolicy"]["whenDeleted"], "Retain")
        container = pod["containers"][0]
        self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
        self.assertNotIn("livenessProbe", container)
        self.assertEqual(container["readinessProbe"]["tcpSocket"], {"port": "amqp"})
        self.assertEqual(container["startupProbe"]["tcpSocket"], {"port": "amqp"})
        credentials = [e for e in container["env"] if "valueFrom" in e]
        self.assertEqual(len(credentials), 2)
        self.assertTrue(all(e["valueFrom"]["secretKeyRef"]["name"] == "rabbitmq-runtime" for e in credentials))


if __name__ == "__main__":
    unittest.main()
