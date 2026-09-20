import unittest
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
