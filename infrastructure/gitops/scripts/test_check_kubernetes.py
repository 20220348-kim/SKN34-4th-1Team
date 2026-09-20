import unittest
from copy import deepcopy

from check_kubernetes import load_resources, policy_errors


class KubernetesPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rendered = load_resources()

    def setUp(self):
        self.resources = deepcopy(self.rendered)
        self.deployment = next(r for r in self.resources if r["kind"] == "Deployment")
        self.pod = self.deployment["spec"]["template"]["spec"]
        self.app = self.pod["containers"][0]

    def assert_rejected(self, part):
        self.assertTrue(
            any(part in error for error in policy_errors(self.resources)), part
        )

    def test_local_manifests_pass(self):
        self.assertEqual(policy_errors(self.resources), [])

    def test_secrets_must_not_be_committed_as_resources_or_configmaps(self):
        self.resources.append(
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {"name": "forbidden", "namespace": "govbiz-local"},
                "stringData": {"value": "fixture"},
            }
        )
        self.assert_rejected("Unexpected resource kind: Secret")
        config = next(r for r in self.resources if r["kind"] == "ConfigMap")
        config["data"]["DB_PASSWORD"] = "fixture"
        self.assert_rejected("Secret-like ConfigMap key")

    def test_secret_literal_and_wrong_reference_are_rejected(self):
        for replacement in (
            {"name": "DB_PASSWORD", "value": "fixture"},
            {
                "name": "DB_PASSWORD",
                "valueFrom": {"secretKeyRef": {"name": "wrong", "key": "DB_PASSWORD"}},
            },
        ):
            with self.subTest(replacement=replacement):
                self.app["env"][1] = replacement
                self.assert_rejected("required secretKeyRef for DB_PASSWORD")

    def test_external_service_is_rejected(self):
        service = next(r for r in self.resources if r["kind"] == "Service")
        service["spec"]["type"] = "LoadBalancer"
        self.assert_rejected("Only internal ClusterIP")

    def test_wrong_namespace_is_rejected(self):
        self.deployment["metadata"]["namespace"] = "production"
        self.assert_rejected("Wrong namespace")

    def test_debug_localhost_db_and_wildcard_hosts_are_rejected(self):
        config = next(
            r
            for r in self.resources
            if r["kind"] == "ConfigMap"
            and r["metadata"]["name"].startswith("ops-service-config-")
        )
        for key, value in (
            ("DJANGO_DEBUG", "true"),
            ("DB_HOST", "localhost"),
            ("DJANGO_ALLOWED_HOSTS", "*"),
        ):
            with self.subTest(key=key):
                original = config["data"][key]
                config["data"][key] = value
                self.assert_rejected("Unexpected local Ops environment")
                config["data"][key] = original

    def test_database_failure_must_not_be_liveness_failure(self):
        self.app["livenessProbe"]["httpGet"]["path"] = "/api/v1/health/ready"
        self.assert_rejected("Wrong Ops livenessProbe endpoint")

    def test_readiness_timeout_exceeds_database_timeout(self):
        self.app["readinessProbe"]["timeoutSeconds"] = 1
        self.assert_rejected("5-second DB timeout")

    def test_app_cannot_run_as_root_or_mount_api_token(self):
        self.pod["securityContext"]["runAsUser"] = 0
        self.pod["automountServiceAccountToken"] = True
        self.assert_rejected("non-root UID")
        self.assert_rejected("Disable API token mount")

    def test_privileged_host_resources_are_rejected(self):
        self.app["securityContext"]["privileged"] = True
        self.pod["hostNetwork"] = True
        self.pod["volumes"].append({"name": "host", "hostPath": {"path": "/"}})
        self.assert_rejected("Privileged containers")
        self.assert_rejected("Host namespaces")
        self.assert_rejected("hostPath volumes")

    def test_read_only_bounded_filesystem_is_required(self):
        self.app["securityContext"]["readOnlyRootFilesystem"] = False
        self.pod["volumes"][0]["emptyDir"].pop("sizeLimit")
        self.assert_rejected("read-only")
        self.assert_rejected("bounded emptyDir")

    def test_resource_limits_and_preloaded_image_are_required(self):
        self.app["resources"].pop("limits")
        self.app["imagePullPolicy"] = "Always"
        self.assert_rejected("CPU and memory limits")
        self.assert_rejected("Load the local Ops image")

    def test_bad_rollout_must_preserve_healthy_pod(self):
        self.deployment["spec"]["strategy"]["rollingUpdate"]["maxUnavailable"] = 1
        self.assert_rejected("Keep the healthy replica")

    def test_no_automatic_migration_or_cron_job(self):
        self.pod["initContainers"] = [{"name": "migrate", "image": "fixture"}]
        self.assert_rejected("No implicit migration")
        self.resources.append(
            {
                "kind": "CronJob",
                "metadata": {"name": "unexpected", "namespace": "govbiz-local"},
            }
        )
        self.assert_rejected("Unexpected resource kind: CronJob")

    def test_mysql_digest_and_pvc_are_required(self):
        stateful = next(r for r in self.resources if r["kind"] == "StatefulSet")
        stateful["spec"]["template"]["spec"]["containers"][0]["image"] = "mysql:latest"
        stateful["spec"]["volumeClaimTemplates"] = []
        self.assert_rejected("Pin official MySQL 8.4")
        self.assert_rejected("own data PVC")

    def test_missing_and_duplicate_resources_are_rejected(self):
        self.resources.append(deepcopy(self.deployment))
        self.assert_rejected("Duplicate resource")
        self.resources = [r for r in self.resources if r["kind"] != "Deployment"]
        self.assert_rejected("Missing resource: Deployment/ops-service")


if __name__ == "__main__":
    unittest.main()
