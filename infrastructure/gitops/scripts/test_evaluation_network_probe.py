"""Traffic verdicts and ownership-safe cleanup without a cluster."""

import contextlib
import copy
import io
import json
import socket
import unittest
from unittest.mock import MagicMock, patch

import evaluation_network_probe as probe


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.resources = {}
        self.created = []
        self.deleted = []
        self.enforced = True
        self.baseline_broken = False
        self.allow_broken = False
        self.server_broken = False
        self.response_invalid = False
        self.create_timeout = False
        self.replace_namespace = False
        self.node_changed = False
        self.cleanup_failure = False
        self.service_bypass = None
        self.dns_failure_during_policy = False
        self.service_create_timeout = False
        self.node_reads = 0
        self.clock = 0
        self.counter = 0
        self.kube = ["kubectl", "--context", "isolated"]
        for target, replacement in (
            ("pvc.run", self.fake_run),
            ("pvc.snapshot.storage.run", lambda *_args, **_kwargs: b""),
            ("time.sleep", lambda *_args: None),
            ("time.monotonic", self.monotonic),
        ):
            patcher = patch("evaluation_network_probe." + target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def monotonic(self):
        self.clock += 10
        return self.clock

    def fake_run(self, command, *, value=None, timeout=60):
        args = command[len(self.kube) :]
        namespace = None
        if args[:1] == ["-n"]:
            namespace, args = args[1], args[2:]
        if args[:3] == ["get", "node", "fixture-control-plane"]:
            self.node_reads += 1
            return {
                "metadata": {
                    "uid": "replacement"
                    if self.node_changed and self.node_reads > 1
                    else "node-uid"
                },
                "status": {"conditions": [{"type": "Ready", "status": "True"}]},
            }
        if args[0] == "get":
            item = copy.deepcopy(self.resources.get((namespace, args[1].lower(), args[2])))
            if item and self.replace_namespace and args[1] == "namespace":
                item["metadata"]["uid"] = "replacement"
            return item
        if args[0] == "create":
            item = copy.deepcopy(value)
            self.counter += 1
            item["metadata"]["uid"] = "uid-" + str(self.counter)
            meta = item["metadata"]
            key = (meta.get("namespace"), item["kind"].lower(), meta["name"])
            self.assertNotIn(key, self.resources)
            if item["kind"] == "Pod":
                item["status"] = {"podIP": "10.244.0." + str(self.counter)}
                item["spec"]["nodeName"] = "fixture-control-plane"
            if item["kind"] == "Service":
                item["spec"]["clusterIP"] = "10.96.0." + str(self.counter)
            self.resources[key] = item
            self.created.append(item)
            if self.create_timeout and item["kind"] == "Namespace":
                raise TimeoutError("PRIVATE_DIAGNOSTIC")
            if self.service_create_timeout and item["kind"] == "Service":
                raise TimeoutError("PRIVATE_DIAGNOSTIC")
            return copy.deepcopy(item)
        if args[:2] == ["delete", "--raw"]:
            path = args[2].split("/")
            name = path[-1]
            ns = path[5] if "networkpolicies" in path else None
            kind = "networkpolicy" if ns else "namespace"
            key = (ns, kind, name)
            self.assertEqual(value["preconditions"]["uid"], self.resources[key]["metadata"]["uid"])
            self.deleted.append(key)
            if self.cleanup_failure and kind == "namespace" and name.endswith("-b"):
                raise TimeoutError("PRIVATE_DIAGNOSTIC")
            self.resources.pop(key)
            if kind == "namespace":
                self.resources = {k: v for k, v in self.resources.items() if k[0] != name}
            return {"kind": "Status", "status": "Success"}
        if args[0] == "exec":
            source, address, expected_ip = args[1], args[-4], args[-1]
            if self.response_invalid:
                return {"outcome": "unexpected_response", "private": "PRIVATE_DIAGNOSTIC"}
            policies = any(k[1] == "networkpolicy" for k in self.resources)
            if address == "127.0.0.1":
                return {"outcome": "rejected" if self.server_broken else "reachable"}
            service = next(
                (
                    v
                    for k, v in self.resources.items()
                    if k[1] == "service" and v["spec"]["clusterIP"] == (expected_ip or address)
                ),
                None,
            )
            mode = "service_dns" if expected_ip else "cluster_ip" if service else "pod_ip"
            if expected_ip:
                self.assertIsNotNone(service)
                meta = service["metadata"]
                self.assertEqual(address, f"{meta['name']}.{meta['namespace']}.svc.cluster.local.")
                if policies and self.dns_failure_during_policy and source == "foreign-runner":
                    return {"outcome": "dns_error"}
            destination = (
                service["metadata"]["name"]
                if service
                else next(
                    k[2]
                    for k, v in self.resources.items()
                    if k[1] == "pod" and v["status"]["podIP"] == address
                )
            )
            allow = (source, destination) in {
                ("allowed", "server"),
                ("ops", "prefect"),
                ("ops", "ops-artifacts"),
                ("evaluation-runner", "prefect"),
            }
            blocked = (not policies and self.baseline_broken) or (
                policies
                and self.enforced
                and mode != self.service_bypass
                and (not allow or self.allow_broken)
            )
            return {"outcome": "timeout" if blocked else "reachable"}
        self.fail("Unexpected command: " + str(args))

    def exercise(self):
        return probe.exercise(self.kube, "fixture-control-plane")

    def test_enforcement_requires_three_rounds_and_full_recovery(self):
        result = self.exercise()
        self.assertEqual(result["status"], "ENFORCED")
        self.assertTrue(result["networkPolicyEnforcementVerified"])
        self.assertEqual(result["consecutivePassingRounds"], 3)
        self.assertEqual(set(result["baseline"].values()), {"reachable"})
        self.assertEqual(set(result["recovery"].values()), {"reachable"})
        self.assertFalse(result["productionCutover"])
        self.assertFalse(result["evaluationRuntimeVerified"])
        self.assertFalse(result["serviceClusterIPVerified"])
        self.assertFalse(result["serviceDnsVerified"])
        self.assertTrue(result["cleanupComplete"])
        self.assertFalse(self.resources)

    def test_cni_ignoring_policies_fails_after_bounded_observation(self):
        self.enforced = False
        result = self.exercise()
        self.assertEqual(result["status"], "NOT_ENFORCED")
        self.assertFalse(result["networkPolicyEnforcementVerified"])
        self.assertEqual(set(result["policyChecks"].values()), {"reachable"})
        self.assertTrue(result["cleanupComplete"])
        self.assertLess(self.clock, 200)

    def test_broken_baseline_never_creates_policies(self):
        self.baseline_broken = True
        result = self.exercise()
        self.assertEqual(result["status"], "ERROR")
        self.assertFalse(any(r["kind"] == "NetworkPolicy" for r in self.created))
        self.assertFalse(self.resources)

    def test_blocking_everything_does_not_pass(self):
        self.allow_broken = True
        result = self.exercise()
        self.assertEqual(result["status"], "INCONCLUSIVE")
        self.assertFalse(result["networkPolicyEnforcementVerified"])
        self.assertTrue(result["cleanupComplete"])

    def test_dead_server_and_changed_node_never_pass(self):
        for attribute in ("server_broken", "node_changed"):
            with self.subTest(attribute=attribute):
                setattr(self, attribute, True)
                result = self.exercise()
                self.assertEqual(result["status"], "ERROR")
                self.assertFalse(result["networkPolicyEnforcementVerified"])
                self.assertFalse(self.resources)
                setattr(self, attribute, False)
                self.node_reads = 0

    def test_create_response_loss_cleans_only_token_owned_namespace(self):
        self.create_timeout = True
        result = self.exercise()
        self.assertEqual(result["status"], "ERROR")
        self.assertNotIn("PRIVATE_DIAGNOSTIC", json.dumps(result))
        self.assertTrue(result["cleanupComplete"])
        self.assertEqual(len(self.deleted), 1)
        self.assertFalse(self.resources)

    def test_replaced_namespace_is_not_deleted(self):
        self.replace_namespace = True
        result = self.exercise()
        self.assertEqual(result["status"], "ERROR")
        self.assertFalse(result["cleanupComplete"])
        self.assertEqual(len(result["cleanupErrors"]), 2)
        self.assertFalse(any(k[1] == "namespace" for k in self.deleted))

    def test_cleanup_failure_does_not_skip_other_namespace_or_report_success(self):
        self.cleanup_failure = True
        result = self.exercise()
        self.assertEqual(result["status"], "ERROR")
        self.assertFalse(result["networkPolicyEnforcementVerified"])
        self.assertEqual(len([k for k in self.deleted if k[1] == "namespace"]), 2)
        self.assertNotIn("PRIVATE_DIAGNOSTIC", json.dumps(result))

    def test_unexpected_http_or_exec_output_is_not_policy_denial(self):
        self.response_invalid = True
        result = self.exercise()
        self.assertEqual(result["status"], "ERROR")
        self.assertNotIn("PRIVATE_DIAGNOSTIC", json.dumps(result))
        self.assertFalse(self.resources)

    def test_probe_resources_have_no_credentials_storage_or_privileges(self):
        self.exercise()
        pods = [r for r in self.created if r["kind"] == "Pod"]
        self.assertEqual(len(pods), 4)
        for item in pods:
            spec = item["spec"]
            self.assertFalse(spec["automountServiceAccountToken"])
            self.assertFalse(spec.get("hostNetwork"))
            self.assertNotIn("volumes", spec)
            self.assertTrue(spec["securityContext"]["runAsNonRoot"])
            container = spec["containers"][0]
            self.assertNotIn("env", container)
            self.assertIn("@sha256:", container["image"])
            self.assertEqual(container["resources"]["limits"]["memory"], "64Mi")
            self.assertEqual(container["securityContext"]["capabilities"], {"drop": ["ALL"]})

    def test_cli_rejects_unowned_cluster_before_creating_resources(self):
        with (
            patch("sys.argv", ["probe"]),
            patch.object(probe.fork_cluster, "locked", return_value=contextlib.nullcontext()),
            patch.object(probe.fork_cluster, "load_settings", return_value={}),
            patch.object(probe.fork_cluster, "commands", return_value=(self.kube, [], [])),
            patch.object(
                probe.fork_cluster, "verify_context", side_effect=ValueError("PRIVATE_DIAGNOSTIC")
            ),
            contextlib.redirect_stdout(io.StringIO()) as stdout,
        ):
            self.assertEqual(probe.main(), 1)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["status"], "ERROR")
        self.assertNotIn("PRIVATE_DIAGNOSTIC", stdout.getvalue())
        self.assertFalse(self.created)

    def test_actual_chart_policies_cover_ops_runner_and_impostor_clients(self):
        result = probe.exercise(self.kube, "fixture-control-plane", helm="helm")
        self.assertEqual(result["status"], "ENFORCED")
        self.assertEqual(result["policyProfile"], "evaluation_chart")
        self.assertEqual(sum(result["expectedReachability"].values()), 9)
        self.assertEqual(len(result["policyChecks"]), 22)
        self.assertTrue(result["serviceClusterIPVerified"])
        self.assertTrue(result["serviceDnsVerified"])
        self.assertEqual(result["addressModes"], ["pod_ip", "cluster_ip", "service_dns"])
        self.assertEqual(len(result["chartPolicySpecSha256"]), 3)
        self.assertFalse(result["evaluationRuntimeVerified"])
        self.assertFalse(self.resources)
        policies = [r for r in self.created if r["kind"] == "NetworkPolicy"]
        pods = [r for r in self.created if r["kind"] == "Pod"]
        self.assertEqual(len(policies), 3)
        self.assertEqual(len(pods), 6)
        services = [r for r in self.created if r["kind"] == "Service"]
        self.assertEqual({s["metadata"]["name"] for s in services}, {"prefect", "ops-artifacts"})
        for service in services:
            self.assertEqual(service["spec"]["type"], "ClusterIP")
            selected = [
                p
                for p in pods
                if p["metadata"]["labels"]["app.kubernetes.io/name"] == service["metadata"]["name"]
            ]
            self.assertEqual(len(selected), 1)
            self.assertEqual(service["spec"]["ports"][0]["targetPort"], "http")
            self.assertEqual(
                selected[0]["spec"]["containers"][0]["ports"],
                [
                    {
                        "name": "http",
                        "containerPort": service["spec"]["ports"][0]["port"],
                    }
                ],
            )
        self.assertNotIn("govbiz-msa", {r["metadata"]["namespace"] for r in policies + pods})
        for policy in policies:
            for rule in policy["spec"]["ingress"]:
                for peer in rule["from"]:
                    if "namespaceSelector" in peer:
                        self.assertEqual(
                            peer["namespaceSelector"]["matchLabels"],
                            {
                                "kubernetes.io/metadata.name": result["namespaceRebinding"][
                                    "govbiz-msa"
                                ]
                            },
                        )
                        self.assertEqual(
                            peer["podSelector"]["matchLabels"],
                            {"app.kubernetes.io/name": "ops-service"},
                        )
        self.assertEqual(
            {p["spec"]["containers"][0]["command"][-1] for p in pods}, {"4200", "8010", "8090"}
        )

    def test_chart_policy_scope_and_render_failure_prevent_all_writes(self):
        render = probe.render_bundle
        for problem in ("missing", "namespace", "foreign_peer", "helm"):

            def invalid(*args, problem=problem, **kwargs):
                if problem == "helm":
                    raise ValueError("PRIVATE_DIAGNOSTIC")
                rows = render(*args, **kwargs)
                if problem == "missing":
                    del rows["prefect"]
                else:
                    policy = next(r for r in rows["prefect"] if r["kind"] == "NetworkPolicy")
                    if problem == "namespace":
                        policy["metadata"]["namespace"] = "govbiz-msa"
                    else:
                        policy["spec"]["ingress"][0]["from"][0]["namespaceSelector"] = {}
                return rows

            with (
                self.subTest(problem=problem),
                patch.object(probe, "render_bundle", side_effect=invalid),
            ):
                result = probe.exercise(self.kube, "fixture-control-plane", helm="helm")
            self.assertEqual(result["status"], "ERROR")
            self.assertFalse(self.created)
            self.assertNotIn("PRIVATE_DIAGNOSTIC", json.dumps(result))

    def test_chart_profile_never_passes_when_cni_ignores_policies(self):
        self.enforced = False
        result = probe.exercise(self.kube, "fixture-control-plane", helm="helm")
        self.assertEqual(result["status"], "NOT_ENFORCED")
        self.assertTrue(result["cleanupComplete"])
        self.assertFalse(result["networkPolicyEnforcementVerified"])

    def test_pod_ip_enforcement_cannot_hide_service_route_bypass(self):
        for mode in ("cluster_ip", "service_dns"):
            with self.subTest(mode=mode):
                self.service_bypass = mode
                result = probe.exercise(self.kube, "fixture-control-plane", helm="helm")
                self.assertEqual(result["status"], "NOT_ENFORCED")
                self.assertEqual(result["policyChecks"]["foreign_runner_to_prefect"], "timeout")
                self.assertEqual(
                    result["policyChecks"]["foreign_runner_to_prefect__" + mode], "reachable"
                )
                self.assertFalse(result["serviceDnsVerified"])
                self.assertFalse(result["serviceClusterIPVerified"])
                self.assertFalse(self.resources)

    def test_dns_failure_on_denied_route_is_not_successful_enforcement(self):
        self.dns_failure_during_policy = True
        result = probe.exercise(self.kube, "fixture-control-plane", helm="helm")
        self.assertEqual(result["status"], "ERROR")
        self.assertFalse(result["networkPolicyEnforcementVerified"])
        self.assertFalse(result["serviceDnsVerified"])
        self.assertTrue(result["cleanupComplete"])
        self.assertFalse(self.resources)

    def test_service_create_response_loss_still_cleans_owned_namespaces(self):
        self.service_create_timeout = True
        result = probe.exercise(self.kube, "fixture-control-plane", helm="helm")
        self.assertEqual(result["status"], "ERROR")
        self.assertTrue(result["cleanupComplete"])
        self.assertNotIn("PRIVATE_DIAGNOSTIC", json.dumps(result))
        self.assertFalse(self.resources)

    def test_unsafe_chart_services_fail_before_creating_any_resources(self):
        render = probe.render_bundle
        for problem in ("missing", "extra", "namespace", "external", "selector", "port"):

            def invalid(*args, problem=problem, **kwargs):
                rows = render(*args, **kwargs)
                service = next(r for r in rows["prefect"] if r["kind"] == "Service")
                if problem == "missing":
                    rows["prefect"].remove(service)
                elif problem == "extra":
                    rows["evaluation-runner"].append(service)
                elif problem == "namespace":
                    service["metadata"]["namespace"] = "govbiz-msa"
                elif problem == "external":
                    service["spec"]["externalIPs"] = ["192.0.2.1"]
                elif problem == "selector":
                    service["spec"]["selector"] = {}
                else:
                    service["spec"]["ports"][0]["targetPort"] = 80
                return rows

            with (
                self.subTest(problem=problem),
                patch.object(probe, "render_bundle", side_effect=invalid),
            ):
                result = probe.exercise(self.kube, "fixture-control-plane", helm="helm")
                self.assertEqual(result["status"], "ERROR")
                self.assertFalse(self.created)


class ClientTests(unittest.TestCase):
    def test_dns_errors_and_wrong_answers_never_become_http_denial(self):
        for answers, error, outcome in (
            ([], socket.gaierror("private"), "dns_error"),
            ([], TimeoutError("private"), "dns_error"),
            ([], None, "dns_mismatch"),
            (["10.96.0.9"], None, "dns_mismatch"),
            (["10.96.0.1", "10.96.0.9"], None, "dns_mismatch"),
        ):
            with (
                self.subTest(outcome=outcome, answers=answers),
                patch("sys.argv", ["probe", "prefect.fixture", "token", "4200", "10.96.0.1"]),
                patch(
                    "socket.getaddrinfo",
                    return_value=[
                        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 4200)) for ip in answers
                    ],
                    side_effect=error,
                ),
                patch("http.client.HTTPConnection") as connect,
                contextlib.redirect_stdout(io.StringIO()) as stdout,
                self.assertRaises(SystemExit),
            ):
                exec(probe.CLIENT, {})
            self.assertEqual(json.loads(stdout.getvalue()), {"outcome": outcome})
            connect.assert_not_called()

    def test_dns_connection_uses_the_verified_cluster_ip_and_fresh_connection(self):
        for blocked in (False, True):
            connection = MagicMock()
            connection.getresponse.return_value.status = 200
            connection.getresponse.return_value.read.return_value = b"token"
            if blocked:
                connection.request.side_effect = TimeoutError()
            with (
                self.subTest(blocked=blocked),
                patch("sys.argv", ["probe", "prefect.fixture", "token", "4200", "10.96.0.1"]),
                patch(
                    "socket.getaddrinfo",
                    return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.96.0.1", 4200))],
                ),
                patch("http.client.HTTPConnection", return_value=connection) as connect,
                contextlib.redirect_stdout(io.StringIO()) as stdout,
            ):
                exec(probe.CLIENT, {})
            self.assertEqual(
                json.loads(stdout.getvalue()),
                {
                    "outcome": "timeout" if blocked else "reachable",
                },
            )
            connect.assert_called_once_with("10.96.0.1", 4200, timeout=2)
            connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
