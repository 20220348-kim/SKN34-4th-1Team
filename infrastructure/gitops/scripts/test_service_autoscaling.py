"""Render the opt-in HTTP HPA and retain default single-writer behavior."""

import copy
import shutil
import subprocess
import unittest

from check_msa import policy_errors, render


AUTOSCALING = {
    "enabled": True,
    "minReplicas": 1,
    "maxReplicas": 3,
    "targetCPUUtilizationPercentage": 70,
}


@unittest.skipUnless(shutil.which("helm"), "Helm is required by the Infra CI render job")
class ServiceAutoscalingTests(unittest.TestCase):
    def test_existing_services_keep_single_writer_defaults(self):
        for service in ("core-service", "catalog-service", "ai-service", "ops-service"):
            with self.subTest(service=service):
                objects = render(service)
                self.assertEqual(policy_errors(service, objects), [])
                deployment = next(item for item in objects if item["kind"] == "Deployment")
                self.assertEqual(deployment["spec"]["replicas"], 1)
                self.assertEqual(deployment["spec"]["strategy"], {"type": "Recreate"})
                self.assertEqual(deployment["spec"]["template"]["spec"]["terminationGracePeriodSeconds"], 60)
                self.assertFalse(any(item["kind"] == "HorizontalPodAutoscaler" for item in objects))

    def test_hpa_owns_replica_count_and_accepts_custom_bounded_settings(self):
        for service in ("core-service", "ai-service"):
            with self.subTest(service=service):
                objects = render(service, extra=("--set", "autoscaling.enabled=true"))
                self.assertEqual(policy_errors(service, objects, autoscaling=AUTOSCALING), [])
                deployment = next(item for item in objects if item["kind"] == "Deployment")
                self.assertNotIn("replicas", deployment["spec"])
                self.assertEqual(deployment["spec"]["template"]["spec"]["terminationGracePeriodSeconds"], 300)
                self.assertEqual(deployment["spec"]["template"]["spec"]["containers"][0]["lifecycle"], {
                    "preStop": {"sleep": {"seconds": 10}},
                })
                self.assertTrue(policy_errors(service, objects))
        settings = dict(AUTOSCALING, minReplicas=2, maxReplicas=5, targetCPUUtilizationPercentage=60)
        objects = render("ai-service", extra=("--set", "autoscaling.enabled=true,autoscaling.minReplicas=2,autoscaling.maxReplicas=5,autoscaling.targetCPUUtilizationPercentage=60"))
        self.assertEqual(policy_errors("ai-service", objects, autoscaling=settings), [])

    def test_unsafe_services_invalid_bounds_and_missing_cpu_request_fail_render(self):
        for service, option in (
            ("catalog-service", "autoscaling.enabled=true"),
            ("ops-service", "autoscaling.enabled=true"),
            ("ai-service", "autoscaling.enabled=true,autoscaling.minReplicas=0"),
            ("ai-service", "autoscaling.enabled=true,autoscaling.minReplicas=4,autoscaling.maxReplicas=3"),
            ("ai-service", "autoscaling.enabled=true,autoscaling.maxReplicas=11"),
            ("ai-service", "autoscaling.enabled=true,autoscaling.maxReplicas=2.5"),
            ("ai-service", "autoscaling.enabled=true,autoscaling.targetCPUUtilizationPercentage=0"),
            ("ai-service", "autoscaling.enabled=true,autoscaling.targetCPUUtilizationPercentage=101"),
            ("ai-service", "autoscaling.enabled=true,resources.requests.cpu=0"),
            ("ai-service", "autoscaling.enabled=true,resources.requests.cpu=null"),
            ("ai-service", "autoscaling.enabled=true,resources.requests.cpu=bad"),
        ):
            with self.subTest(service=service, option=option):
                with self.assertRaises(subprocess.CalledProcessError):
                    render(service, extra=("--set", option))
        with self.assertRaises(subprocess.CalledProcessError):
            render("ai-service", extra=("--set-string", "autoscaling.enabled=false"))

    def test_rendered_hpa_target_and_manual_replica_drift_are_rejected(self):
        original = render("ai-service", extra=("--set", "autoscaling.enabled=true"))
        for drift in ("target", "bounds", "replicas", "cpu", "hpa-missing"):
            objects = copy.deepcopy(original)
            deployment = next(item for item in objects if item["kind"] == "Deployment")
            hpa = next(item for item in objects if item["kind"] == "HorizontalPodAutoscaler")
            if drift == "target":
                hpa["spec"]["scaleTargetRef"]["name"] = "ops-service"
            elif drift == "bounds":
                hpa["spec"]["maxReplicas"] = 10
            elif drift == "replicas":
                deployment["spec"]["replicas"] = 1
            elif drift == "cpu":
                deployment["spec"]["template"]["spec"]["containers"][0]["resources"]["requests"]["cpu"] = "0m"
            else:
                objects.remove(hpa)
            with self.subTest(drift=drift):
                self.assertTrue(policy_errors("ai-service", objects, autoscaling=AUTOSCALING))


if __name__ == "__main__":
    unittest.main()
