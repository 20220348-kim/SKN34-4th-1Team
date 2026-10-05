"""Private runtime key capture and isolated recovery with synthetic credentials only."""

import base64
import copy
import hashlib
import hmac
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ops_runtime_keys as keys

IMAGE = "sha256:" + "a" * 64
ARTIFACT = "b" * 64
RUNNER = "c" * 64
IDENTITY = "d" * 64
REQUEST = "12345678-1234-4234-8234-123456789abc"


def payload():
    return {
        "schema_version": 1,
        "image": IMAGE,
        "ops_budget_configured": True,
        "keys": {name: name + "_synthetic_" + "a" * 40 for name in keys.KEYS},
    }


def reference(name, secret):
    return {"name": name, "valueFrom": {"secretKeyRef": {"name": secret, "key": name}}}


def receipt(token, version=1, sequence=0):
    data = {"version": version, "run_id": REQUEST, "sequence": sequence, "fixture": "합성 🧪"}
    signature = hmac.new(
        token.encode(),
        f"govbiz-budget-usage-v{version}\n".encode()
        + json.dumps(data, sort_keys=True, separators=(",", ":")).encode(),
        hashlib.sha256,
    ).hexdigest()
    raw = json.dumps({"payload": data, "signature": signature}).encode()
    return {"kind": "file", "size": len(raw), "data": base64.b64encode(raw).decode()}


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.value = payload()
        values = self.value["keys"]
        self.source = {
            "namespace": "govbiz-msa",
            "compose_project": "fixture",
            "deployment_uid": "deployment",
            "deployment_version": "2",
            "pod_uid": "mysql",
            "writers": {RUNNER: {"service": "evaluation-runner", "image": IMAGE}},
        }
        self.volumes = {
            "results": {"consumers": {ARTIFACT: {"service": "ops-artifacts", "image": IMAGE}}}
        }
        self.secrets = {}
        for name, data in (
            (
                "ops-runtime",
                {
                    "DJANGO_SECRET_KEY": values["django"],
                    "DB_PASSWORD": values["database"],
                    "LLMOPS_ARTIFACT_TOKEN": values["artifact"],
                    "LLMOPS_BUDGET_TOKEN": values["budget"],
                },
            ),
            (
                "ops-mysql-runtime",
                {"MYSQL_PASSWORD": values["database"], "MYSQL_ROOT_PASSWORD": values["mysql_root"]},
            ),
        ):
            self.secrets[name] = {
                "type": "Opaque",
                "metadata": {
                    "name": name,
                    "namespace": "govbiz-msa",
                    "uid": name,
                    "resourceVersion": "1",
                },
                "data": {
                    key: base64.b64encode(value.encode()).decode() for key, value in data.items()
                },
            }
        self.deployment = {
            "metadata": {"uid": "deployment", "resourceVersion": "2"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": name,
                                "image": "fixture:old",
                                "env": [
                                    reference(key, "ops-runtime")
                                    for key in self.secrets["ops-runtime"]["data"]
                                ],
                            }
                            for name in ("ops-service", "ops-sync")
                        ]
                    }
                }
            },
        }
        self.pod = {
            "metadata": {"uid": "mysql"},
            "spec": {
                "containers": [
                    {
                        "name": "mysql",
                        "env": [
                            reference(key, "ops-mysql-runtime")
                            for key in self.secrets["ops-mysql-runtime"]["data"]
                        ],
                    }
                ]
            },
        }
        self.containers = {
            identity: {
                "Id": identity,
                "Image": IMAGE,
                "Config": {
                    "Labels": {
                        "com.docker.compose.project": "fixture",
                        "com.docker.compose.service": service,
                    },
                    "Env": [name + "=" + value],
                },
            }
            for identity, service, name, value in (
                (ARTIFACT, "ops-artifacts", "LLMOPS_ARTIFACT_TOKEN", values["artifact"]),
                (RUNNER, "evaluation-runner", "LLMOPS_BUDGET_TOKEN", values["budget"]),
            )
        }

    def capture(self):
        def read(args):
            if args[:3] == ["docker", "image", "inspect"]:
                return [{"Id": IMAGE}]
            self.assertEqual(args[:2], ["kubectl", "scoped"])
            kind, name = args[3:5]
            return (
                self.secrets[name]
                if kind == "secret"
                else self.pod
                if kind == "pod"
                else self.deployment
            )

        with (
            patch.object(keys.database, "read_json", side_effect=read),
            patch.object(
                keys.storage, "inspect", side_effect=lambda identity: self.containers[identity]
            ),
        ):
            return keys.capture(["kubectl", "scoped"], self.source, self.volumes)

    def test_only_declared_ops_keys_and_consistent_consumers_are_captured(self):
        result = self.capture()
        self.assertEqual(result["keys"], self.value["keys"])
        self.assertTrue(result["ops_budget_configured"])
        self.assertEqual(set(result["sources"]), {"ops-runtime", "ops-mysql-runtime"})

    def test_legacy_missing_ops_budget_is_recorded_without_claiming_api_configuration(self):
        del self.secrets["ops-runtime"]["data"]["LLMOPS_BUDGET_TOKEN"]
        for container in self.deployment["spec"]["template"]["spec"]["containers"]:
            container["env"] = [
                row for row in container["env"] if row["name"] != "LLMOPS_BUDGET_TOKEN"
            ]
        result = self.capture()
        self.assertFalse(result["ops_budget_configured"])
        self.assertEqual(result["keys"]["budget"], self.value["keys"]["budget"])

    def test_changed_secret_identity_or_unknown_key_is_rejected(self):
        original = copy.deepcopy(self.secrets)
        for name, field, value in (
            ("ops-runtime", "namespace", "foreign"),
            ("ops-runtime", "uid", ""),
            ("ops-mysql-runtime", "deletionTimestamp", "now"),
        ):
            self.secrets = copy.deepcopy(original)
            self.secrets[name]["metadata"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.capture()
        self.secrets = copy.deepcopy(original)
        self.secrets["ops-runtime"]["data"]["UNKNOWN_KEY"] = base64.b64encode(b"private").decode()
        with self.assertRaises(ValueError):
            self.capture()

    def test_mismatched_tokens_password_and_foreign_container_are_rejected(self):
        for identity in (ARTIFACT, RUNNER):
            old = copy.deepcopy(self.containers[identity])
            self.containers[identity]["Config"]["Env"][0] += "changed"
            with self.assertRaises(ValueError):
                self.capture()
            self.containers[identity] = old
        self.secrets["ops-mysql-runtime"]["data"]["MYSQL_PASSWORD"] = base64.b64encode(
            b"other-password"
        ).decode()
        with self.assertRaises(ValueError):
            self.capture()

    def test_inline_and_indirect_environment_or_changed_deployment_are_rejected(self):
        original = copy.deepcopy(self.deployment)
        for field, value in (
            ("env", [{"name": "DB_PASSWORD", "value": "inline"}]),
            ("envFrom", [{"secretRef": {"name": "other"}}]),
        ):
            self.deployment = copy.deepcopy(original)
            self.deployment["spec"]["template"]["spec"]["containers"][0][field] = value
            with self.assertRaises(ValueError):
                self.capture()
        self.deployment = original
        self.deployment["metadata"]["resourceVersion"] = "3"
        with self.assertRaises(ValueError):
            self.capture()


class ReceiptTests(unittest.TestCase):
    def test_both_signature_versions_are_checked_and_summary_is_not_a_receipt(self):
        token = payload()["keys"]["budget"]
        entries = {
            f"{REQUEST}/capture/usage-{version}.json": receipt(token, version, version)
            for version in (1, 2)
        }
        entries[REQUEST + "/capture/usage-summary.json"] = {}
        self.assertEqual(keys.receipt_signatures(entries, token), 2)
        self.assertEqual(keys.receipt_signatures({}, ""), 0)
        for bad in ("wrong" * 12, ""):
            with self.assertRaises(ValueError):
                keys.receipt_signatures(entries, bad)

    def test_receipt_path_identity_signature_and_duplicate_json_keys_are_rejected(self):
        token = payload()["keys"]["budget"]
        entry = receipt(token)
        for path in (
            "../capture/usage-0.json",
            f"{REQUEST}/capture/usage-01.json",
            f"{REQUEST}/capture/usage-512.json",
            f"{REQUEST}/capture/usage-1.json",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                keys.receipt_signatures({path: entry}, token)
        raw = base64.b64decode(entry["data"])
        for changed in (
            raw.replace(b'"signature": "', b'"signature": "0'),
            raw.replace(b'"version": 1', b'"version": 1, "version": 1'),
        ):
            bad = entry | {"data": base64.b64encode(changed).decode(), "size": len(changed)}
            with self.assertRaises(ValueError):
                keys.receipt_signatures({f"{REQUEST}/capture/usage-0.json": bad}, token)


class HelperTests(unittest.TestCase):
    def test_keys_use_only_private_stdin_and_cleanup_failure_blocks_success(self):
        value = payload()
        result = {
            "status": "VERIFIED",
            "django_signature_verified": True,
            "artifact_wsgi_auth_verified": True,
            "key_count": 5,
        }
        for failure in (None, "proof", "exit", "cleanup"):
            events = []

            def run(args, failure=failure, events=events, **kwargs):
                events.append((args, kwargs))
                if args[:2] == ["docker", "create"]:
                    return IDENTITY.encode()
                if args[:2] == ["docker", "start"]:
                    self.assertEqual(json.loads(kwargs["data"])["keys"], value["keys"])
                    return json.dumps({} if failure == "proof" else result).encode()
                if args[:2] == ["docker", "rm"] and failure == "cleanup":
                    raise ValueError("cleanup")
                return b""

            with (
                patch.object(keys.storage, "run", side_effect=run),
                patch.object(
                    keys.database,
                    "read_json",
                    return_value={
                        "Running": False,
                        "ExitCode": int(failure == "exit"),
                        "OOMKilled": False,
                    },
                ),
            ):
                if failure:
                    with self.assertRaises(ValueError):
                        keys.run_probe(value, "verify")
                else:
                    self.assertEqual(keys.run_probe(value, "verify"), result)
            create = next(args for args, kwargs in events if args[:2] == ["docker", "create"])
            self.assertIn("--network=none", create)
            self.assertIn("--log-driver=none", create)
            self.assertIn("--read-only", create)
            self.assertNotIn("--env", create)
            self.assertFalse(any(key in " ".join(create) for key in value["keys"].values()))
            self.assertEqual(events[-1][0], ["docker", "rm", "--force", "--volumes", IDENTITY])


@unittest.skipUnless(
    os.environ.get("OPS_RUNTIME_KEY_TEST_IMAGE"), "Explicit local Ops image required"
)
class DockerKeyTests(unittest.TestCase):
    def test_encrypted_keys_recover_django_and_artifact_auth_and_reject_changed_keys(self):
        value = payload() | {"image": os.environ["OPS_RUNTIME_KEY_TEST_IMAGE"]}
        value["proof"] = keys.run_probe(value, "capture")
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "synthetic.enc"
            encryption_key = b"b" * 64
            keys.storage.exclusive(archive, keys.storage.seal(value, encryption_key))
            raw = archive.read_bytes()
            for key in value["keys"].values():
                self.assertNotIn(key.encode(), raw)
            recovered = keys.storage.open_payload(raw, encryption_key)
            result = keys.run_probe(recovered, "verify")
            self.assertTrue(result["django_signature_verified"])
            self.assertTrue(result["artifact_wsgi_auth_verified"])
            self.assertEqual(result["key_count"], 5)
            for key in value["keys"].values():
                self.assertNotIn(key, json.dumps(result))
            recovered["keys"]["django"] += "changed"
            with self.assertRaises(ValueError):
                keys.run_probe(recovered, "verify")


if __name__ == "__main__":
    unittest.main()
