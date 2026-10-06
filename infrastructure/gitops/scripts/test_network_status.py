"""Read-only endpoint diagnostics must not turn stale routes into healthy reports."""

import copy
import json
import subprocess
import unittest
from unittest.mock import patch

import network_status as status


NS = "govbiz-msa"


def fixture(name="core-service"):
    def meta(suffix):
        return {
            "name": name + suffix,
            "uid": name + suffix + "-uid",
            "namespace": NS,
            "resourceVersion": "1",
        }

    labels = {"app": name, "PRIVATE-label": "PRIVATE-value"}
    service = {
        "kind": "Service",
        "metadata": meta(""),
        "spec": {
            "type": "ClusterIP",
            "selector": labels,
            "ipFamilies": ["IPv4"],
            "ports": [{"name": "http", "port": 80, "targetPort": "http"}],
        },
    }
    pod = {
        "kind": "Pod",
        "metadata": meta("-pod") | {"labels": labels},
        "spec": {
            "containers": [
                {
                    "name": name,
                    "ports": [{"name": "http", "containerPort": 8080}],
                    "env": [{"name": "PRIVATE", "value": "PRIVATE-token"}],
                }
            ]
        },
        "status": {
            "phase": "Running",
            "conditions": [{"type": "Ready", "status": "True"}],
            "podIPs": [{"ip": "10.244.0.2"}],
        },
    }
    endpoint = {
        "kind": "EndpointSlice",
        "metadata": meta("-slice")
        | {
            "labels": {status.SERVICE_LABEL: name},
            "ownerReferences": [
                {
                    "apiVersion": "v1",
                    "kind": "Service",
                    "name": name,
                    "uid": service["metadata"]["uid"],
                    "controller": True,
                }
            ],
        },
        "addressType": "IPv4",
        "ports": [{"name": "http", "protocol": "TCP", "port": 8080}],
        "endpoints": [
            {
                "addresses": ["10.244.0.2"],
                "targetRef": {
                    "kind": "Pod",
                    "name": pod["metadata"]["name"],
                    "namespace": NS,
                    "uid": pod["metadata"]["uid"],
                },
                "conditions": {"ready": True, "serving": True, "terminating": False},
            }
        ],
    }
    return service, pod, endpoint


def indexed(items):
    return {(item["kind"], item["metadata"]["name"]): item for item in items}


class ServiceEndpointTests(unittest.TestCase):
    def setUp(self):
        self.service, self.pod, self.slice = fixture()

    def report(self, extra=()):
        return status.service_status(
            "core-service", indexed([self.service, self.pod, self.slice, *extra]), NS
        )

    def test_ready_reference_reports_counts_without_private_details(self):
        before = copy.deepcopy([self.service, self.pod, self.slice])
        report = self.report()
        self.assertEqual(
            report,
            {
                "service": "core-service",
                "status": "PASS",
                "issues": [],
                "slice_count": 1,
                "selected_pod_count": 1,
                "ready_pod_count": 1,
                "ready_endpoint_count": 1,
            },
        )
        self.assertEqual([self.service, self.pod, self.slice], before)
        for private in ("PRIVATE", "10.244", "8080", "-pod", "-uid"):
            self.assertNotIn(private, json.dumps(report))

    def test_missing_service_selector_pods_and_slices_are_not_healthy(self):
        self.assertEqual(
            status.service_status("ai-service", {}, NS)["issues"], ["SERVICE_MISSING"]
        )
        self.service["spec"]["selector"] = {}
        self.assertEqual(self.report()["issues"], ["POD_SELECTOR_REQUIRED"])
        self.service["spec"]["selector"] = {"app": "missing"}
        self.assertIn("SELECTED_PODS_MISSING", self.report()["issues"])
        report = status.service_status(
            "core-service", indexed([self.service, self.pod]), NS
        )
        self.assertIn("ENDPOINT_SLICES_MISSING", report["issues"])
        self.service["spec"]["type"] = "ExternalName"
        self.assertEqual(self.report()["issues"], ["POD_SELECTOR_REQUIRED"])

    def test_empty_endpoints_and_incomplete_ready_pod_coverage_fail(self):
        original = copy.deepcopy(self.slice["endpoints"])
        self.slice["endpoints"] = []
        self.assertIn("NO_READY_ENDPOINTS", self.report()["issues"])
        self.assertIn("ENDPOINT_COVERAGE_INCOMPLETE", self.report()["issues"])
        self.slice["endpoints"] = original
        extra = copy.deepcopy(self.pod)
        extra["metadata"].update(name="extra-pod", uid="extra-uid")
        extra["status"]["podIPs"] = [{"ip": "10.244.0.3"}]
        self.assertIn("ENDPOINT_COVERAGE_INCOMPLETE", self.report([extra])["issues"])

    def test_stale_foreign_or_unselected_pod_reference_fails(self):
        ref = self.slice["endpoints"][0]["targetRef"]
        for field in ("uid", "namespace", "kind", "name"):
            original = ref[field]
            with self.subTest(field=field):
                ref[field] = "PRIVATE"
                self.assertIn("ENDPOINT_TARGET_MISMATCH", self.report()["issues"])
                self.assertEqual(self.report()["ready_endpoint_count"], 0)
            ref[field] = original
        self.pod["metadata"]["labels"] = {"app": "another-service"}
        self.assertIn("ENDPOINT_TARGET_MISMATCH", self.report()["issues"])

    def test_foreign_or_deleting_slice_and_service_are_not_healthy(self):
        owner = self.slice["metadata"]["ownerReferences"][0]
        for field in ("apiVersion", "kind", "name", "uid", "controller"):
            original = owner[field]
            with self.subTest(field=field):
                owner[field] = "PRIVATE"
                self.assertIn("ENDPOINT_SLICE_OWNER_INVALID", self.report()["issues"])
            owner[field] = original
        self.slice["metadata"]["deletionTimestamp"] = "now"
        self.assertIn("ENDPOINT_SLICE_OWNER_INVALID", self.report()["issues"])
        self.service["metadata"]["deletionTimestamp"] = "now"
        self.assertIn("SERVICE_TERMINATING", self.report()["issues"])

    def test_pod_readiness_cannot_be_bypassed_by_publish_not_ready(self):
        self.service["spec"]["publishNotReadyAddresses"] = True
        for ready in ("False", "Unknown", None):
            self.pod["status"]["conditions"] = (
                [] if ready is None else [{"type": "Ready", "status": ready}]
            )
            with self.subTest(ready=ready):
                self.assertIn("SELECTED_PODS_NOT_READY", self.report()["issues"])
                self.assertIn("ENDPOINT_NOT_READY", self.report()["issues"])
        self.pod["status"]["conditions"] = [{"type": "Ready", "status": "True"}]
        self.pod["metadata"]["deletionTimestamp"] = "now"
        self.assertIn("ENDPOINT_NOT_READY", self.report()["issues"])
        del self.pod["metadata"]["deletionTimestamp"]
        self.pod["status"]["phase"] = "Pending"
        self.assertIn("ENDPOINT_NOT_READY", self.report()["issues"])

    def test_endpoint_conditions_and_nil_defaults(self):
        endpoint = self.slice["endpoints"][0]
        for condition in ("ready", "serving", "terminating"):
            endpoint["conditions"] = {condition: condition == "terminating"}
            with self.subTest(condition=condition):
                self.assertIn("ENDPOINT_NOT_READY", self.report()["issues"])
        for conditions in ({}, {"ready": None, "serving": None, "terminating": None}):
            endpoint["conditions"] = conditions
            self.assertEqual(self.report()["status"], "PASS")
        endpoint["conditions"] = {"ready": "true"}
        with self.assertRaises(ValueError):
            self.report()

    def test_address_and_family_must_match_the_current_pod(self):
        endpoint = self.slice["endpoints"][0]
        for addresses in ([], ["10.244.9.9"], ["10.244.0.2", "10.244.0.3"]):
            with self.subTest(addresses=addresses):
                endpoint["addresses"] = addresses
                self.assertIn("ENDPOINT_ADDRESS_MISMATCH", self.report()["issues"])
        endpoint["addresses"] = ["10.244.0.2"]
        self.slice["addressType"] = "IPv6"
        self.assertIn("ENDPOINT_ADDRESS_FAMILY_MISMATCH", self.report()["issues"])
        self.service["spec"]["ipFamilies"] = ["IPv6"]
        self.assertIn("ENDPOINT_ADDRESS_MISMATCH", self.report()["issues"])

    def test_ports_match_target_name_protocol_number_and_app_protocol(self):
        original = copy.deepcopy(self.slice["ports"])
        for field, value in (
            ("name", "wrong"),
            ("protocol", "UDP"),
            ("port", 9000),
            ("port", None),
            ("port", True),
            ("appProtocol", "PRIVATE"),
        ):
            self.slice["ports"] = copy.deepcopy(original)
            self.slice["ports"][0][field] = value
            with self.subTest(field=field, value=value):
                self.assertIn("ENDPOINT_PORT_MISMATCH", self.report()["issues"])
        self.slice["ports"] = original * 2
        self.assertIn("ENDPOINT_PORT_MISMATCH", self.report()["issues"])
        self.slice["ports"] = original
        self.pod["spec"]["containers"][0]["ports"] *= 2
        self.assertIn("ENDPOINT_PORT_MISMATCH", self.report()["issues"])
        self.pod["spec"]["containers"][0]["ports"] = []
        self.assertIn("ENDPOINT_PORT_MISMATCH", self.report()["issues"])
        self.service["spec"]["ports"][0]["targetPort"] = 8080
        self.assertEqual(self.report()["status"], "PASS")

    def test_multiple_service_ports_are_required_and_order_is_irrelevant(self):
        self.service["spec"]["ports"].append({"name": "metrics", "port": 9090})
        self.slice["ports"].append({"name": "metrics", "port": 9090})
        self.slice["ports"].reverse()
        self.assertEqual(self.report()["status"], "PASS")
        self.slice["ports"].pop()
        self.assertIn("ENDPOINT_PORT_MISMATCH", self.report()["issues"])

    def test_duplicate_endpoints_across_slices_do_not_inflate_counts(self):
        extra = copy.deepcopy(self.slice)
        extra["metadata"].update(name="second-slice", uid="second-uid")
        result = self.report([extra])
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["slice_count"], 2)
        self.assertEqual(result["ready_endpoint_count"], 1)

    def test_dual_stack_requires_both_families(self):
        self.service["spec"]["ipFamilies"].append("IPv6")
        self.pod["status"]["podIPs"].append({"ip": "fd00::2"})
        self.assertIn("ENDPOINT_COVERAGE_INCOMPLETE", self.report()["issues"])
        ipv6 = copy.deepcopy(self.slice)
        ipv6["metadata"].update(name="ipv6-slice", uid="ipv6-uid")
        ipv6["addressType"] = "IPv6"
        ipv6["endpoints"][0]["addresses"] = ["fd00::2"]
        self.assertEqual(self.report([ipv6])["status"], "PASS")
        self.assertEqual(self.report([ipv6])["ready_endpoint_count"], 2)


class NetworkSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.items = [item for name in status.SERVICES for item in fixture(name)]
        self.payload = {"items": self.items}
        self.command = self.enterContext(
            patch.object(
                status, "run", side_effect=lambda *a, **k: json.dumps(self.payload)
            )
        )

    def snapshot(self):
        return status.snapshot(
            {"namespace": NS}, ["kubectl", "--context", "owned", "-n", NS]
        )

    def test_only_bounded_namespaced_reads_and_no_traffic_claims(self):
        report = self.snapshot()
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(len(report["services"]), 4)
        for flag in ("traffic_verified", "network_policy_verified", "services_changed"):
            self.assertFalse(report[flag])
        for args, kwargs in self.command.call_args_list:
            self.assertEqual(
                args[0],
                [
                    "kubectl",
                    "--context",
                    "owned",
                    "-n",
                    NS,
                    "get",
                    "services,pods,endpointslices.discovery.k8s.io",
                    "-o",
                    "json",
                ],
            )
            self.assertEqual(kwargs, {"capture": True, "timeout": 15})
        self.assertEqual(self.command.call_count, 2)
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_each_missing_service_makes_overall_status_fail(self):
        for name in status.SERVICES:
            with self.subTest(service=name):
                self.payload = {
                    "items": [
                        item
                        for item in self.items
                        if not (
                            item["kind"] == "Service"
                            and item["metadata"]["name"] == name
                        )
                    ]
                }
                report = self.snapshot()
                self.assertEqual(report["status"], "FAIL")
                self.assertEqual(
                    next(s for s in report["services"] if s["service"] == name)[
                        "issues"
                    ],
                    ["SERVICE_MISSING"],
                )

    def test_lookup_failure_is_unknown_and_never_leaks_errors(self):
        for error in (
            OSError("PRIVATE"),
            subprocess.TimeoutExpired("PRIVATE", 15, output="PRIVATE"),
            subprocess.CalledProcessError(1, "PRIVATE", output="PRIVATE"),
        ):
            with self.subTest(error=type(error)):
                self.command.side_effect = error
                report = self.snapshot()
                self.assertEqual(report["status"], "UNKNOWN")
                self.assertEqual(report["issues"], ["NETWORK_INSPECTION_FAILED"])
                self.assertNotIn("PRIVATE", json.dumps(report))

    def test_malformed_partial_and_duplicate_responses_are_unknown(self):
        for payload in (
            {"items": "PRIVATE"},
            {"metadata": {"continue": "PRIVATE"}, "items": self.items},
            {"items": self.items + [self.items[0]]},
        ):
            with self.subTest(payload_type=type(payload["items"])):
                self.payload = payload
                self.assertEqual(self.snapshot()["status"], "UNKNOWN")
        self.command.side_effect = None
        self.command.return_value = "PRIVATE invalid JSON"
        self.assertEqual(self.snapshot()["status"], "UNKNOWN")

    def test_null_payload_and_reused_resource_uid_are_unknown(self):
        for payload in (
            None,
            {"items": [None]},
            {"items": [{"kind": "Service", "metadata": None}]},
        ):
            with self.subTest(payload=payload):
                self.payload = payload
                self.assertEqual(self.snapshot()["status"], "UNKNOWN")
        extra = copy.deepcopy(self.items[1])
        extra["metadata"]["name"] = "other-pod-with-same-uid"
        self.payload = {"items": self.items + [extra]}
        self.assertEqual(self.snapshot()["status"], "UNKNOWN")

    def test_resource_namespace_uid_and_version_are_required(self):
        for index in (0, 1, 2):
            for field, value in (
                ("namespace", "other"),
                ("uid", None),
                ("resourceVersion", None),
            ):
                original = self.items[index]["metadata"][field]
                with self.subTest(kind=self.items[index]["kind"], field=field):
                    self.items[index]["metadata"][field] = value
                    self.assertEqual(self.snapshot()["status"], "UNKNOWN")
                self.items[index]["metadata"][field] = original

    def test_changes_in_service_pod_or_slice_invalidate_all_results(self):
        for index in (0, 1, 2):
            changed = copy.deepcopy(self.items)
            changed[index]["metadata"]["resourceVersion"] = "2"
            with self.subTest(kind=changed[index]["kind"]):
                self.command.side_effect = [
                    json.dumps({"items": self.items}),
                    json.dumps({"items": changed}),
                ]
                report = self.snapshot()
                self.assertEqual(report["status"], "UNKNOWN")
                self.assertEqual(report["issues"], ["NETWORK_CHANGED_DURING_CHECK"])
                self.assertTrue(
                    all(s["status"] == "UNKNOWN" for s in report["services"])
                )

    def test_second_read_failure_does_not_leave_pass_service_results(self):
        self.command.side_effect = [json.dumps(self.payload), OSError("PRIVATE")]
        report = self.snapshot()
        self.assertEqual(report["status"], "UNKNOWN")
        self.assertTrue(all(s["status"] == "UNKNOWN" for s in report["services"]))
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_unrelated_database_and_compose_bridge_resources_are_ignored(self):
        unrelated = fixture("prefect-bridge")
        changed = copy.deepcopy(unrelated)
        changed[1]["metadata"]["resourceVersion"] = "2"
        self.command.side_effect = [
            json.dumps({"items": self.items + list(unrelated)}),
            json.dumps({"items": list(reversed(self.items)) + list(changed)}),
        ]
        self.assertEqual(self.snapshot()["status"], "PASS")


if __name__ == "__main__":
    unittest.main()
