"""Synthetic credential preparation; no real Secrets, containers or model calls."""

import base64
import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import nullcontext, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evaluation_secrets as prepare
from test_ops_db_snapshot import payload as database_payload
from test_ops_runtime_keys import payload as key_payload
from test_ops_runtime_keys import reference
from test_ops_state_snapshot import fixture


class EvaluationSecretTests(unittest.TestCase):
    real_open = staticmethod(prepare.snapshot.storage.open_payload)

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.settings = {
            "mode": "gitops",
            "repository": "fixture/project",
            "stateId": "a" * 32,
            "namespace": "govbiz-msa",
            "cluster": "fixture",
        }
        self.source = {
            "repository": self.settings["repository"],
            "state_id": self.settings["stateId"],
            "namespace": self.settings["namespace"],
            "compose_project": "fixture",
            "deployment_uid": "ops-deployment",
            "writers": {
                "b" * 64: {
                    "service": "evaluation-runner",
                    "image": "sha256:" + "c" * 64,
                }
            },
        }
        self.keys = key_payload()
        stores = {}
        for kind in ("prefect", "results"):
            directory = self.root / kind
            directory.mkdir()
            stores[kind] = {
                "image": "sha256:" + "c" * 64,
                "entries": fixture(directory, kind),
            }
        self.payload = {
            "schema_version": 1,
            "scope": prepare.snapshot.SCOPE,
            "database": database_payload() | {"source": self.source},
            "runtime_keys": self.keys,
            "stores": stores,
        }
        self.report_path = self.root / "retained.json"
        self.report = {
            "archive_sha256": prepare.hashlib.sha256(b"ciphertext").hexdigest(),
            "cross_store_business_links_verified": True,
        }
        self.report_path.write_text(json.dumps(self.report))
        self.retained = {
            "namespace_uid": "evaluation-namespace",
            "workloads_absent": True,
        }
        self.connection = {"composeProject": "fixture"}
        self.ops = {
            "type": "Opaque",
            "metadata": {
                "name": "ops-runtime",
                "namespace": "govbiz-msa",
                "uid": "ops-secret",
                "resourceVersion": "1",
            },
            "data": {
                name: base64.b64encode(self.keys["keys"][key].encode()).decode()
                for name, key in (
                    ("LLMOPS_ARTIFACT_TOKEN", "artifact"),
                    ("LLMOPS_BUDGET_TOKEN", "budget"),
                )
            },
        }
        self.deployment = {
            "metadata": {
                "name": "ops-service",
                "namespace": "govbiz-msa",
                "uid": "ops-deployment",
                "resourceVersion": "1",
            },
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": name,
                                "env": [
                                    reference(key, "ops-runtime")
                                    for key in self.ops["data"]
                                ],
                            }
                            for name in ("ops-service", "ops-sync")
                        ]
                    }
                }
            },
        }
        self.env = {
            "LLMOPS_BUDGET_TOKEN": self.keys["keys"]["budget"],
            "LANGFUSE_PUBLIC_KEY": "pk-lf-" + "d" * 32,
            "LANGFUSE_SECRET_KEY": "sk-lf-" + "e" * 32,
            "OPENAI_API_KEY": "must-not-copy-openai",
            "DB_PASSWORD": "must-not-copy-db",
        }
        self.runner = {
            "Id": "b" * 64,
            "Image": "sha256:" + "c" * 64,
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "fixture",
                    "com.docker.compose.service": "evaluation-runner",
                },
                "Env": [k + "=" + v for k, v in self.env.items()],
            },
        }
        self.objects, self.calls = {}, []
        self.progress = {"creationAttempts": [], "created": []}
        self.after_create = None
        self.enterContext(
            patch.object(
                prepare.fork_cluster, "load_settings", return_value=self.settings
            )
        )
        self.enterContext(
            patch.object(
                prepare.fork_cluster, "commands", return_value=(["kubectl"], [], [])
            )
        )
        self.context = self.enterContext(
            patch.object(prepare.fork_cluster, "verify_context")
        )
        self.enterContext(
            patch.object(
                prepare.ops_runtime, "read_connection", return_value=self.connection
            )
        )
        self.inspect = self.enterContext(
            patch.object(prepare.pvc, "inspect_retained", return_value=self.retained)
        )
        self.reader = self.enterContext(
            patch.object(
                prepare.snapshot.database, "read_archive", return_value=b"ciphertext"
            )
        )
        self.key_reader = self.enterContext(
            patch.object(prepare.snapshot.storage, "key_bytes", return_value=b"a" * 64)
        )
        self.decryptor = self.enterContext(
            patch.object(
                prepare.snapshot.storage, "open_payload", return_value=self.payload
            )
        )
        self.enterContext(
            patch.object(
                prepare.snapshot.storage,
                "inspect",
                side_effect=lambda identity: copy.deepcopy(self.runner),
            )
        )
        self.enterContext(
            patch.object(prepare.pvc, "run", side_effect=self.run_command)
        )

    def run_command(self, args, *, value=None, **kwargs):
        self.calls.append((args, copy.deepcopy(value)))
        if "get" in args:
            if "deployment" in args:
                return copy.deepcopy(self.deployment)
            if "ops-runtime" in args:
                return copy.deepcopy(self.ops)
            return copy.deepcopy(self.objects.get(args[args.index("secret") + 1]))
        self.assertIn("create", args)
        self.assertEqual(args[-4:], ["-f", "-", "-o", "json"])
        item = copy.deepcopy(value)
        name = item["metadata"]["name"]
        self.assertNotIn(name, self.objects)
        item["metadata"].update(uid="uid-" + name, resourceVersion="1")
        self.objects[name] = item
        if self.after_create:
            self.after_create(item)
        return copy.deepcopy(item)

    def prepare(self, create=False):
        return prepare.prepare(
            self.root,
            "archive",
            "key",
            self.report_path,
            create=create,
            progress=self.progress,
        )

    def writes(self):
        return [value for args, value in self.calls if "create" in args]

    def test_check_is_read_only_and_create_transfers_only_four_keys_via_stdin(self):
        checked = self.prepare()
        self.assertEqual(checked["status"], "VERIFIED_NOT_CREATED")
        self.assertEqual(self.writes(), [])
        result = self.prepare(create=True)
        self.assertEqual(result["status"], "PREPARED_NOT_ACTIVATED")
        self.assertEqual(result["missingSecrets"], [])
        self.assertEqual(set(self.objects), {"llmops-artifacts", "llmops-runner"})
        self.assertEqual(
            set(self.objects["llmops-runner"]["data"]),
            {"LLMOPS_BUDGET_TOKEN", *prepare.LANGFUSE_KEYS},
        )
        self.assertEqual(
            set(self.objects["llmops-artifacts"]["data"]), {"LLMOPS_ARTIFACT_TOKEN"}
        )
        for item in self.objects.values():
            self.assertTrue(item["immutable"])
            self.assertNotIn("ownerReferences", item["metadata"])
            self.assertEqual(item["metadata"]["namespace"], prepare.NAMESPACE)
        public = json.dumps(result) + json.dumps([args for args, _ in self.calls])
        for value in [*self.keys["keys"].values(), *self.env.values()]:
            self.assertNotIn(value, public)
            self.assertNotIn(base64.b64encode(value.encode()).decode(), public)
        for field in (
            "runtimeStarted",
            "sourceQuiescenceVerified",
            "archiveFreshnessVerified",
            "langfuseAuthenticationVerified",
        ):
            self.assertFalse(result[field])

    def test_rerun_reuses_exact_secret_identities_without_overwrite(self):
        self.prepare(create=True)
        before = copy.deepcopy(self.objects)
        self.calls.clear()
        self.progress = {"creationAttempts": [], "created": []}
        result = self.prepare(create=True)
        self.assertEqual(self.objects, before)
        self.assertEqual(self.writes(), [])
        self.assertFalse(result["clusterChanged"])

    def test_archive_binding_authentication_and_missing_keys_fail_before_kubernetes(
        self,
    ):
        for defect in ("hash", "auth", "source", "keys"):
            with self.subTest(defect=defect):
                payload = copy.deepcopy(self.payload)
                report = dict(self.report)
                if defect == "hash":
                    report["archive_sha256"] = "f" * 64
                if defect == "source":
                    payload["database"]["source"]["state_id"] = "foreign"
                if defect == "keys":
                    payload.pop("runtime_keys")
                self.report_path.write_text(json.dumps(report))
                self.decryptor.return_value = payload
                self.decryptor.side_effect = (
                    ValueError("private auth failure") if defect == "auth" else None
                )
                with self.assertRaises((ValueError, KeyError)):
                    self.prepare(create=True)
                self.context.assert_not_called()
                self.assertEqual(self.writes(), [])

    def test_ops_token_reference_runner_identity_and_duplicate_env_fail_before_write(
        self,
    ):
        originals = copy.deepcopy((self.ops, self.deployment, self.runner))
        for defect in (
            "artifact",
            "budget",
            "reference",
            "runner",
            "duplicate",
            "langfuse",
        ):
            self.ops, self.deployment, self.runner = copy.deepcopy(originals)
            if defect in ("artifact", "budget"):
                self.ops["data"]["LLMOPS_" + defect.upper() + "_TOKEN"] = (
                    base64.b64encode(b"wrong-token").decode()
                )
            elif defect == "reference":
                self.deployment["spec"]["template"]["spec"]["containers"][0]["env"] = []
            elif defect == "runner":
                self.runner["Config"]["Labels"]["com.docker.compose.project"] = "other"
            elif defect == "duplicate":
                self.runner["Config"]["Env"].append(self.runner["Config"]["Env"][0])
            else:
                self.runner["Config"]["Env"] = [
                    row
                    for row in self.runner["Config"]["Env"]
                    if not row.startswith("LANGFUSE_SECRET_KEY=")
                ]
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.prepare(create=True)
            self.assertEqual(self.writes(), [])

    def test_unconfigured_ops_budget_does_not_rotate_or_enable_it(self):
        self.keys["ops_budget_configured"] = False
        self.ops["data"].pop("LLMOPS_BUDGET_TOKEN")
        for container in self.deployment["spec"]["template"]["spec"]["containers"]:
            container["env"] = [reference("LLMOPS_ARTIFACT_TOKEN", "ops-runtime")]
        self.prepare(create=True)
        self.assertNotIn("LLMOPS_BUDGET_TOKEN", self.ops["data"])
        self.assertEqual(
            base64.b64decode(
                self.objects["llmops-runner"]["data"]["LLMOPS_BUDGET_TOKEN"]
            ).decode(),
            self.keys["keys"]["budget"],
        )

    def test_existing_conflict_blocks_both_creates(self):
        self.prepare(create=True)
        self.objects.pop("llmops-artifacts")
        self.objects["llmops-runner"]["data"]["LANGFUSE_SECRET_KEY"] = "changed"
        self.calls.clear()
        with self.assertRaises(ValueError):
            self.prepare(create=True)
        self.assertEqual(self.writes(), [])

    def test_response_loss_retains_object_and_retries_without_secret_output(self):
        def fail(item):
            raise TimeoutError("private token")

        self.after_create = fail
        with self.assertRaises(TimeoutError):
            self.prepare(create=True)
        self.assertEqual(
            self.progress, {"creationAttempts": ["llmops-artifacts"], "created": []}
        )
        self.after_create = None
        self.calls.clear()
        self.progress = {"creationAttempts": [], "created": []}
        self.prepare(create=True)
        self.assertEqual(len(self.writes()), 1)

    def test_source_or_retained_storage_change_stops_between_secrets(self):
        for defect in ("secret", "storage"):
            self.objects.clear()
            self.calls.clear()
            self.progress = {"creationAttempts": [], "created": []}
            self.ops["metadata"]["resourceVersion"] = "1"
            self.inspect.side_effect = None

            def mutate(item, defect=defect):
                if defect == "secret":
                    self.ops["metadata"]["resourceVersion"] = "2"
                else:
                    self.inspect.side_effect = ValueError("new writer or replaced PVC")

            self.after_create = mutate
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.prepare(create=True)
            self.assertEqual(len(self.writes()), 1)
            self.assertEqual(len(self.objects), 1)

    @unittest.skipUnless(os.name == "posix", "Encrypted archive CLI is WSL/Linux only")
    def test_cli_uncertain_mutation_redacts_all_private_error_text(self):
        output = io.StringIO()

        def fail(*args, progress, **kwargs):
            progress["creationAttempts"].append("llmops-artifacts")
            raise ValueError("private SQL Langfuse token")

        with (
            patch(
                "sys.argv",
                [
                    "evaluation_secrets.py",
                    "--archive",
                    "a",
                    "--key-file",
                    "k",
                    "--restore-report",
                    "r",
                    "--create",
                ],
            ),
            patch.object(prepare.fork_cluster, "locked", return_value=nullcontext()),
            patch.object(prepare, "prepare", side_effect=fail),
            redirect_stdout(output),
        ):
            self.assertEqual(prepare.main(), 1)
        self.assertNotIn("private", output.getvalue())
        self.assertIsNone(json.loads(output.getvalue())["clusterChanged"])

    @unittest.skipUnless(
        os.name == "posix", "Real authenticated encryption uses POSIX OpenSSL pipes"
    )
    def test_real_ciphertext_round_trip_and_tampering_never_creates_secrets(self):
        # Exercise the real authenticated decryption while the cluster remains fake.
        self.decryptor.side_effect = self.real_open
        encrypted = prepare.snapshot.storage.seal(self.payload, b"a" * 64)
        self.reader.return_value = encrypted
        self.report["archive_sha256"] = prepare.hashlib.sha256(encrypted).hexdigest()
        self.report_path.write_text(json.dumps(self.report))
        self.assertEqual(self.prepare()["status"], "VERIFIED_NOT_CREATED")
        changed = encrypted[:-1] + bytes([encrypted[-1] ^ 1])
        self.reader.return_value = changed
        self.report["archive_sha256"] = prepare.hashlib.sha256(changed).hexdigest()
        self.report_path.write_text(json.dumps(self.report))
        with self.assertRaises(ValueError):
            self.prepare(create=True)
        self.assertEqual(self.writes(), [])


if __name__ == "__main__":
    unittest.main()
