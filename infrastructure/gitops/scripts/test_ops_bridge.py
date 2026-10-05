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
