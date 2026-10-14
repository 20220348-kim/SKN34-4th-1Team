"""Offline repair preserves unrelated configuration and never prints credentials."""

import base64
import copy
import importlib.util
import io
import json
import stat
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "eks_ops_traces", ROOT / "infrastructure/eks/ops_traces.py"
)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def application():
    patches = [
        {
            "target": {
                "kind": "Deployment",
                "name": "core-service",
                "namespace": "govbiz-msa",
            },
            "patch": '[{"op":"add","path":"/spec/replicas","value":2}]',
        }
    ]
    for (kind, name), indexes in repair.TARGETS.items():
        operations = [
            {
                "op": "add",
                "path": f"/spec/template/spec/containers/{index}/env",
                "value": [
                    {
                        "name": "DB_PASSWORD",
                        "valueFrom": {
                            "secretKeyRef": {
                                "name": "ops-runtime",
                                "key": "DB_PASSWORD",
                            }
                        },
                    },
                    {"name": "LLMOPS_LIVE_ENABLED", "value": "false"},
                    {"name": "LANGFUSE_BASE_URL", "value": "http://old-host.invalid"},
                ],
            }
            for index in indexes
        ]
        operations.append(
            {
                "op": "add",
                "path": "/spec/template/spec/nodeSelector",
                "value": {"pool": "existing"},
            }
        )
        patches.append(
            {
                "target": {"kind": kind, "name": name, "namespace": "govbiz-msa"},
                "patch": json.dumps(operations),
            }
        )
    return {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": {
            "namespace": "argocd",
            "name": "govbiz-eks",
            "resourceVersion": "10",
        },
        "spec": {
            "source": {
                "targetRevision": "approved-sha",
                "kustomize": {"patches": patches},
            }
        },
        "status": {"operationState": {"phase": "Succeeded"}},
    }


def policy():
    return {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {
            "namespace": "govbiz-observability",
            "name": "langfuse-web-ingress",
            "resourceVersion": "20",
        },
        "spec": {
            "podSelector": {"matchLabels": {"app.kubernetes.io/name": "langfuse-web"}},
            "policyTypes": ["Ingress"],
            "ingress": [
                {
                    "from": [{"podSelector": {"matchLabels": {"app": "existing"}}}],
                    "ports": [{"port": 3000, "protocol": "TCP"}],
                }
            ],
        },
    }


def secret():
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"namespace": "govbiz-msa", "name": "core-runtime"},
        "data": {
            name: base64.b64encode(value.encode()).decode()
            for name, value in {
                "LANGFUSE_PUBLIC_KEY": "pk-lf-existing",
                "LANGFUSE_SECRET_KEY": "sk-lf-existing",
                "SPRING_DATASOURCE_PASSWORD": "private-db-password",
                "ACCOUNT_JWT_SECRET": "private-jwt-key",
            }.items()
        },
    }


def apply_patch(document, operations):
    """Apply the emitted RFC 6902 test/replace/append operations to isolated fixtures."""
    result = copy.deepcopy(document)
    for operation in operations:
        parts = operation["path"].split("/")[1:]
        target = result
        for part in parts[:-1]:
            target = target[int(part)] if isinstance(target, list) else target[part]
        key = parts[-1]
        if operation["op"] == "test":
            if target[key] != operation["value"]:
                raise ValueError("resource changed")
        elif operation["op"] == "replace":
            target[key] = copy.deepcopy(operation["value"])
        elif operation["op"] == "add" and key == "-" and isinstance(target, list):
            target.append(copy.deepcopy(operation["value"]))
        else:
            raise AssertionError("Unexpected patch operation")
    return result


class OpsTraceRepairTests(unittest.TestCase):
    def test_all_four_environments_repaired_and_every_other_setting_preserved(self):
        original = application()
        untouched = copy.deepcopy(original)
        updated = apply_patch(original, repair.application_patch(original))
        self.assertEqual(original, untouched)
        before = original["spec"]["source"]["kustomize"]["patches"]
        after = updated["spec"]["source"]["kustomize"]["patches"]
        self.assertEqual(before[0], after[0])
        count = 0
        for old, new in zip(before[1:], after[1:]):
            self.assertEqual(old["target"], new["target"])
            old_ops, new_ops = json.loads(old["patch"]), json.loads(new["patch"])
            self.assertEqual(old_ops[-1], new_ops[-1])
            for old_op, new_op in zip(old_ops[:-1], new_ops[:-1]):
                self.assertEqual(old_op["path"], new_op["path"])
                self.assertEqual(new_op["value"][:2], old_op["value"][:2])
                self.assertEqual(new_op["value"][2:], repair.TRACE_ENV)
                count += 1
        self.assertEqual(count, 4)
        self.assertEqual(
            repair.application_patch(updated),
            [{"op": "test", "path": "/metadata/resourceVersion", "value": "10"}],
        )
        self.assertEqual(updated["spec"]["source"]["targetRevision"], "approved-sha")

    def test_running_argo_and_unexpected_or_ambiguous_layout_are_rejected(self):
        cases = []
        for phase in ("Running", "Terminating", "Unknown"):
            item = application()
            item["status"]["operationState"]["phase"] = phase
            cases.append(item)
        item = application()
        item["operation"] = {"sync": {}}
        cases.append(item)
        item = application()
        item["spec"]["sources"] = []
        cases.append(item)
        item = application()
        item["metadata"]["namespace"] = "other"
        cases.append(item)
        item = application()
        item["spec"]["source"]["kustomize"]["patches"].pop()
        cases.append(item)
        item = application()
        item["spec"]["source"]["kustomize"]["patches"].append(
            copy.deepcopy(item["spec"]["source"]["kustomize"]["patches"][1])
        )
        cases.append(item)
        for change in (
            "duplicate-env",
            "wrong-env-path",
            "container-replace",
            "remove-env",
            "selector",
        ):
            item = application()
            target = item["spec"]["source"]["kustomize"]["patches"][1]
            operations = json.loads(target["patch"])
            if change == "duplicate-env":
                operations[0]["value"].append(copy.deepcopy(operations[0]["value"][0]))
            if change == "wrong-env-path":
                operations[0]["path"] = "/spec/template/spec/containers/2/env"
            if change == "container-replace":
                operations.append(
                    {
                        "op": "replace",
                        "path": "/spec/template/spec/containers/0",
                        "value": {},
                    }
                )
            if change == "remove-env":
                operations[0]["op"] = "remove"
            if change == "selector":
                target["target"]["labelSelector"] = "app=ops-service"
            target["patch"] = json.dumps(operations)
            cases.append(item)
        for item in cases:
            with (
                self.subTest(item_index=cases.index(item)),
                self.assertRaises(ValueError),
            ):
                repair.application_patch(item)

    def test_version_guards_reject_concurrent_edits_and_missing_versions(self):
        for original, build in (
            (application(), repair.application_patch),
            (policy(), repair.network_policy_patch),
        ):
            operations = build(original)
            changed = copy.deepcopy(original)
            changed["metadata"]["resourceVersion"] = "newer"
            with self.assertRaises(ValueError):
                apply_patch(changed, operations)
            for version in (None, "", 12):
                changed["metadata"]["resourceVersion"] = version
                with self.subTest(version=version), self.assertRaises(ValueError):
                    build(changed)

    def test_policy_preserves_rules_and_adds_only_exact_ops_ingress_idempotently(self):
        original = policy()
        updated = apply_patch(original, repair.network_policy_patch(original))
        self.assertEqual(updated["spec"]["ingress"][:-1], original["spec"]["ingress"])
        self.assertEqual(
            updated["spec"]["ingress"][-1],
            {
                "from": [repair.OPS_PEER],
                "ports": [{"port": 3000, "protocol": "TCP"}],
            },
        )
        self.assertEqual(len(repair.network_policy_patch(updated)), 1)
        updated["spec"]["ingress"][-1]["from"][0]["podSelector"] = {
            "matchExpressions": [
                {
                    "key": "app.kubernetes.io/name",
                    "operator": "In",
                    "values": ["core-service", "ai-service", "ops-service"],
                }
            ],
        }
        self.assertEqual(len(repair.network_policy_patch(updated)), 1)
        updated["spec"]["ingress"][-1]["ports"][0]["protocol"] = "UDP"
        self.assertEqual(len(repair.network_policy_patch(updated)), 2)

    def test_policy_rejects_unexpected_scope_and_layout(self):
        for field, value in (
            ("podSelector", {}),
            ("policyTypes", ["Egress"]),
            ("ingress", {}),
        ):
            item = policy()
            item["spec"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                repair.network_policy_patch(item)
        for key in ("name", "namespace"):
            item = policy()
            item["metadata"][key] = "other"
            with self.assertRaises(ValueError):
                repair.network_policy_patch(item)

    def test_secret_contains_only_the_two_selected_keys_and_no_source_metadata(self):
        source = secret()
        source["metadata"]["resourceVersion"] = "123"
        result = repair.trace_secret(source)
        self.assertEqual(
            result["metadata"], {"namespace": "govbiz-msa", "name": "ops-langfuse"}
        )
        self.assertEqual(
            result["data"], {key: source["data"][key] for key in repair.TRACE_KEYS}
        )
        self.assertNotIn("private-db-password", json.dumps(result))
        self.assertNotIn("SPRING_DATASOURCE_PASSWORD", result["data"])

    def test_secret_rejects_invalid_keys_names_and_ambiguous_values(self):
        for value in (
            None,
            "not base64",
            "",
            *[
                base64.b64encode(value).decode()
                for value in (
                    b"",
                    b"key\n",
                    b"key:value",
                    b"key\x00",
                    b"key\x7f",
                    b"x" * 4097,
                    "한글".encode(),
                )
            ],
        ):
            source = secret()
            source["data"]["LANGFUSE_SECRET_KEY"] = value
            with (
                self.subTest(value_type=type(value).__name__),
                self.assertRaises(ValueError),
            ):
                repair.trace_secret(source)
        for field in ("name", "namespace"):
            source = secret()
            source["metadata"][field] = "other"
            with self.assertRaises(ValueError):
                repair.trace_secret(source)
        source = secret()
        source["stringData"] = {"LANGFUSE_SECRET_KEY": "other"}
        with self.assertRaises(ValueError):
            repair.trace_secret(source)

    @patch("subprocess.run", side_effect=AssertionError("offline only"))
    def test_private_files_no_overwrite_and_no_output_before_validation(self, _run):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "repair"
            invalid = secret()
            invalid["data"].pop("LANGFUSE_SECRET_KEY")
            with self.assertRaises(ValueError):
                repair.prepare(application(), policy(), invalid, output)
            self.assertFalse(output.exists())
            repair.prepare(application(), policy(), secret(), output)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {
                    "application.patch.json",
                    "network-policy.patch.json",
                    "ops-langfuse-secret.json",
                },
            )
            content = {path.name: path.read_bytes() for path in output.iterdir()}
            for path in output.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                repair.prepare(application(), policy(), secret(), output)
            self.assertEqual(
                content, {path.name: path.read_bytes() for path in output.iterdir()}
            )

    def test_cli_redacts_secret_input_and_never_applies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = []
            for flag, payload in (
                ("application", application()),
                ("network-policy", policy()),
                ("source-secret", secret()),
            ):
                filename = root / (flag + ".json")
                filename.write_text(json.dumps(payload))
                args += ["--" + flag, str(filename)]
            args += ["--output", str(root / "output")]
            stdout, stderr = io.StringIO(), io.StringIO()
            with (
                redirect_stdout(stdout),
                redirect_stderr(stderr),
                patch("subprocess.run", side_effect=AssertionError("offline only")),
            ):
                self.assertEqual(repair.main(args), 0)
                self.assertEqual(repair.main(args), 1)
            output = stdout.getvalue() + stderr.getvalue()
            for value in secret()["data"].values():
                self.assertNotIn(value, output)
            self.assertNotIn("sk-lf-existing", output)
            self.assertIn("No cluster connection or changes", output)

    def test_failed_write_leaves_no_partial_output_or_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "repair"
            with (
                patch.object(repair.json, "dump", side_effect=OSError("disk full")),
                self.assertRaises(OSError),
            ):
                repair.prepare(application(), policy(), secret(), output)
            self.assertEqual(list(output.iterdir()), [])

    def test_concurrent_output_file_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "repair"
            link = repair.os.link

            def race(source, target):
                Path(target).write_text("existing content")
                return link(source, target)

            with (
                patch.object(repair.os, "link", side_effect=race),
                self.assertRaises(FileExistsError),
            ):
                repair.prepare(application(), policy(), secret(), output)
            self.assertEqual(
                (output / "application.patch.json").read_text(), "existing content"
            )
            self.assertEqual(len(list(output.iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
