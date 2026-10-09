"""Private bridge ownership, routing, idempotency and Compose merge checks."""

import copy
import importlib.util
import io
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ops_bridge as bridge
import smoke_ops_bridge
from check_msa import REPOSITORY_ROOT
from fork_cluster import require_dev

SETTINGS = {
    "cluster": "govbiz-fixture",
    "stateId": "a" * 32,
    "namespace": "govbiz-msa",
    "repository": "alice/project",
    "mode": "dev",
}
PROJECT = "govbiz-llmops-test"


def fixture():
    network = {
        "Id": "network-id",
        "Name": bridge.network_name(SETTINGS),
        "Driver": "bridge",
        "Internal": True,
        "Scope": "local",
        "Labels": {
            bridge.STATE_KEY: SETTINGS["stateId"],
            "com.docker.compose.project": PROJECT,
            "com.docker.compose.network": "ops-bridge",
        },
        "IPAM": {"Config": [{"Subnet": "172.28.0.0/16"}]},
        "Containers": {},
    }
    node = {
        "Id": "node-id",
        "Name": "/govbiz-fixture-control-plane",
        "Running": True,
        "Labels": {
            "io.x-k8s.kind.cluster": "govbiz-fixture",
            "io.x-k8s.kind.role": "control-plane",
        },
    }
    containers = {}
    for index, service in enumerate(bridge.ENDPOINTS, 2):
        address = f"172.28.0.{index}"
        identity = service + "-id"
        containers[service] = {
            "Id": identity,
            "Running": True,
            "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": service,
            },
            "Ports": {},
            "Networks": {
                network["Name"]: {"NetworkID": network["Id"], "IPAddress": address}
            },
        }
        network["Containers"][identity] = {"IPv4Address": address + "/16"}
    return network, node, containers


class BridgePolicyTests(unittest.TestCase):
    def test_topology_reads_are_bounded_without_requesting_container_environment(self):
        network, node, containers = fixture()
        responses = [
            json.dumps([network]), json.dumps(node),
            "prefect-id", json.dumps(containers["prefect"]),
            "artifacts-id", json.dumps(containers["ops-artifacts"]),
        ]
        with patch.object(bridge, "run", side_effect=responses) as run:
            bridge.topology(SETTINGS, PROJECT)
        self.assertEqual(len(run.call_args_list), 6)
        for call in run.call_args_list:
            self.assertEqual(call.kwargs["timeout"], 15)
            self.assertNotIn(".Config.Env", " ".join(call.args[0]))

    def test_accepts_exact_private_members_without_exposing_credentials(self):
        network, node, containers = fixture()
        self.assertEqual(
            bridge.validate_network(SETTINGS, PROJECT, network, node, containers),
            {"prefect": "172.28.0.2", "ops-artifacts": "172.28.0.3"},
        )
        self.assertNotIn("TOKEN", bridge.environment(SETTINGS))
        self.assertEqual(bridge.values()["env"]["LLMOPS_LIVE_ENABLED"], "false")

    def test_other_owner_non_internal_network_and_extra_members_are_rejected(self):
        for mutate in (
            lambda n, node, c: n.update(Internal=False),
            lambda n, node, c: n.update(Driver="host"),
            lambda n, node, c: n["Labels"].update({bridge.STATE_KEY: "other"}),
            lambda n, node, c: n["Labels"].update(
                {"com.docker.compose.project": "other"}
            ),
            lambda n, node, c: n["Containers"].update({"foreign-node": {}}),
            lambda n, node, c: node["Labels"].update(
                {"io.x-k8s.kind.cluster": "other"}
            ),
            lambda n, node, c: c["prefect"].update(Running=False),
            lambda n, node, c: c["prefect"]["Labels"].update(
                {"com.docker.compose.oneoff": "True"}
            ),
            lambda n, node, c: c["prefect"]["Ports"].update(
                {"4200/tcp": [{"HostIp": "0.0.0.0"}]}
            ),
            lambda n, node, c: c["ops-artifacts"]["Ports"].update(
                {"8010/tcp": [{"HostIp": "127.0.0.1"}]}
            ),
        ):
            with self.subTest(mutate=mutate):
                network, node, containers = fixture()
                mutate(network, node, containers)
                with self.assertRaises(ValueError):
                    bridge.validate_network(
                        SETTINGS, PROJECT, network, node, containers
                    )

    def test_unattached_public_loopback_or_mismatched_addresses_are_rejected(self):
        for address in (
            "",
            "8.8.8.8",
            "127.0.0.1",
            "169.254.2.3",
            "172.29.0.2",
            "172.28.0.9",
        ):
            with self.subTest(address=address):
                network, node, containers = fixture()
                containers["prefect"]["Networks"][network["Name"]]["IPAddress"] = (
                    address
                )
                with self.assertRaises(ValueError):
                    bridge.validate_network(
                        SETTINGS, PROJECT, network, node, containers
                    )

    def test_service_dns_has_only_private_ipv4_endpoints_and_no_pod_selector(self):
        resources = bridge.manifests(
            SETTINGS, PROJECT, {"prefect": "172.28.0.2", "ops-artifacts": "172.28.0.3"}
        )
        self.assertEqual(len(resources), 4)
        for service, endpoint in zip(resources[::2], resources[1::2], strict=True):
            self.assertEqual(service["spec"]["type"], "ClusterIP")
            self.assertNotIn("selector", service["spec"])
            self.assertEqual(endpoint["addressType"], "IPv4")
            self.assertEqual(
                endpoint["metadata"]["labels"]["kubernetes.io/service-name"],
                service["metadata"]["name"],
            )

    def test_pod_service_overlap_and_missing_ranges_are_rejected(self):
        for pod_ranges, service_ranges, subnet, succeeds in (
            (["10.244.0.0/24"], ["10.96.0.0/16"], "172.28.0.0/16", True),
            (["10.244.0.0/24"], ["10.96.0.0/16"], "10.244.0.0/16", False),
            (["10.244.0.0/24"], ["10.96.0.0/16"], "10.96.8.0/24", False),
            ([], ["10.96.0.0/16"], "172.28.0.0/16", False),
        ):
            responses = [
                json.dumps({"items": [{"spec": {"podCIDRs": pod_ranges}}]}),
                json.dumps({"items": [{"spec": {"cidrs": service_ranges}}]}),
            ]
            with (
                self.subTest(subnet=subnet),
                patch.object(bridge, "run", side_effect=responses),
            ):
                if succeeds:
                    bridge.verify_cluster_ranges(["kubectl"], {"subnets": [subnet]})
                else:
                    with self.assertRaises(ValueError):
                        bridge.verify_cluster_ranges(["kubectl"], {"subnets": [subnet]})


class BridgeConnectTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.resources = {}
        self.calls = []
        self.snapshot = {
            "networkId": "network-id",
            "nodeId": "node-id",
            "nodeConnected": False,
            "addresses": {"prefect": "172.28.0.2", "ops-artifacts": "172.28.0.3"},
            "containers": {"prefect": "prefect-id", "ops-artifacts": "artifacts-id"},
        }
        for patcher in (
            patch.object(bridge, "run", side_effect=self.execute),
            patch.object(bridge, "require_dev"),
            patch.object(bridge, "verify_cluster_ranges"),
            patch.object(
                bridge,
                "topology",
                side_effect=lambda *args: copy.deepcopy(self.snapshot),
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def execute(self, command, data=None, **kwargs):
        command = [str(value) for value in command]
        self.calls.append(command)
        self.assertEqual(kwargs["timeout"], 15 if "get" in command else 60)
        if command[:3] == ["docker", "network", "connect"]:
            self.snapshot["nodeConnected"] = True
            return ""
        self.assertIn(str(self.state / "kubeconfig"), command)
        self.assertIn("kind-govbiz-fixture", command)
        if "get" in command:
            index = command.index("get")
            if command[index + 1] == "endpointslices":
                name = command[command.index("-l") + 1].split("=", 1)[1]
                return json.dumps(
                    {
                        "items": [
                            item
                            for (kind, _), item in self.resources.items()
                            if kind == "EndpointSlice"
                            and item["metadata"]["labels"]["kubernetes.io/service-name"]
                            == name
                        ]
                    }
                )
            resource = self.resources.get(tuple(command[index + 1 : index + 3]))
            return json.dumps(resource) if resource else ""
        if "patch" in command:
            self.assertIn("--patch-file=/dev/stdin", command)
            key = ("EndpointSlice", command[command.index("patch") + 2])
            actual = self.resources[key]
            operations = json.loads(data)
            for operation in operations[:-1]:
                self.assertEqual(operation["op"], "test")
                value = actual
                for segment in operation["path"][1:].split("/"):
                    value = value[segment]
                if value != operation["value"]:
                    raise subprocess.CalledProcessError(1, "kubectl")
            self.assertEqual(operations[-1]["op"], "replace")
            self.assertEqual(operations[-1]["path"], "/endpoints")
            updated = copy.deepcopy(actual)
            updated["endpoints"] = operations[-1]["value"]
            updated["metadata"]["resourceVersion"] = str(len(self.calls))
            if "--dry-run=server" not in command:
                self.resources[key] = updated
            return json.dumps(updated)
        resource = json.loads(data)
        self.assertTrue("create" in command or "replace" in command)
        key = (resource["kind"], resource["metadata"]["name"])
        if "replace" in command:
            self.assertEqual(
                resource["metadata"]["resourceVersion"],
                self.resources[key]["metadata"]["resourceVersion"],
            )
        resource["metadata"]["resourceVersion"] = str(len(self.calls))
        if resource["kind"] == "Service":
            resource["spec"]["clusterIP"] = "10.96.0.20"
        self.resources[key] = resource
        return ""

    def test_connect_refresh_and_read_only_check(self):
        bridge.connect(self.state, SETTINGS, PROJECT)
        self.assertEqual(len(self.resources), 4)
        self.assertTrue((self.state / "ops-bridge-values.json").is_file())
        before = len(self.calls)
        bridge.connect(self.state, SETTINGS, PROJECT, check=True)
        self.assertFalse(
            any("create" in call or "replace" in call for call in self.calls[before:])
        )
        self.snapshot["addresses"]["prefect"] = "172.28.0.8"
        with self.assertRaisesRegex(ValueError, "address changed"):
            bridge.connect(self.state, SETTINGS, PROJECT, check=True)
        bridge.connect(self.state, SETTINGS, PROJECT)
        bridge.connect(self.state, SETTINGS, PROJECT, check=True)
        self.assertEqual(
            len(
                [
                    call
                    for call in self.calls
                    if call[:3] == ["docker", "network", "connect"]
                ]
            ),
            1,
        )

    def test_wrong_cluster_or_existing_resource_owner_prevents_writes(self):
        with (
            patch.object(
                bridge, "require_dev", side_effect=ValueError("wrong cluster")
            ),
            self.assertRaisesRegex(ValueError, "wrong cluster"),
        ):
            bridge.connect(self.state, SETTINGS, PROJECT)
        self.assertEqual(self.calls, [])
        resource = bridge.manifests(SETTINGS, PROJECT, self.snapshot["addresses"])[0]
        resource["metadata"]["annotations"][bridge.STATE_KEY] = "someone-else"
        self.resources[("Service", resource["metadata"]["name"])] = resource
        with self.assertRaisesRegex(ValueError, "not owned"):
            bridge.connect(self.state, SETTINGS, PROJECT)
        self.assertFalse(
            any(
                "connect" in call or "create" in call or "replace" in call
                for call in self.calls
            )
        )

    def test_gitops_check_preserves_routes_files_and_argo_ownership(self):
        bridge.connect(self.state, SETTINGS, PROJECT)
        settings = {**SETTINGS, "mode": "gitops"}
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        resources = copy.deepcopy(self.resources)
        self.calls.clear()
        with (
            patch.object(bridge, "require_dev", wraps=require_dev) as dev,
            patch.object(bridge, "verify_context") as owner,
        ):
            bridge.connect(self.state, settings, PROJECT, check=True)
        dev.assert_not_called()
        self.assertEqual(owner.call_count, 2)
        for call in owner.call_args_list:
            self.assertEqual(
                call.args, (bridge.commands(self.state, settings)[0], settings)
            )
            self.assertEqual(call.kwargs, {"timeout": 15})
        self.assertTrue(self.calls)
        self.assertTrue(all("get" in call for call in self.calls))
        self.assertEqual(resources, self.resources)
        self.assertEqual(
            before, {path.name: path.read_bytes() for path in self.state.iterdir()}
        )

    def test_gitops_check_rejects_wrong_or_changed_cluster_owner_without_writes(self):
        bridge.connect(self.state, SETTINGS, PROJECT)
        settings = {**SETTINGS, "mode": "gitops"}
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        for observations in (
            [ValueError("wrong owner")], [None, ValueError("changed owner")]
        ):
            self.calls.clear()
            with (
                patch.object(bridge, "verify_context", side_effect=observations),
                self.assertRaisesRegex(ValueError, "owner"),
            ):
                bridge.connect(self.state, settings, PROJECT, check=True)
            self.assertTrue(all("get" in call for call in self.calls))
            if len(observations) == 1:
                self.assertEqual(self.calls, [])
            self.assertEqual(
                before, {path.name: path.read_bytes() for path in self.state.iterdir()}
            )

    def test_gitops_check_still_rejects_disconnected_stale_or_foreign_routes(self):
        bridge.connect(self.state, SETTINGS, PROJECT)
        resources = copy.deepcopy(self.resources)
        snapshot = copy.deepcopy(self.snapshot)
        for failure in (
            "disconnected", "stale", "foreign", "argo_owned", "extra_slice", "replaced"
        ):
            with self.subTest(failure=failure), patch.object(bridge, "verify_context"):
                self.resources = copy.deepcopy(resources)
                self.snapshot = copy.deepcopy(snapshot)
                self.calls.clear()
                if failure == "disconnected":
                    self.snapshot["nodeConnected"] = False
                elif failure == "stale":
                    self.snapshot["addresses"]["prefect"] = "172.28.0.8"
                elif failure in {"foreign", "argo_owned"}:
                    annotations = self.resources[("Service", "ops-compose-prefect")][
                        "metadata"
                    ]["annotations"]
                    key = (
                        bridge.STATE_KEY if failure == "foreign"
                        else "argocd.argoproj.io/tracking-id"
                    )
                    annotations[key] = "other"
                elif failure == "extra_slice":
                    extra = copy.deepcopy(
                        resources[("EndpointSlice", "ops-compose-prefect")]
                    )
                    extra["metadata"]["name"] = "other"
                    self.resources[("EndpointSlice", "other")] = extra
                changed = copy.deepcopy(self.snapshot)
                if failure == "replaced":
                    changed["containers"]["prefect"] = "replacement-id"
                with (
                    patch.object(
                        bridge, "topology", side_effect=[self.snapshot, changed]
                    ),
                    self.assertRaises(ValueError),
                ):
                    bridge.connect(
                        self.state, {**SETTINGS, "mode": "gitops"}, PROJECT, check=True
                    )
                self.assertTrue(all("get" in call for call in self.calls))

    def test_gitops_writes_and_unknown_mode_checks_remain_blocked_before_reads(self):
        for mode, check in (("gitops", False), ("unknown", True), ("unknown", False)):
            with (
                self.subTest(mode=mode, check=check),
                patch.object(bridge, "require_dev", wraps=require_dev),
                patch.object(bridge, "verify_context") as owner,
                patch.object(bridge, "topology") as topology,
                self.assertRaises(ValueError),
            ):
                bridge.connect(
                    self.state, {**SETTINGS, "mode": mode}, PROJECT, check=check
                )
            owner.assert_not_called()
            topology.assert_not_called()
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.state.iterdir()), [])

    def prepare_refresh(self):
        import ops_runtime

        bridge.connect(self.state, SETTINGS, PROJECT)
        bridge.write_json(
            self.state / ops_runtime.PROFILE, ops_runtime.connection(SETTINGS, PROJECT)
        )
        for key, resource in self.resources.items():
            resource["metadata"]["uid"] = "uid-" + "-".join(key)
        self.snapshot["subnets"] = ["172.28.0.0/16"]
        self.snapshot["addresses"] = {
            "prefect": "172.28.0.8",
            "ops-artifacts": "172.28.0.9",
        }
        self.calls.clear()
        patcher = patch.object(bridge, "verify_context")
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(bridge.sys, "platform", "linux")
        patcher.start()
        self.addCleanup(patcher.stop)
        return {**SETTINGS, "mode": "gitops"}

    def real_patches(self):
        return [
            call
            for call in self.calls
            if "patch" in call and "--dry-run=server" not in call
        ]

    def test_gitops_refresh_changes_only_addresses_and_is_idempotent(self):
        settings = self.prepare_refresh()
        files = {path.name: path.read_bytes() for path in self.state.iterdir()}
        before = copy.deepcopy(self.resources)
        bridge.refresh(self.state, settings, PROJECT)
        self.assertEqual(len(self.real_patches()), 2)
        self.assertTrue(all("get" in call or "patch" in call for call in self.calls))
        for key, resource in self.resources.items():
            expected = copy.deepcopy(before[key])
            if key[0] == "EndpointSlice":
                service = "prefect" if key[1].endswith("prefect") else "ops-artifacts"
                expected["endpoints"][0]["addresses"] = [
                    self.snapshot["addresses"][service]
                ]
                expected["metadata"]["resourceVersion"] = resource["metadata"][
                    "resourceVersion"
                ]
            self.assertEqual(resource, expected)
        self.assertEqual(
            files, {path.name: path.read_bytes() for path in self.state.iterdir()}
        )
        self.calls.clear()
        bridge.refresh(self.state, settings, PROJECT)
        self.assertTrue(all("get" in call for call in self.calls))

    def test_gitops_refresh_rejects_missing_foreign_or_altered_resources_before_writes(
        self,
    ):
        settings = self.prepare_refresh()
        original = copy.deepcopy(self.resources)
        for failure in (
            "missing",
            "argo",
            "owner",
            "finalizer",
            "port",
            "multiple",
            "public",
            "deleting",
        ):
            with self.subTest(failure=failure):
                self.resources = copy.deepcopy(original)
                self.calls.clear()
                key = ("EndpointSlice", "ops-compose-artifacts")
                resource = self.resources[key]
                if failure == "missing":
                    del self.resources[key]
                elif failure == "argo":
                    resource["metadata"]["annotations"][
                        "argocd.argoproj.io/tracking-id"
                    ] = "other"
                elif failure == "owner":
                    resource["metadata"]["ownerReferences"] = [{"uid": "foreign"}]
                elif failure == "finalizer":
                    resource["metadata"]["finalizers"] = ["foreign"]
                elif failure == "port":
                    resource["ports"][0]["port"] = 9999
                elif failure == "multiple":
                    resource["endpoints"].append(
                        copy.deepcopy(resource["endpoints"][0])
                    )
                elif failure == "public":
                    resource["endpoints"][0]["addresses"] = ["8.8.8.8"]
                elif failure == "deleting":
                    resource["metadata"]["deletionTimestamp"] = "2026-10-09T00:00:00Z"
                with self.assertRaises(ValueError):
                    bridge.refresh(self.state, settings, PROJECT)
                self.assertEqual(self.real_patches(), [])

    def test_gitops_refresh_rejects_mode_record_and_disconnected_network(self):
        settings = self.prepare_refresh()
        for invalid in ({**settings, "mode": "dev"}, {**settings, "mode": "unknown"}):
            with self.assertRaises(ValueError):
                bridge.refresh(self.state, invalid, PROJECT)
        with self.assertRaisesRegex(ValueError, "records differ"):
            bridge.refresh(self.state, settings, "other-project")
        self.snapshot["nodeConnected"] = False
        with self.assertRaisesRegex(ValueError, "already connected"):
            bridge.refresh(self.state, settings, PROJECT)
        self.assertEqual(self.real_patches(), [])

    def test_gitops_refresh_dry_run_failure_prevents_all_writes(self):
        settings = self.prepare_refresh()

        def fail(command, **kwargs):
            if "--dry-run=server" in command and "ops-compose-artifacts" in command:
                raise subprocess.CalledProcessError(1, "kubectl")
            return self.execute(command, **kwargs)

        with (
            patch.object(bridge, "run", side_effect=fail),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            bridge.refresh(self.state, settings, PROJECT)
        self.assertEqual(self.real_patches(), [])

    def test_gitops_refresh_detects_container_change_before_writes(self):
        settings = self.prepare_refresh()
        changed = copy.deepcopy(self.snapshot)
        changed["containers"]["prefect"] = "replacement"
        with (
            patch.object(
                bridge, "topology", side_effect=[copy.deepcopy(self.snapshot), changed]
            ),
            self.assertRaisesRegex(ValueError, "changed during refresh"),
        ):
            bridge.refresh(self.state, settings, PROJECT)
        self.assertEqual(self.real_patches(), [])

    def test_gitops_refresh_resource_race_is_rejected_by_atomic_patch(self):
        settings = self.prepare_refresh()

        def race(command, **kwargs):
            if "patch" in command and "--dry-run=server" not in command:
                resource = self.resources[("EndpointSlice", "ops-compose-prefect")]
                resource["metadata"]["uid"] = "replacement"
            return self.execute(command, **kwargs)

        with (
            patch.object(bridge, "run", side_effect=race),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            bridge.refresh(self.state, settings, PROJECT)
        self.assertEqual(len(self.real_patches()), 1)
        self.assertEqual(
            self.resources[("EndpointSlice", "ops-compose-prefect")]["endpoints"][0][
                "addresses"
            ],
            ["172.28.0.2"],
        )

    def test_gitops_refresh_partial_failure_is_not_rolled_back_and_can_resume(self):
        settings = self.prepare_refresh()
        original = copy.deepcopy(
            self.resources[("EndpointSlice", "ops-compose-artifacts")]
        )

        def fail(command, **kwargs):
            if (
                "patch" in command
                and "--dry-run=server" not in command
                and "ops-compose-artifacts" in command
            ):
                raise subprocess.CalledProcessError(1, "kubectl")
            return self.execute(command, **kwargs)

        with (
            patch.object(bridge, "run", side_effect=fail),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            bridge.refresh(self.state, settings, PROJECT)
        self.assertEqual(
            self.resources[("EndpointSlice", "ops-compose-prefect")]["endpoints"][0][
                "addresses"
            ],
            ["172.28.0.8"],
        )
        self.assertEqual(
            self.resources[("EndpointSlice", "ops-compose-artifacts")], original
        )
        self.calls.clear()
        bridge.refresh(self.state, settings, PROJECT)
        self.assertEqual(len(self.real_patches()), 1)

    def test_extra_endpoint_slice_prevents_route_update(self):
        bridge.connect(self.state, SETTINGS, PROJECT)
        extra = copy.deepcopy(self.resources[("EndpointSlice", "ops-compose-prefect")])
        extra["metadata"]["name"] = "unrelated-backend"
        self.resources[("EndpointSlice", "unrelated-backend")] = extra
        before = len(self.calls)
        with self.assertRaisesRegex(ValueError, "Unexpected EndpointSlice"):
            bridge.connect(self.state, SETTINGS, PROJECT)
        self.assertFalse(any("replace" in call for call in self.calls[before:]))

    def test_container_change_during_connect_stops_before_kubernetes_writes(self):
        changed = {
            **self.snapshot,
            "nodeConnected": True,
            "containers": {"prefect": "new-id", "ops-artifacts": "artifacts-id"},
        }
        with (
            patch.object(
                bridge, "topology", side_effect=[copy.deepcopy(self.snapshot), changed]
            ),
            self.assertRaisesRegex(ValueError, "topology changed"),
        ):
            bridge.connect(self.state, SETTINGS, PROJECT)
        self.assertFalse(any("create" in call for call in self.calls))
        self.assertFalse((self.state / "ops-bridge-values.json").exists())

    def test_container_replacement_during_read_only_check_is_not_success(self):
        bridge.connect(self.state, SETTINGS, PROJECT)
        before = len(self.calls)
        changed = copy.deepcopy(self.snapshot)
        changed["containers"]["prefect"] = "replacement-id"
        with (
            patch.object(bridge, "topology", side_effect=[copy.deepcopy(self.snapshot), changed]),
            self.assertRaisesRegex(ValueError, "topology changed during check"),
        ):
            bridge.connect(self.state, SETTINGS, PROJECT, check=True)
        self.assertTrue(all("get" in call for call in self.calls[before:]))

    def test_cli_timeout_is_failure_without_routes_or_private_output(self):
        with (
            patch("sys.argv", [
                "ops_bridge.py", "check", "--state-dir", str(self.state),
                "--compose-project", PROJECT,
            ]),
            patch.object(bridge, "load_settings", return_value=SETTINGS),
            patch.object(
                bridge, "topology",
                side_effect=subprocess.TimeoutExpired("docker", 15, output="PRIVATE", stderr="PRIVATE"),
            ),
            patch("sys.stderr", new_callable=io.StringIO) as output,
            self.assertRaises(SystemExit) as stopped,
        ):
            bridge.main()
        self.assertEqual(stopped.exception.code, 1)
        self.assertIn("timed out", output.getvalue())
        self.assertNotIn("PRIVATE", output.getvalue())
        self.assertEqual(self.calls, [])
        self.assertEqual(self.resources, {})


class ComposeBridgeTests(unittest.TestCase):
    def setUp(self):
        path = REPOSITORY_ROOT / "infrastructure/llmops/check_artifact_compose.py"
        spec = importlib.util.spec_from_file_location("artifact_compose", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.check_compose = module.check

    def test_smoke_does_not_inherit_real_credentials_or_compose_overrides(self):
        with patch.dict(
            os.environ,
            {
                "PATH": "tool-path",
                "DOCKER_CONTEXT": "fixture-context",
                "LLMOPS_ARTIFACT_TOKEN": "real-token",
                "GOVBIZ_OPS_BRIDGE_NETWORK": "real-network",
                "COMPOSE_PROFILES": "unrelated",
            },
            clear=True,
        ):
            result = smoke_ops_bridge.compose_environment(
                {"LLMOPS_ARTIFACT_TOKEN", "GOVBIZ_OPS_BRIDGE_NETWORK"}
            )
        self.assertEqual(
            result, {"PATH": "tool-path", "DOCKER_CONTEXT": "fixture-context"}
        )

    def render_compose(self, with_bridge):
        directory = REPOSITORY_ROOT / "infrastructure/llmops"
        names = (
            "compose.yaml",
            "compose.ops.yaml",
            "compose.artifacts.yaml",
        )
        if with_bridge:
            names += ("compose.kind.yaml",)
        keys = set(
            re.findall(
                r"\$\{([A-Z][A-Z0-9_]*)",
                "\n".join(
                    (directory / name).read_text(encoding="utf-8") for name in names
                ),
            )
        )
        with tempfile.TemporaryDirectory() as temp:
            env = Path(temp) / ".env"
            env.write_text(
                "".join(
                    key + "=" + "x" * 64 + "\n"
                    for key in keys
                    if not key.startswith("GOVBIZ_OPS_BRIDGE_")
                )
                + bridge.environment(SETTINGS)
            )
            command = [
                "docker",
                "compose",
                "--project-name",
                PROJECT,
                "--env-file",
                str(env),
            ]
            for name in names:
                command += ["-f", str(directory / name)]
            config = json.loads(
                subprocess.check_output(
                    command + ["--profile", "evaluation", "config", "--format", "json"],
                    text=True,
                    env=smoke_ops_bridge.compose_environment(keys),
                )
            )
        return config

    def test_real_compose_merge_keeps_only_two_endpoints_on_private_bridge(self):
        config = self.render_compose(with_bridge=True)
        self.check_compose(config)
        for name in ("langfuse-web", "langfuse-worker"):
            for failure in ("missing_healthcheck", "disabled_healthcheck", "process_only", "missing_dependency"):
                with self.subTest(service=name, failure=failure):
                    bad = copy.deepcopy(config)
                    if failure == "missing_healthcheck":
                        bad["services"][name].pop("healthcheck")
                    elif failure == "disabled_healthcheck":
                        bad["services"][name]["healthcheck"].update(disable=True)
                    elif failure == "process_only":
                        bad["services"]["evaluation-runner"]["depends_on"][name]["condition"] = "service_started"
                    else:
                        bad["services"]["evaluation-runner"]["depends_on"].pop(name)
                    with self.assertRaises(AssertionError):
                        self.check_compose(bad)
        for mutate in (
            lambda data: data["services"]["prefect"].update(restart="no"),
            lambda data: data["services"]["prefect"].pop("healthcheck"),
            lambda data: data["services"]["prefect"]["healthcheck"].update(disable=True),
            lambda data: data["services"]["evaluation-runner"]["depends_on"]["prefect"].update(
                condition="service_started"
            ),
            lambda data: data["services"]["ops-sync"]["depends_on"]["prefect"].update(
                condition="service_started"
            ),
            lambda data: data["networks"]["ops-bridge"].update(internal=False),
            lambda data: data["services"]["evaluation-runner"]["networks"].update(
                {"ops-bridge": {}}
            ),
            lambda data: data["services"]["prefect"]["ports"][0].update(
                host_ip="0.0.0.0"
            ),
        ):
            bad = copy.deepcopy(config)
            mutate(bad)
            with self.assertRaises(AssertionError):
                self.check_compose(bad)

    def test_kind_runner_does_not_start_local_ops_bootstrap_or_database(self):
        config = self.render_compose(with_bridge=True)
        self.assertEqual(
            set(config["services"]["evaluation-runner"]["depends_on"]),
            {"prefect", "langfuse-web", "langfuse-worker"},
        )
        self.check_compose(config)

    def test_local_compose_retains_review_bootstrap_before_workers_start(self):
        config = self.render_compose(with_bridge=False)
        services = config["services"]
        for name in ("ops-service", "ops-sync", "evaluation-runner"):
            with self.subTest(service=name):
                self.assertEqual(
                    services[name]["depends_on"]["ops-bootstrap"]["condition"],
                    "service_completed_successfully",
                )
        self.assertEqual(
            services["ops-bootstrap"]["depends_on"]["ops-mysql"]["condition"],
            "service_healthy",
        )
        self.assertEqual(
            services["ops-bootstrap"]["environment"]["LLMOPS_LOCAL_SEED_ENABLED"], "true"
        )
        self.check_compose(config)

    def test_kind_preflight_rejects_direct_and_transitive_local_ops_dependencies(self):
        config = self.render_compose(with_bridge=True)
        for parent in ("evaluation-runner", "prefect", "langfuse-worker", "ops-artifacts"):
            for dependency in (
                "ops-bootstrap", "ops-mysql", "ops-service", "ops-sync", "auth-core", "auth-mysql"
            ):
                with self.subTest(parent=parent, dependency=dependency):
                    bad = copy.deepcopy(config)
                    bad["services"][parent].setdefault("depends_on", {})[dependency] = {
                        "condition": "service_started"
                    }
                    with self.assertRaisesRegex(AssertionError, "must not start local Ops"):
                        self.check_compose(bad)


if __name__ == "__main__":
    unittest.main()
