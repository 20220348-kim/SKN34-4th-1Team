import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

import yaml

from check_msa import ROOT
from check_portfolio import errors


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


if __name__ == "__main__":
    unittest.main()
