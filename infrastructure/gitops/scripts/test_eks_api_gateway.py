"""Offline checks for the API-only, authenticated EKS entrypoint."""

import os
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
GATEWAY = ROOT / "infrastructure/eks/api-gateway"


class EksApiGatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resources = list(
            yaml.safe_load_all(
                subprocess.check_output(
                    ["kubectl", "kustomize", str(GATEWAY)], text=True
                )
            )
        )

    def resource(self, kind):
        return next(row for row in self.resources if row["kind"] == kind)

    def test_render_is_private_and_does_not_contain_secrets_or_data_workloads(self):
        self.assertEqual(
            {row["kind"] for row in self.resources},
            {"ConfigMap", "Service", "Deployment", "Ingress", "NetworkPolicy", "HorizontalPodAutoscaler"},
        )
        for row in self.resources:
            self.assertEqual(row["metadata"]["namespace"], "govbiz-msa")
        self.assertEqual(self.resource("Service")["spec"]["type"], "ClusterIP")
        ingress = self.resource("Ingress")
        annotations = ingress["metadata"]["annotations"]
        prefix = "alb.ingress.kubernetes.io/"
        self.assertEqual(annotations[prefix + "scheme"], "internal")
        self.assertEqual(annotations[prefix + "target-type"], "ip")
        self.assertRegex(
            annotations[prefix + "security-group-prefix-lists"], r"^pl-[a-f0-9]+$"
        )
        self.assertNotIn(prefix + "inbound-cidrs", annotations)
        paths = ingress["spec"]["rules"][0]["http"]["paths"]
        self.assertEqual(
            [(p["path"], p["pathType"]) for p in paths], [("/api", "Prefix")]
        )

    def test_nonroot_gateway_uses_generated_config_and_required_secret(self):
        pod = self.resource("Deployment")["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertTrue(pod["securityContext"]["runAsNonRoot"])
        container = pod["containers"][0]
        self.assertRegex(container["image"], r"@sha256:[0-9a-f]{64}$")
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        reference = container["env"][0]["valueFrom"]["secretKeyRef"]
        self.assertEqual(
            reference, {"name": "api-gateway-secret", "key": "GOVBIZ_PROXY_SECRET"}
        )
        config = next(
            v["configMap"]["name"] for v in pod["volumes"] if "configMap" in v
        )
        self.assertEqual(config, self.resource("ConfigMap")["metadata"]["name"])
        self.assertNotEqual(
            config, "api-gateway-config"
        )  # Config changes trigger a rollout.

    def test_gateway_autoscales_ready_targets_and_drains_using_its_writable_config(self):
        deployment = self.resource("Deployment")
        spec = deployment["spec"]
        pod = spec["template"]["spec"]
        container = pod["containers"][0]
        self.assertNotIn("replicas", spec)
        self.assertEqual(spec["strategy"], {
            "type": "RollingUpdate", "rollingUpdate": {"maxSurge": 1, "maxUnavailable": 0},
        })
        self.assertEqual(pod["nodeSelector"], {"govbiz.io/http-pool": "shared"})
        self.assertEqual(pod["topologySpreadConstraints"], [{
            "maxSkew": 1, "minDomains": 2, "topologyKey": "kubernetes.io/hostname",
            "whenUnsatisfiable": "DoNotSchedule",
            "labelSelector": {"matchLabels": spec["selector"]["matchLabels"]},
        }])
        hpa = self.resource("HorizontalPodAutoscaler")
        self.assertEqual(hpa["apiVersion"], "autoscaling/v2")
        self.assertEqual(hpa["spec"]["scaleTargetRef"], {
            "apiVersion": "apps/v1", "kind": "Deployment", "name": deployment["metadata"]["name"],
        })
        self.assertEqual((hpa["spec"]["minReplicas"], hpa["spec"]["maxReplicas"]), (1, 3))
        self.assertEqual(hpa["spec"]["metrics"], [{
            "type": "ContainerResource", "containerResource": {
                "name": "cpu", "container": container["name"],
                "target": {"type": "Utilization", "averageUtilization": 60},
            },
        }])
        self.assertEqual(container["resources"]["requests"]["cpu"], "25m")
        self.assertEqual(hpa["spec"]["behavior"]["scaleDown"]["stabilizationWindowSeconds"], 300)

        hook = container["lifecycle"]["preStop"]["exec"]["command"]
        self.assertEqual(hook[:2], ["/bin/sh", "-c"])
        subprocess.run(["sh", "-n", "-c", hook[2]], check=True, capture_output=True)
        self.assertIn("sleep 10; nginx -c /tmp/nginx.conf -s quit", hook[2])
        self.assertIn("while kill -0 1", hook[2])
        self.assertGreaterEqual(pod["terminationGracePeriodSeconds"], 610)
        data = self.resource("ConfigMap")["data"]
        self.assertIn("exec nginx -c /tmp/nginx.conf", data["start.sh"])
        self.assertIn("pid /tmp/nginx.pid;", data["nginx.conf.template"])
        mount = next(item for item in container["volumeMounts"] if item["mountPath"] == "/tmp")
        self.assertFalse(mount.get("readOnly", False))
        self.assertIn("emptyDir", next(item for item in pod["volumes"] if item["name"] == mount["name"]))

    def test_network_policy_only_isolates_gateway_and_allows_required_backends(self):
        policy = self.resource("NetworkPolicy")["spec"]
        self.assertEqual(
            policy["podSelector"]["matchLabels"],
            {"app.kubernetes.io/name": "api-gateway"},
        )
        cluster = yaml.safe_load(
            (ROOT / "infrastructure/eks/cluster.sydney-demo.yaml").read_text()
        )
        self.assertEqual(
            policy["ingress"][0]["from"][0]["ipBlock"]["cidr"], cluster["vpc"]["cidr"]
        )
        services = {
            peer["podSelector"]["matchLabels"]["app.kubernetes.io/name"]
            for rule in policy["egress"]
            for peer in rule["to"]
            if "app.kubernetes.io/name"
            in peer.get("podSelector", {}).get("matchLabels", {})
        }
        self.assertEqual(services, {"core-service", "ops-service"})
        self.assertNotIn("0.0.0.0/0", str(policy))
        self.assertEqual(
            len([r for r in self.resources if r["kind"] == "NetworkPolicy"]), 1
        )

    def test_invalid_secret_stops_before_template_expansion(self):
        for secret in ("", "a" * 63, "A" * 64, '";malicious' + "a" * 53):
            with self.subTest(length=len(secret)):
                result = subprocess.run(
                    ["sh", str(GATEWAY / "start.sh")],
                    env={**os.environ, "GOVBIZ_PROXY_SECRET": secret},
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("64 lowercase hexadecimal", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_cloudfront_keeps_auth_requests_uncached_without_origin_retries(self):
        template = yaml.load(
            (ROOT / "infrastructure/eks/api-cloudfront.yaml").read_text(),
            Loader=yaml.BaseLoader,
        )
        resources = template["Resources"]
        self.assertEqual(
            {r["Type"] for r in resources.values()},
            {"AWS::CloudFront::VpcOrigin", "AWS::CloudFront::Distribution"},
        )
        config = resources["ApiDistribution"]["Properties"]["DistributionConfig"]
        origin = config["Origins"][0]
        self.assertEqual(origin["ConnectionAttempts"], "1")
        self.assertIn("VpcOriginConfig", origin)
        self.assertNotIn("CustomOriginConfig", origin)
        behavior = config["DefaultCacheBehavior"]
        self.assertEqual(behavior["ViewerProtocolPolicy"], "https-only")
        self.assertEqual(
            behavior["CachePolicyId"], "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
        )
        self.assertEqual(
            behavior["OriginRequestPolicyId"], "b689b0a8-53d0-40ab-baf2-68738e2966ac"
        )
        self.assertEqual(
            set(behavior["AllowedMethods"]),
            {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"},
        )
        for error in config["CustomErrorResponses"]:
            self.assertEqual(error["ErrorCachingMinTTL"], "0")
            self.assertNotIn("ResponseCode", error)
        self.assertNotIn(
            "Logging", config
        )  # No sensitive API query strings in CF logs.


if __name__ == "__main__":
    unittest.main()
