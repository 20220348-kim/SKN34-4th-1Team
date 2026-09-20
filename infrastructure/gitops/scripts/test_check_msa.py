import copy
import os
import shutil
import subprocess
import unittest

from check_msa import ROOT, SERVICES, argo_errors, policy_errors, render
import yaml

HELM = os.environ.get("HELM", "helm")


@unittest.skipUnless(shutil.which(HELM), "Install the pinned Helm CLI for render tests")
class MsaChartTests(unittest.TestCase):
    def test_four_services(self):
        for service in SERVICES:
            with self.subTest(service=service):
                self.assertEqual(policy_errors(service, render(service, HELM)), [])

    def test_reject_unsafe_values(self):
        for arguments in (
            ["--set", "replicas=2"],
            ["--set", "image.tag=latest"],
            ["--set", "localMode=false"],
            ["--set", "image.digest=sha256:bad"],
            ["--set", "env.OPENAI_API_KEY=not-a-real-secret"],
            ["--set", "serviceName=unknown"],
        ):
            with self.subTest(arguments=arguments), self.assertRaises(subprocess.CalledProcessError):
                render("core-service", HELM, arguments)

    def test_digest_mode(self):
        resources = render("core-service", HELM, ["--set", "localMode=false", "--set", "image.digest=sha256:" + "a" * 64])
        self.assertEqual(policy_errors("core-service", resources), [])

    def test_private_registry_uses_secret_reference_only(self):
        resources = render("ai-service", HELM, ["--set", "imagePullSecrets[0].name=ghcr-pull"])
        deployment = next(r for r in resources if r["kind"] == "Deployment")
        self.assertEqual(deployment["spec"]["template"]["spec"]["imagePullSecrets"], [{"name": "ghcr-pull"}])
        self.assertFalse(any(r["kind"] == "Secret" for r in resources))
        with self.assertRaises(subprocess.CalledProcessError):
            render("ai-service", HELM, ["--set-json", 'imagePullSecrets=[{"name":""}]'])

    def test_only_selected_service_changes(self):
        baseline = {s: render(s, HELM) for s in SERVICES}
        changed = copy.deepcopy(baseline)
        changed["ai-service"] = render("ai-service", HELM, ["--set", "image.tag=independent-v2"])
        self.assertEqual([s for s in SERVICES if changed[s] != baseline[s]], ["ai-service"])

    def test_writer_policy_detects_regression(self):
        resources = render("core-service", HELM, ["--set-string", "env.BIZINFO_SYNC_ENABLED=true"])
        self.assertIn("core-service: Core source writer enabled", policy_errors("core-service", resources))

    def test_local_data_requires_explicit_opt_in(self):
        result = subprocess.run([HELM, "template", "local-data", str(ROOT / "charts/govbiz-local-data")], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_local_data_has_six_independent_persistent_stores(self):
        output = subprocess.check_output([HELM, "template", "local-data", str(ROOT / "charts/govbiz-local-data"),
                                          "--namespace", "govbiz-msa", "--set", "allowDisposableData=true"], text=True)
        resources = list(yaml.safe_load_all(output))
        stores = [r for r in resources if r["kind"] == "StatefulSet"]
        self.assertEqual({r["metadata"]["name"] for r in stores},
                         {"core-mysql", "catalog-mysql", "ops-mysql", "redis", "qdrant", "elasticsearch"})
        for store in stores:
            self.assertEqual(store["spec"]["persistentVolumeClaimRetentionPolicy"], {"whenDeleted": "Retain", "whenScaled": "Retain"})
            self.assertEqual(len(store["spec"]["volumeClaimTemplates"]), 1)
        self.assertFalse(any(r["kind"] == "Secret" for r in resources))


class ArgoDefinitionTests(unittest.TestCase):
    def test_restricted_local_definitions(self):
        self.assertEqual(argo_errors(), [])


if __name__ == "__main__":
    unittest.main()
