"""Offline checks for the authenticated API and dashboard EKS entrypoints."""

import json
import os
import re
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
            [(p["path"], p["pathType"]) for p in paths],
            [("/api", "Prefix"), ("/argocd", "Prefix"), ("/_langfuse", "Prefix")],
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
        self.assertEqual(services, {"core-service", "ops-service", "argocd-server", "langfuse-web"})
        langfuse_rule = policy["egress"][-2]
        self.assertEqual(langfuse_rule["to"], [{
            "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "govbiz-observability"}},
            "podSelector": {"matchLabels": {"app.kubernetes.io/name": "langfuse-web"}},
        }])
        self.assertEqual(langfuse_rule["ports"], [{"protocol": "TCP", "port": 3000}])
        argo_rule = policy["egress"][-1]
        self.assertEqual(argo_rule["to"][0]["namespaceSelector"], {
            "matchLabels": {"kubernetes.io/metadata.name": "argocd"},
        })
        self.assertEqual(argo_rule["ports"], [{"protocol": "TCP", "port": 8080}])
        self.assertEqual(argo_rule["to"], [{
            "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "argocd"}},
            "podSelector": {"matchLabels": {"app.kubernetes.io/name": "argocd-server"}},
        }])
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

    def test_argo_routes_require_both_guards_and_verify_the_pinned_server_certificate(self):
        data = self.resource("ConfigMap")["data"]
        self.assertIn("include /tmp/argocd.conf;", data["nginx.conf.template"])
        config = data["argocd.conf.template"]
        for path in ("= /argocd", "/argocd/"):
            block = config.split("location " + path + " {", 1)[1].split("\n}", 1)[0]
            origin_guard = 'if ($http_x_govbiz_argo_origin != "${GOVBIZ_ARGO_PROXY_SECRET}") { return 403; }'
            viewer_guard = 'if ($http_x_govbiz_argo_access != "allowed") { return 403; }'
            action = "return 308" if path.startswith("=") else "proxy_pass https://"
            self.assertLess(block.index(origin_guard), block.index(action))
            self.assertLess(block.index(viewer_guard), block.index(action))
        exact = config.split("location = /argocd {", 1)[1].split("\n}", 1)[0]
        self.assertIn("absolute_redirect off;", exact)
        self.assertIn("return 308 /argocd/;", exact)
        self.assertIn("proxy_ssl_verify on;", config)
        self.assertIn("set $govbiz_argocd argocd-server.argocd.svc.cluster.local:8080;", config)
        self.assertIn("proxy_ssl_trusted_certificate /etc/govbiz-argocd/tls.crt;", config)
        self.assertIn("proxy_ssl_name argocd-server;", config)
        self.assertIn("proxy_ssl_server_name on;", config)
        self.assertIn("proxy_pass_request_headers off;", config)
        self.assertIn("proxy_set_header Host $http_x_govbiz_argo_host;", config)
        self.assertIn("proxy_set_header X-Forwarded-Host $http_x_govbiz_argo_host;", config)
        self.assertNotIn("proxy_ssl_verify off", config)
        for header in ("X-Govbiz-Argo-Origin", "X-Govbiz-Argo-Access", "X-Govbiz-Proxy-Secret"):
            self.assertNotIn("proxy_set_header " + header.lower(), config.lower())

    def test_optional_argo_configuration_fails_closed_and_rejects_invalid_secrets(self):
        pod = self.resource("Deployment")["spec"]["template"]["spec"]
        container = pod["containers"][0]
        argo_env = next(env for env in container["env"] if env["name"] == "GOVBIZ_ARGO_PROXY_SECRET")
        self.assertEqual(argo_env["valueFrom"]["secretKeyRef"], {
            "name": "argocd-dashboard-proxy", "key": "origin-secret", "optional": True,
        })
        trust = next(volume["secret"] for volume in pod["volumes"] if volume["name"] == "argocd-trust")
        self.assertEqual(trust, {
            "secretName": "argocd-dashboard-proxy", "optional": True,
            "items": [{"key": "tls.crt", "path": "tls.crt"}],
        })
        script = self.resource("ConfigMap")["data"]["start.sh"]
        self.assertIn('${GOVBIZ_ARGO_PROXY_SECRET:-}', script)
        self.assertIn("location = /argocd { return 403; }", script)
        self.assertIn("location /argocd/ { return 403; }", script)
        self.assertIn("[ ! -s /etc/govbiz-argocd/tls.crt ]", script)
        for secret in ("a" * 63, "A" * 64, '\";malicious' + "a" * 53):
            with self.subTest(length=len(secret)):
                result = subprocess.run(
                    ["sh", str(GATEWAY / "start.sh")],
                    env={**os.environ, "GOVBIZ_PROXY_SECRET": "a" * 64, "GOVBIZ_ARGO_PROXY_SECRET": secret},
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("GOVBIZ_ARGO_PROXY_SECRET must be 64 lowercase hexadecimal", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_langfuse_routes_require_independent_origin_secret_marker_and_safe_host(self):
        data = self.resource("ConfigMap")["data"]
        config = data["langfuse.conf.template"]
        self.assertIn("include /tmp/langfuse.conf;", data["nginx.conf.template"])
        for path in ("= /_langfuse", "^~ /_langfuse/"):
            block = config.split("location " + path + " {", 1)[1].split("\n}", 1)[0]
            action = "return 308" if path.startswith("=") else "proxy_pass http://"
            for guard in (
                'if ($http_x_govbiz_langfuse_origin != "${GOVBIZ_LANGFUSE_PROXY_SECRET}") { return 403; }',
                'if ($http_x_govbiz_langfuse_access != "allowed") { return 403; }',
                r'if ($http_x_govbiz_langfuse_host !~ "^d[a-z0-9]+\.cloudfront\.net$") { return 403; }',
            ):
                self.assertLess(block.index(guard), block.index(action))
        self.assertIn("set $govbiz_langfuse langfuse-web.govbiz-observability.svc.cluster.local:3000;", config)
        self.assertIn("proxy_pass http://$govbiz_langfuse$govbiz_langfuse_uri;", config)
        self.assertIn("proxy_pass_request_headers off;", config)
        for name, value in (
            ("Host", "$http_x_govbiz_langfuse_host"),
            ("X-Forwarded-Host", "$http_x_govbiz_langfuse_host"),
            ("X-Forwarded-Proto", "https"),
            ("Cookie", "$http_cookie"), ("Origin", "$http_origin"),
            ("Authorization", "$http_authorization"),
            ("Next-Action", "$http_next_action"),
        ):
            self.assertIn(f"proxy_set_header {name} {value};", config)
        for credential in ("X-Govbiz-Langfuse-Origin", "X-Govbiz-Langfuse-Access", "X-Govbiz-Proxy-Secret"):
            self.assertNotIn("proxy_set_header " + credential.lower(), config.lower())
        self.assertIn("proxy_cache off;", config)
        self.assertIn("proxy_redirect off;", config)

    def test_langfuse_origin_prefix_preserves_raw_url_without_entering_core_or_ops(self):
        config = self.resource("ConfigMap")["data"]["nginx.conf.template"]
        expression = re.search(r"~(\^/_langfuse\(\?<govbiz_langfuse_path>.*) \$govbiz_langfuse_path;", config)[1]
        expression = expression.replace("(?<govbiz_langfuse_path>", "(?P<govbiz_langfuse_path>")
        pattern = re.compile(expression)
        for suffix in (
            "/", "/auth/sign-in", "/project/govbiz-evidence-development/traces",
            "/api/auth/callback/credentials?callbackUrl=https%3A%2F%2Fd123.cloudfront.net%2F",
            "/_next/static/chunks/a%2Fb.js?v=1&v=2",
            "/api/trpc/traces.all?input=%7B%22text%22%3A%22a%2Bb%22%7D",
        ):
            with self.subTest(suffix=suffix):
                self.assertEqual(pattern.fullmatch("/_langfuse" + suffix)["govbiz_langfuse_path"], suffix)
        for uri in ("/_langfuse", "/api/v1/ops/session", "/_langfuse-other/api/auth/session"):
            self.assertIsNone(pattern.fullmatch(uri))
        # Nginx selects normalized locations. Even a prefix traversal that lands
        # in either API location cannot use the dashboard's trusted marker there.
        self.assertEqual(
            config.count('if ($http_x_govbiz_langfuse_access != "") { return 403; }'), 2,
        )
        self.assertIn('if ($govbiz_langfuse_uri = "") { return 400; }',
                      self.resource("ConfigMap")["data"]["langfuse.conf.template"])

    def test_optional_langfuse_configuration_defaults_closed_and_rejects_invalid_secret(self):
        container = self.resource("Deployment")["spec"]["template"]["spec"]["containers"][0]
        value = next(env for env in container["env"] if env["name"] == "GOVBIZ_LANGFUSE_PROXY_SECRET")
        self.assertEqual(value["valueFrom"]["secretKeyRef"], {
            "name": "langfuse-dashboard-proxy", "key": "origin-secret", "optional": True,
        })
        script = self.resource("ConfigMap")["data"]["start.sh"]
        self.assertIn('${GOVBIZ_LANGFUSE_PROXY_SECRET:-}', script)
        self.assertIn("location = /_langfuse { return 403; }", script)
        self.assertIn("location ^~ /_langfuse/ { return 403; }", script)
        for secret in ("a" * 63, "A" * 64, '\";malicious' + "a" * 53):
            with self.subTest(length=len(secret)):
                result = subprocess.run(
                    ["sh", str(GATEWAY / "start.sh")],
                    env={**os.environ, "GOVBIZ_PROXY_SECRET": "a" * 64,
                         "GOVBIZ_ARGO_PROXY_SECRET": "", "GOVBIZ_LANGFUSE_PROXY_SECRET": secret},
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("GOVBIZ_LANGFUSE_PROXY_SECRET must be 64 lowercase hexadecimal", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_cloudfront_keeps_auth_requests_uncached_without_origin_retries(self):
        template = yaml.load(
            (ROOT / "infrastructure/eks/api-cloudfront.yaml").read_text(),
            Loader=yaml.BaseLoader,
        )
        resources = template["Resources"]
        self.assertEqual(
            {r["Type"] for r in resources.values()},
            {
                "AWS::CloudFront::VpcOrigin", "AWS::CloudFront::Distribution",
                "AWS::CloudFront::Function",
            },
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


class CloudFrontArgoAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = yaml.load(
            (ROOT / "infrastructure/eks/api-cloudfront.yaml").read_text(),
            Loader=yaml.BaseLoader,
        )

    def test_argo_secret_is_optional_and_never_replaces_api_proxy_authentication(self):
        parameters = self.template["Parameters"]
        ip = parameters["ArgoAllowedIpv4"]
        secret = parameters["ArgoOriginSecret"]
        self.assertEqual(ip["Default"], "")
        self.assertEqual(secret["Default"], "")
        self.assertEqual(secret["NoEcho"], "true")
        for value in ("", "203.0.113.9", "255.255.255.255"):
            self.assertIsNotNone(re.fullmatch(ip["AllowedPattern"], value))
        for value in ("203.0.113.9/32", "203.0.113.9,203.0.113.10", "256.0.0.1", "::1", " 203.0.113.9", "'malicious"):
            self.assertIsNone(re.fullmatch(ip["AllowedPattern"], value))
        for value in ("", "a" * 64):
            self.assertIsNotNone(re.fullmatch(secret["AllowedPattern"], value))
        for value in ("a" * 63, "A" * 64, "'" + "a" * 63):
            self.assertIsNone(re.fullmatch(secret["AllowedPattern"], value))
        resources = self.template["Resources"]
        config = resources["ApiDistribution"]["Properties"]["DistributionConfig"]
        origin_headers = config["Origins"][0]["OriginCustomHeaders"]
        self.assertEqual(origin_headers, [
            "HasArgoOriginSecret",
            [{"HeaderName": "x-govbiz-argo-origin", "HeaderValue": "ArgoOriginSecret"}],
            "AWS::NoValue",
        ])
        self.assertEqual(
            self.template["Conditions"]["HasArgoOriginSecret"], [["ArgoOriginSecret", ""]]
        )
        self.assertNotIn("x-govbiz-proxy-secret", str(origin_headers).lower())
        self.assertNotIn("ArgoOriginSecret", resources["ArgoViewerAccess"]["Properties"]["FunctionCode"])
        self.assertEqual(
            config["DefaultCacheBehavior"]["FunctionAssociations"],
            [{"EventType": "viewer-request", "FunctionARN": "ArgoViewerAccess.FunctionARN"}],
        )

    def run_access_function(self, configured_ip, viewer_ip):
        properties = self.template["Resources"]["ArgoViewerAccess"]["Properties"]
        self.assertEqual(properties["FunctionConfig"]["Runtime"], "cloudfront-js-2.0")
        self.assertEqual(properties["AutoPublish"], "true")
        function = properties["FunctionCode"].replace("${ArgoAllowedIpv4}", configured_ip)
        events = []
        for uri in ("/argocd", "/argocd/", "/argocd/api/v1/session", "/api/../argocd/", "/%61rgocd/", "/api/v1/account"):
            events.append({
                "viewer": {"ip": viewer_ip},
                "request": {
                    "method": "POST", "uri": uri, "querystring": {},
                    "headers": {
                        "host": {"value": "example.cloudfront.net"},
                        "x-govbiz-argo-access": {"value": "allowed", "multiValue": [{"value": "allowed"}]},
                        "x-govbiz-argo-host": {"value": "attacker.invalid"},
                        "x-forwarded-for": {"value": "203.0.113.9"},
                        "x-forwarded-host": {"value": "attacker.invalid"},
                        "x-govbiz-proxy-secret": {"value": "existing-api-contract"},
                        "authorization": {"value": "existing-session"},
                    },
                },
            })
        result = subprocess.run(
            ["node", "-e", function + "\nconst events = " + json.dumps(events)
             + "; process.stdout.write(JSON.stringify(events.map(handler)));"],
            check=True, text=True, capture_output=True,
        )
        return events, json.loads(result.stdout)

    def test_untrusted_marker_and_forwarded_ip_cannot_authorize_any_path(self):
        for allowed_ip, actual_ip in (("203.0.113.9", "198.51.100.4"), ("", "203.0.113.9")):
            with self.subTest(configured=allowed_ip, viewer=actual_ip):
                events, requests = self.run_access_function(allowed_ip, actual_ip)
                for event, request in zip(events, requests, strict=True):
                    expected = event["request"]
                    expected["headers"].pop("x-govbiz-argo-access")
                    expected["headers"].pop("x-govbiz-argo-host")
                    self.assertEqual(request, expected)

    def test_allowed_viewer_receives_one_marker_without_changing_api_contract(self):
        events, requests = self.run_access_function("203.0.113.9", "203.0.113.9")
        for event, request in zip(events, requests, strict=True):
            expected = event["request"]
            expected["headers"]["x-govbiz-argo-access"] = {"value": "allowed"}
            expected["headers"]["x-govbiz-argo-host"] = {"value": "example.cloudfront.net"}
            self.assertEqual(request, expected)


class CloudFrontLangfuseAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = yaml.load(
            (ROOT / "infrastructure/eks/langfuse-cloudfront.yaml").read_text(),
            Loader=yaml.BaseLoader,
        )

    def test_dedicated_distribution_reuses_private_origin_and_requires_its_own_secret(self):
        parameters = self.template["Parameters"]
        ip = parameters["LangfuseAllowedIpv4"]
        secret = parameters["LangfuseOriginSecret"]
        self.assertEqual(ip["Default"], "")
        self.assertNotIn("Default", secret)
        self.assertEqual(secret["NoEcho"], "true")
        for value in ("", "203.0.113.9", "255.255.255.255"):
            self.assertIsNotNone(re.fullmatch(ip["AllowedPattern"], value))
        for value in ("203.0.113.9/32", "256.0.0.1", "::1", "'malicious"):
            self.assertIsNone(re.fullmatch(ip["AllowedPattern"], value))
        self.assertIsNotNone(re.fullmatch(secret["AllowedPattern"], "a" * 64))
        for value in ("", "a" * 63, "A" * 64, "'" + "a" * 63):
            self.assertIsNone(re.fullmatch(secret["AllowedPattern"], value))
        resources = self.template["Resources"]
        self.assertEqual(
            {row["Type"] for row in resources.values()},
            {"AWS::CloudFront::Distribution", "AWS::CloudFront::Function"},
        )
        config = resources["LangfuseDistribution"]["Properties"]["DistributionConfig"]
        self.assertEqual(config["ViewerCertificate"], {"CloudFrontDefaultCertificate": "true"})
        self.assertEqual(config["IPV6Enabled"], "false")
        self.assertNotIn("Logging", config)
        self.assertEqual(len(config["Origins"]), 1)
        origin = config["Origins"][0]
        self.assertEqual(origin["DomainName"], "AlbDnsName")
        self.assertEqual(origin["OriginPath"], "/_langfuse")
        self.assertEqual(origin["VpcOriginConfig"]["VpcOriginId"], "VpcOriginId")
        self.assertEqual(origin["ConnectionAttempts"], "1")
        self.assertNotIn("CustomOriginConfig", origin)
        self.assertEqual(origin["OriginCustomHeaders"], [{
            "HeaderName": "x-govbiz-langfuse-origin", "HeaderValue": "LangfuseOriginSecret",
        }])
        function = resources["LangfuseViewerAccess"]["Properties"]["FunctionCode"]
        self.assertNotIn("LangfuseOriginSecret", function)
        self.assertNotIn("LangfuseOriginSecret", str(self.template["Outputs"]))

    def test_all_paths_require_https_and_uncached_authenticated_requests(self):
        config = self.template["Resources"]["LangfuseDistribution"]["Properties"]["DistributionConfig"]
        self.assertNotIn("CacheBehaviors", config)
        behavior = config["DefaultCacheBehavior"]
        self.assertEqual(behavior["TargetOriginId"], "langfuse")
        self.assertEqual(behavior["ViewerProtocolPolicy"], "https-only")
        self.assertEqual(behavior["CachePolicyId"], "4135ea2d-6df8-44a3-9df3-4b5a84be39ad")
        self.assertEqual(behavior["OriginRequestPolicyId"], "b689b0a8-53d0-40ab-baf2-68738e2966ac")
        self.assertEqual(set(behavior["AllowedMethods"]), {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"})
        self.assertEqual(behavior["FunctionAssociations"], [{
            "EventType": "viewer-request", "FunctionARN": "LangfuseViewerAccess.FunctionARN",
        }])
        self.assertEqual(
            {error["ErrorCode"] for error in config["CustomErrorResponses"]},
            {"400", "403", "404", "405", "414", "416", "500", "501", "502", "503", "504"},
        )
        for error in config["CustomErrorResponses"]:
            self.assertEqual(error["ErrorCachingMinTTL"], "0")
            self.assertNotIn("ResponseCode", error)

    def run_access_function(self, configured_ip, viewer_ip):
        properties = self.template["Resources"]["LangfuseViewerAccess"]["Properties"]
        self.assertEqual(properties["FunctionConfig"]["Runtime"], "cloudfront-js-2.0")
        self.assertEqual(properties["AutoPublish"], "true")
        function = properties["FunctionCode"].replace("${LangfuseAllowedIpv4}", configured_ip)
        events = [{
            "viewer": {"ip": viewer_ip},
            "request": {
                "method": "POST", "uri": uri,
                "querystring": {"callbackUrl": {"value": "/project/production/traces"}},
                "cookies": {"session": {"value": "existing-session"}},
                "headers": {
                    "host": {"value": "example.cloudfront.net"},
                    "x-govbiz-langfuse-access": {"value": "allowed", "multiValue": [{"value": "allowed"}]},
                    "x-govbiz-langfuse-host": {"value": "attacker.invalid"},
                    "x-govbiz-langfuse-origin": {"value": "viewer-controlled"},
                    "x-forwarded-for": {"value": "203.0.113.9"},
                    "x-forwarded-host": {"value": "attacker.invalid"},
                    "authorization": {"value": "existing-session"},
                    "origin": {"value": "https://example.cloudfront.net"},
                },
            },
        } for uri in ("/", "/auth/sign-in", "/api/auth/callback/credentials", "/_next/static/app.js", "/project/production/traces", "/api/../auth/sign-in", "/%61pi/auth/session")]
        result = subprocess.run(
            ["node", "-e", function + "\nconst events = " + json.dumps(events)
             + "; process.stdout.write(JSON.stringify(events.map(handler)));"],
            check=True, text=True, capture_output=True,
        )
        return events, json.loads(result.stdout)

    def test_disallowed_or_disabled_ip_is_denied_before_any_origin_request(self):
        for allowed_ip, actual_ip in (("203.0.113.9", "198.51.100.4"), ("", "203.0.113.9"), ("203.0.113.9", "::ffff:203.0.113.9")):
            with self.subTest(configured=allowed_ip, viewer=actual_ip):
                _, responses = self.run_access_function(allowed_ip, actual_ip)
                for response in responses:
                    self.assertEqual(response, {
                        "statusCode": 403, "statusDescription": "Forbidden",
                        "headers": {"cache-control": {"value": "no-store"}},
                    })

    def test_allowed_ip_replaces_spoofed_headers_without_changing_login_or_trace_requests(self):
        events, requests = self.run_access_function("203.0.113.9", "203.0.113.9")
        for event, request in zip(events, requests, strict=True):
            expected = event["request"]
            expected["headers"]["x-govbiz-langfuse-access"] = {"value": "allowed"}
            expected["headers"]["x-govbiz-langfuse-host"] = {"value": "example.cloudfront.net"}
            expected["headers"].pop("x-govbiz-langfuse-origin")
            self.assertEqual(request, expected)


if __name__ == "__main__":
    unittest.main()
