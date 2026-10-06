"""Declared Service compatibility, independently of cluster reachability."""

import copy
import json
import unittest

from gitops_service import service_review


class ServiceReviewTests(unittest.TestCase):
    def setUp(self):
        self.service = {
            "spec": {
                "type": "ClusterIP",
                "selector": {"app": "test"},
                "ports": [{"name": "http", "port": 80, "targetPort": "http"}],
            }
        }
        self.deployment = {
            "spec": {
                "selector": {"matchLabels": {"app": "test"}},
                "template": {
                    "metadata": {"labels": {"app": "test"}},
                    "spec": {
                        "containers": [
                            {"ports": [{"name": "http", "containerPort": 8080}]}
                        ]
                    },
                },
            }
        }
        self.expected = copy.deepcopy(self.service)
        self.expected_deployment = copy.deepcopy(self.deployment)

    def review(self):
        return service_review(
            self.service, self.expected, self.deployment, self.expected_deployment
        )

    def test_api_allocations_defaults_and_port_order_are_not_changes(self):
        spec = self.service["spec"]
        spec.update(
            clusterIP="10.96.0.1",
            clusterIPs=["10.96.0.1"],
            ipFamilies=["IPv4"],
            ipFamilyPolicy="SingleStack",
            sessionAffinity="None",
            internalTrafficPolicy="Cluster",
            publishNotReadyAddresses=False,
        )
        extra = {"name": "metrics", "port": 9090}
        spec["ports"].append(copy.deepcopy(extra))
        self.expected["spec"]["ports"].append(extra)
        spec["ports"].reverse()
        spec["ports"][0].update(targetPort=9090, protocol="TCP")
        spec["ports"][1]["protocol"] = "TCP"
        before = copy.deepcopy(self.service)
        self.assertEqual(self.review(), {"changedFields": [], "routingErrors": []})
        self.assertEqual(self.service, before)

    def test_service_changes_are_detected_without_reporting_values(self):
        changes = {
            "type": "NodePort",
            "selector": {"app": "PRIVATE"},
            "ports": [{"port": 1234, "targetPort": "PRIVATE"}],
            "clusterIP": "None",
            "ipFamilyPolicy": "RequireDualStack",
            "sessionAffinity": "ClientIP",
            "publishNotReadyAddresses": True,
            "internalTrafficPolicy": "Local",
            "externalTrafficPolicy": "Local",
            "externalName": "PRIVATE.example",
            "externalIPs": ["192.0.2.2"],
            "loadBalancerIP": "192.0.2.3",
            "loadBalancerClass": "PRIVATE",
            "loadBalancerSourceRanges": ["192.0.2.0/24"],
            "allocateLoadBalancerNodePorts": False,
            "healthCheckNodePort": 31000,
            "trafficDistribution": "PreferSameNode",
        }
        for field, value in changes.items():
            with self.subTest(field=field):
                self.service = copy.deepcopy(self.expected)
                self.service["spec"][field] = value
                report = self.review()
                self.assertIn(f"service.{field}", report["changedFields"])
                self.assertNotIn("PRIVATE", json.dumps(report))
                self.assertNotIn("192.0.2", json.dumps(report))

    def test_explicit_address_and_family_references_are_compared(self):
        for field, value in (
            ("clusterIP", "192.0.2.2"),
            ("clusterIPs", ["192.0.2.2"]),
            ("ipFamilies", ["IPv6"]),
        ):
            with self.subTest(field=field):
                self.expected["spec"][field] = value
                self.assertIn(f"service.{field}", self.review()["changedFields"])
                del self.expected["spec"][field]

    def test_unknown_service_fields_are_not_silently_ignored_or_exposed(self):
        self.service["spec"]["PRIVATE-key"] = "PRIVATE-value"
        self.assertEqual(self.review()["changedFields"], ["service.otherFields"])
        self.assertNotIn("PRIVATE", json.dumps(self.review()))

    def test_missing_ports_and_duplicate_entries_are_differences(self):
        for ports in ([], self.service["spec"]["ports"] * 2):
            with self.subTest(ports=ports):
                self.service["spec"]["ports"] = ports
                self.assertIn("service.ports", self.review()["changedFields"])

    def test_selector_must_select_the_pod(self):
        for selector in ({}, {"app": "PRIVATE"}, {"app": "test", "zone": "PRIVATE"}):
            with self.subTest(selector=selector):
                self.service["spec"]["selector"] = selector
                self.assertEqual(
                    self.review()["routingErrors"], ["selector_does_not_match_pod"]
                )
                self.assertNotIn("PRIVATE", json.dumps(self.review()))
        self.service["spec"]["selector"] = {"app": "test"}
        self.deployment["spec"]["template"]["metadata"]["labels"]["extra"] = "PRIVATE"
        self.assertEqual(self.review()["routingErrors"], [])
        self.assertEqual(self.review()["changedFields"], ["deployment.podLabels"])

    def test_deployment_selector_and_labels_are_preserved(self):
        self.deployment["spec"]["selector"] = {"matchLabels": {"app": "PRIVATE"}}
        self.deployment["spec"]["template"]["metadata"]["labels"] = {"app": "PRIVATE"}
        self.assertEqual(
            self.review()["changedFields"],
            ["deployment.podLabels", "deployment.selector"],
        )
        self.assertEqual(
            self.review()["routingErrors"], ["selector_does_not_match_pod"]
        )
        self.assertNotIn("PRIVATE", json.dumps(self.review()))

    def test_named_target_requires_one_port_with_matching_protocol(self):
        container = self.deployment["spec"]["template"]["spec"]["containers"][0]
        for ports in (
            [],
            [{"name": "PRIVATE", "containerPort": 8080}],
            [{"name": "http", "containerPort": 8080, "protocol": "UDP"}],
            [{"name": "http", "containerPort": 8080}] * 2,
        ):
            with self.subTest(ports=ports):
                container["ports"] = ports
                self.assertEqual(
                    self.review()["routingErrors"],
                    ["named_target_port_unresolved_or_ambiguous"],
                )
        container["ports"] = [{"name": "http", "containerPort": 8080}]
        self.deployment["spec"]["template"]["spec"]["containers"].append(
            copy.deepcopy(container)
        )
        self.assertEqual(
            self.review()["routingErrors"],
            ["named_target_port_unresolved_or_ambiguous"],
        )

    def test_numeric_target_does_not_require_declared_container_port(self):
        self.deployment["spec"]["template"]["spec"]["containers"][0]["ports"] = []
        self.service["spec"]["ports"][0]["targetPort"] = 8080
        self.expected = copy.deepcopy(self.service)
        self.assertEqual(self.review(), {"changedFields": [], "routingErrors": []})

    def test_load_balancer_and_affinity_defaults_are_equivalent(self):
        self.expected["spec"].update(type="LoadBalancer", sessionAffinity="ClientIP")
        self.service = copy.deepcopy(self.expected)
        self.service["spec"].update(
            allocateLoadBalancerNodePorts=True,
            externalTrafficPolicy="Cluster",
            sessionAffinityConfig={"clientIP": {"timeoutSeconds": 10800}},
        )
        self.assertEqual(self.review(), {"changedFields": [], "routingErrors": []})
        self.service["spec"]["sessionAffinityConfig"]["clientIP"]["timeoutSeconds"] = 1
        self.assertEqual(
            self.review()["changedFields"], ["service.sessionAffinityConfig"]
        )


if __name__ == "__main__":
    unittest.main()
