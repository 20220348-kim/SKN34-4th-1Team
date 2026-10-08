"""Traffic verdicts and ownership-safe cleanup without a cluster."""

import contextlib
import copy
import io
import json
import unittest
from unittest.mock import patch

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
            self.resources[key] = item
            self.created.append(item)
            if self.create_timeout and item["kind"] == "Namespace":
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
            source, address = args[1], args[-2]
            if self.response_invalid:
                return {"outcome": "unexpected_response", "private": "PRIVATE_DIAGNOSTIC"}
            policies = any(k[1] == "networkpolicy" for k in self.resources)
            if address == "127.0.0.1":
                return {"outcome": "rejected" if self.server_broken else "reachable"}
            server_ip = next(
                v["status"]["podIP"]
                for k, v in self.resources.items()
                if k[1:] == ("pod", "server")
            )
            allow = source == "allowed" and address == server_ip
            blocked = (not policies and self.baseline_broken) or (
                policies and self.enforced and (not allow or self.allow_broken)
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


if __name__ == "__main__":
    unittest.main()
