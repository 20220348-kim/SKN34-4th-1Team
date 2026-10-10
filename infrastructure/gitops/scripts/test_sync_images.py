import hashlib
import io
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import sync_images as sync  # Initializes the shared release-module import path.

# isort: split
import gate
import yaml
from test_promote_image import FORK, receipt, values

SHA = "c" * 40


def run():
    return {"id": 123, "head_sha": SHA, "head_branch": "main", "event": "workflow_dispatch",
            "path": ".github/workflows/msa-images.yml", "head_repository": {"full_name": FORK.repository},
            "repository": {"id": 456, "full_name": FORK.repository}, "status": "completed", "conclusion": "success"}


def artifact(service="ai-service"):
    return {"id": 789, "name": "msa-image-" + service, "expired": False, "size_in_bytes": 400,
            "workflow_run": {"id": 123, "head_sha": SHA, "head_branch": "main",
                             "head_repository_id": 456, "repository_id": 456}}


def zipped(data, filename="ai-service.json"):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(filename, json.dumps(data))
    payload = output.getvalue()
    metadata = artifact()
    metadata["digest"] = "sha256:" + hashlib.sha256(payload).hexdigest()
    return payload, metadata


def ci_results(llmops_state):
    """Serve fixture GitHub responses to the real gate used by promotion."""
    def get(path):
        if path == f"repos/{gate.UPSTREAM}":
            return {"full_name": gate.UPSTREAM, "default_branch": "main"}
        if "/git/ref/" in path:
            return {"object": {"sha": SHA}}
        if "/workflows/" in path:
            filename = path.split("/workflows/")[1].split("/")[0]
        else:
            run_id = int(path.split("/runs/")[1].split("/")[0])
            filename = list(gate.WORKFLOWS)[run_id - 100]
        run_id = 100 + list(gate.WORKFLOWS).index(filename)
        record = {**run(), "id": run_id, "run_attempt": 1, "event": "push",
                  "path": ".github/workflows/" + filename}
        if "/workflows/" in path:
            if filename == "llmops-ci.yml" and llmops_state[0] == "missing":
                return {"workflow_runs": []}
            if filename == "llmops-ci.yml" and llmops_state[0] == "failure":
                record["conclusion"] = "failure"
            return {"workflow_runs": [record]}
        if "/jobs?" in path:
            jobs = [{"name": name, "head_sha": SHA, "run_id": run_id,
                     "status": "completed", "conclusion": "success"}
                    for name in gate.WORKFLOWS[filename]]
            if filename == "llmops-ci.yml" and llmops_state[0] == "skipped":
                jobs[0]["conclusion"] = "skipped"
            return {"total_count": len(jobs), "jobs": jobs}
        return record
    return get


class SyncTests(unittest.TestCase):
    def test_web_receipt_does_not_become_a_backend_release(self):
        web = artifact("web")
        rows = [web, {"name": "msa-publication-web"}]
        def get(path):
            if "/artifacts?" in path:
                return {"artifacts": rows}
            return {"workflow_runs": [run()]} if "/workflows/" in path else run()
        self.assertIsNone(sync.select_release(FORK, get))
        with self.assertRaisesRegex(ValueError, "web image"):
            sync.select_release(FORK, get, run_id=123)
        web["workflow_run"]["repository_id"] = 999
        with self.assertRaisesRegex(ValueError, "cross-repository"):
            sync.select_release(FORK, get)

    def test_real_gate_blocks_promotion_without_successful_llmops(self):
        for state in ("failure", "missing", "skipped"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory, \
                    patch.object(sync, "select_release", return_value=(run(), [])), \
                    patch.object(sync, "checked_receipts") as receipts:
                root = Path(directory).resolve()
                decision = sync.synchronize(FORK, root=root, write=True, get=ci_results([state]))
                self.assertFalse(decision["prepared"])
                self.assertEqual(decision["reason"], "source_or_ci_not_ready")
                self.assertEqual(decision["source_sha"], SHA)
                receipts.assert_not_called()
                self.assertEqual(list(root.iterdir()), [])

    def test_llmops_changes_after_receipts_prevent_promotion_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            state = ["success"]
            def receipts(*args):
                state[0] = "failure"
                return [{**receipt(), "service": service, "repository": FORK.image(service)}
                        for service in sync.SERVICES]
            with patch.object(sync, "select_release", return_value=(run(), [])), \
                    patch.object(sync, "checked_receipts", side_effect=receipts), \
                    self.assertRaisesRegex(ValueError, "Source/CI changed"):
                sync.synchronize(FORK, root=root, write=True, get=ci_results(state))
            self.assertFalse((root / "environments/fork").exists())

    def test_record_recheck_blocks_commit_when_llmops_loses_eligibility(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            marker = root / "environments/fork/release.json"
            marker.parent.mkdir(parents=True)
            record = {"repository": FORK.repository, "branch": FORK.branch, "verifiedRevision": SHA,
                      "runId": 123, "runUrl": f"https://github.com/{FORK.repository}/actions/runs/123",
                      "images": {service: FORK.image(service) + "@" + receipt()["digest"]
                                 for service in sync.SERVICES}}
            marker.write_text(json.dumps(record))
            with patch.object(sync, "select_release") as select, \
                    self.assertRaisesRegex(ValueError, "required CI"):
                sync.verify_record(root, FORK, get=ci_results(["skipped"]))
            select.assert_not_called()
            self.assertEqual(json.loads(marker.read_text()), record)

    def test_public_batch_removes_pull_secret_but_retains_runtime_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            receipts = [{**receipt(), "schemaVersion": 2, "visibility": "public",
                         "service": service, "repository": FORK.image(service)} for service in sync.SERVICES]
            with patch.object(sync, "select_release", return_value=(run(), [])), \
                    patch.object(sync, "eligible", return_value=True), \
                    patch.object(sync, "checked_receipts", return_value=receipts):
                sync.synchronize(FORK, root=root, write=True)
            marker = json.loads((root / "environments/fork/release.json").read_text())
            self.assertEqual(marker["visibility"], "public")
            sync.validate_record(marker, FORK)
            for service in sync.SERVICES:
                new = yaml.safe_load((root / f"environments/fork/{service}.yaml").read_text())
                old = yaml.safe_load((root / f"environments/portfolio/{service}.yaml").read_text())
                self.assertEqual(new["imagePullSecrets"], [])
                self.assertEqual(new["secretName"], old["secretName"])
                self.assertEqual(new["secretKeys"], old["secretKeys"])
            self.assertEqual(sync.prepare(root, receipts, FORK), {})
            receipts[-1]["visibility"] = "private"
            with self.assertRaisesRegex(ValueError, "agree on package visibility"):
                sync.prepare(root, receipts, FORK)
            for invalid in ("", "internal", None):
                with self.assertRaises(ValueError):
                    sync.validate_record(marker | {"visibility": invalid}, FORK)

    def test_exact_receipt_and_archive_checksum(self):
        payload, metadata = zipped(receipt())
        self.assertEqual(sync.decode_receipt(payload, metadata, SHA, FORK), receipt())
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload + b"tamper", metadata, SHA, FORK)

    def test_archive_traversal_and_wrong_revision_rejected(self):
        for filename in ("../ai-service.json", "/ai-service.json", "core-service.json"):
            payload, metadata = zipped(receipt(), filename)
            with self.assertRaises(ValueError):
                sync.decode_receipt(payload, metadata, SHA, FORK)
        payload, metadata = zipped({**receipt(), "verifiedRevision": "f" * 40})
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload, metadata, SHA, FORK)

    def test_run_is_fixed_repository_branch_workflow_and_event(self):
        self.assertTrue(sync.valid_run(run(), SHA, run()["path"], {"workflow_dispatch"}, FORK))
        for changes in ({"head_branch": "feature"}, {"head_repository": {"full_name": "attacker/GovBiz"}},
                        {"event": "pull_request"}, {"conclusion": "failure"}, {"path": "fake.yml"}):
            self.assertFalse(sync.valid_run({**run(), **changes}, SHA, run()["path"], {"workflow_dispatch"}, FORK))

    def test_reports_are_never_counted_as_receipts(self):
        artifacts = [{"name": name} for name in sync.PUBLICATION_REPORTS]
        def get(path):
            return {"artifacts": artifacts} if "/artifacts?" in path else {"workflow_runs": [run()]}
        self.assertIsNone(sync.select_release(FORK, get))
        artifacts.extend(artifact(service) for service in sync.SERVICES)
        selected = sync.select_release(FORK, get)
        self.assertEqual(len(selected[1]), 4)
        artifacts.pop()
        with self.assertRaisesRegex(ValueError, "exactly four"):
            sync.select_release(FORK, get)

    def test_unknown_artifact_is_not_silently_ignored(self):
        artifacts = [artifact(service) for service in sync.SERVICES] + [{"name": "msa-publication-forged"}]
        def get(path):
            return {"artifacts": artifacts} if "/artifacts?" in path else {"workflow_runs": [run()]}
        with self.assertRaisesRegex(ValueError, "exactly four"):
            sync.select_release(FORK, get)

    def test_no_release_preserves_existing_selection_and_reports_block(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, "select_release", return_value=None), patch.object(sync, "prepare") as prepare:
            root = Path(directory)
            marker = root / "environments/fork/release.json"
            marker.parent.mkdir(parents=True)
            marker.write_text("previous selection")
            result = sync.synchronize(FORK, root=root, write=True)
            self.assertFalse(result["prepared"])
            self.assertEqual(result["reason"], "no_complete_release")
            self.assertEqual(marker.read_text(), "previous selection")
            prepare.assert_not_called()

    def test_selection_cli_outputs_prepared_or_blocked_without_guessing(self):
        decisions = [
            {"prepared": True, "reason": "prepared", "source_sha": SHA, "publisher_run_id": 123},
            {"prepared": False, "reason": "no_complete_release", "source_sha": ""},
        ]
        for decision in decisions:
            with self.subTest(decision=decision), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output.txt"
                env = {"GITHUB_REPOSITORY": FORK.repository, "GOVBIZ_RELEASE_BRANCH": FORK.branch,
                       "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/" + FORK.branch,
                       "GITHUB_OUTPUT": str(output), "MSA_PROMOTION_ENABLED": "true"}
                with patch.dict(sync.os.environ, env, clear=True), patch("sys.argv", ["sync_images.py", "--write"]), patch.object(sync, "synchronize", return_value=decision):
                    sync.main()
                recorded = dict(line.split("=", 1) for line in output.read_text().splitlines())
                self.assertEqual(recorded["prepared"], str(decision["prepared"]).lower())
                self.assertEqual(recorded["source_sha"], decision["source_sha"])
                self.assertEqual(recorded["reason"], decision["reason"])

    def test_selection_cli_error_is_not_success_and_outputs_no_permission(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output.txt"
            env = {"GITHUB_REPOSITORY": FORK.repository, "GOVBIZ_RELEASE_BRANCH": FORK.branch,
                   "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/" + FORK.branch,
                   "GITHUB_OUTPUT": str(output), "MSA_PROMOTION_ENABLED": "true"}
            with patch.dict(sync.os.environ, env, clear=True), patch("sys.argv", ["sync_images.py", "--write"]), patch.object(sync, "synchronize", side_effect=ValueError("private details")), self.assertRaises(ValueError):
                sync.main()
            text = output.read_text()
            self.assertIn("prepared=false", text)
            self.assertIn("reason=selection_error", text)
            self.assertNotIn("private details", text)

    def test_latest_failed_publish_is_not_hidden(self):
        get = lambda _: {"workflow_runs": [{**run(), "id": 124, "conclusion": "failure"}, run()]}
        self.assertIsNone(sync.select_release(FORK, get))

    def test_requires_all_four_unexpired_same_repository_artifacts(self):
        artifacts = [artifact(s) for s in sync.SERVICES]
        def get(path):
            return {"artifacts": artifacts} if "/artifacts?" in path else {"workflow_runs": [run()]}
        self.assertEqual(sync.select_release(FORK, get)[0]["id"], 123)
        for changes in ({"expired": True}, {"workflow_run": {"id": 0}}, {"size_in_bytes": 999999}):
            original = artifacts[0]
            artifacts[0] = {**original, **changes}
            with self.assertRaises(ValueError):
                sync.select_release(FORK, get)
            artifacts[0] = original
        artifacts.pop()
        with self.assertRaises(ValueError):
            sync.select_release(FORK, get)

    def test_input_tree_identity_is_verified_without_executing_source(self):
        receipts = []
        artifacts = []
        payloads = {}
        key = hashlib.sha256(f"v1\nlinux/amd64\n{'d' * 40}\n{'e' * 40}\n".encode()).hexdigest()
        for number, service in enumerate(sync.SERVICES):
            item = {**receipt(), "service": service, "repository": FORK.image(service),
                    "inputKey": key, "tag": "src-" + key}
            payload, meta = zipped(item, service + ".json")
            meta.update(name="msa-image-" + service, id=number)
            artifacts.append(meta)
            payloads[number] = payload
            receipts.append(item)
        def get(path, binary=False):
            if binary:
                return payloads[int(path.split("/")[-2])]
            return {"tree": [{"path": "backend/" + s, "sha": "d" * 40, "type": "tree"} for s in sync.SERVICES]
                    + [{"path": "infrastructure/release", "sha": "e" * 40, "type": "tree"}]}
        self.assertEqual(sync.checked_receipts(SHA, (run(), artifacts), FORK, get), receipts)

    def test_batch_preflight_never_changes_files_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "environments/portfolio"
            path.mkdir(parents=True)
            receipts = []
            for service in sync.SERVICES:
                r = {**receipt(), "service": service, "repository": FORK.image(service)}
                v = values()
                v["serviceName"] = service
                v["image"]["repository"] = r["repository"]
                (path / (service + ".yaml")).write_text(yaml.safe_dump(v))
                receipts.append(r)
            before = {p: p.read_text() for p in path.iterdir()}
            changes = sync.prepare(root, receipts, FORK)
            self.assertEqual(len(changes), 4)
            receipts[-1]["repository"] = "evil.example/image"
            with self.assertRaises(ValueError):
                sync.prepare(root, receipts, FORK)
            self.assertEqual({p: p.read_text() for p in path.iterdir()}, before)

    def test_first_verified_release_creates_only_fork_values_and_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            originals = {p.name: p.read_bytes() for p in (root / "environments/portfolio").iterdir()}
            receipts = [{**receipt(), "service": service, "repository": FORK.image(service)}
                        for service in sync.SERVICES]
            with patch.object(sync, "select_release", return_value=(run(), [])), \
                    patch.object(sync, "eligible", return_value=True), \
                    patch.object(sync, "checked_receipts", return_value=receipts):
                sync.synchronize(FORK, root=root, write=True)
            marker = json.loads((root / "environments/fork/release.json").read_text())
            self.assertEqual(sync.validate_record(marker, FORK), marker)
            self.assertEqual(marker["branch"], "main")
            for service in sync.SERVICES:
                item = yaml.safe_load((root / f"environments/fork/{service}.yaml").read_text())
                self.assertEqual(item["image"]["repository"], FORK.image(service))
                self.assertEqual(item["image"]["digest"], receipt()["digest"])
                self.assertEqual(item["imagePullSecrets"], [{"name": "ghcr-pull"}])
                self.assertFalse(item["localMode"])
            self.assertEqual({p.name: p.read_bytes() for p in (root / "environments/portfolio").iterdir()}, originals)
            self.assertEqual(sync.prepare(root, receipts, FORK), {})
            with self.assertRaises(ValueError):
                sync.validate_record(marker, type(FORK)("bob/Example"))

    def test_initial_invalid_receipt_cannot_create_partial_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            receipts = [{**receipt(), "service": service, "repository": FORK.image(service)}
                        for service in sync.SERVICES]
            receipts[-1]["repository"] = "ghcr.io/bob/example-ops-service"
            with self.assertRaises(ValueError):
                sync.prepare(root, receipts, FORK)
            self.assertFalse((root / "environments/fork").exists())

    def test_new_fork_replaces_inherited_selection_with_own_verified_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            def publish(fork):
                receipts = [{**receipt(), "service": service, "repository": fork.image(service)}
                            for service in sync.SERVICES]
                record = {**run(), "head_repository": {"full_name": fork.repository},
                          "repository": {"id": 456, "full_name": fork.repository}}
                with patch.object(sync, "select_release", return_value=(record, [])), \
                        patch.object(sync, "eligible", return_value=True), \
                        patch.object(sync, "checked_receipts", return_value=receipts):
                    sync.synchronize(fork, root=root, write=True)
            publish(FORK)
            before = {p.name: p.read_text() for p in (root / "environments/fork").iterdir()}
            bob = type(FORK)("bob/OtherProject")
            publish(bob)
            after = {p.name: p.read_text() for p in (root / "environments/fork").iterdir()}
            self.assertEqual(set(after), {s + ".yaml" for s in sync.SERVICES} | {"release.json"})
            self.assertTrue(all(before[name] != after[name] for name in after))
            self.assertNotIn("ghcr.io/alice/", "".join(after.values()))
            self.assertEqual(sync.validate_record(json.loads(after["release.json"]), bob)["repository"], bob.repository)

    def test_recheck_failure_prevents_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            receipts = [{**receipt(), "service": service, "repository": FORK.image(service)}
                        for service in sync.SERVICES]
            with patch.object(sync, "select_release", return_value=(run(), [])), \
                    patch.object(sync, "eligible", side_effect=[True, False]), \
                    patch.object(sync, "checked_receipts", return_value=receipts), self.assertRaises(ValueError):
                sync.synchronize(FORK, root=root, write=True)
            self.assertFalse((root / "environments/fork").exists())

    def test_changed_tracked_input_or_cross_owner_receipt_is_rejected(self):
        payload, metadata = zipped({**receipt(), "repository": "ghcr.io/bob/example-ai-service"})
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload, metadata, SHA, FORK)
        payload, metadata = zipped(receipt())
        def get(path, binary=False):
            return payload if binary else {"tree": [
                {"path": "infrastructure/release", "sha": "f" * 40, "type": "tree"},
                {"path": "backend/ai-service", "sha": "d" * 40, "type": "tree"}]}
        with self.assertRaises(ValueError):
            sync.checked_receipts(SHA, (run(), [metadata]), FORK, get)


class WorkflowContractTests(unittest.TestCase):
    def workflow(self, filename):
        # BaseLoader preserves the Actions YAML key "on" instead of YAML 1.1 booleans.
        path = sync.ROOT.parents[1] / ".github/workflows" / filename
        return yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)

    def test_required_jobs_match_all_workflow_definitions(self):
        for filename, required in gate.WORKFLOWS.items():
            names = []
            for job_id, job in self.workflow(filename)["jobs"].items():
                name = job.get("name", job_id)
                if "strategy" in job:
                    matrix = job["strategy"]["matrix"]
                    self.assertEqual(set(matrix), {"os"})
                    names.extend(name.replace("${{ matrix.os }}", os) for os in matrix["os"])
                else:
                    names.append(name)
            with self.subTest(workflow=filename):
                self.assertCountEqual(names, required)

    def test_results_always_run_read_only_and_selection_controls_writes(self):
        for filename, dependencies in (("msa-images.yml", ["gate", "package-preflight", "publish"]),):
            job = self.workflow(filename)["jobs"]["outcome"]
            self.assertEqual(job["needs"], dependencies)
            self.assertIn("always()", job["if"])
            self.assertEqual(job["permissions"], {"contents": "read"})
            self.assertEqual(job["steps"][0]["with"]["ref"], "${{ github.event.repository.default_branch }}")
            self.assertEqual(job["steps"][0]["with"]["persist-credentials"], "false")
        publication = self.workflow("msa-images.yml")["jobs"]["publish"]
        self.assertIn("inputs.component == 'web'", publication["strategy"]["matrix"]["service"])
        self.assertIn(json.dumps(list(sync.SERVICES), separators=(",", ":")), publication["strategy"]["matrix"]["service"])

    def test_deployment_pr_workflows_are_removed(self):
        workflows = sync.ROOT.parents[1] / ".github/workflows"
        for name in ("msa-promotion.yml", "deployment-ci.yml"):
            self.assertFalse((workflows / name).exists())
        for path in workflows.glob("*.yml"):
            workflow = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
            for job in workflow.get("jobs", {}).values():
                for step in job.get("steps", []):
                    command = step.get("run", "")
                    self.assertNotIn("deployment.py propose", command)
                    self.assertNotIn("deployment.py bootstrap", command)

    def test_every_required_push_and_completion_trigger_is_present(self):
        names = []
        for filename in gate.WORKFLOWS:
            workflow = self.workflow(filename)
            self.assertIn("push", workflow["on"])
            self.assertEqual(workflow["on"]["push"], "")
            names.append(workflow["name"])
        publisher = self.workflow("msa-images.yml")
        self.assertCountEqual(publisher["on"]["workflow_run"]["workflows"], names)
        self.assertEqual(publisher["on"]["workflow_run"]["types"], ["completed"])
        llmops = self.workflow("llmops-ci.yml")
        for filename in gate.WORKFLOWS:
            self.assertEqual(self.workflow(filename)["on"]["pull_request"], "")
        self.assertNotIn("schedule", llmops["on"])


if __name__ == "__main__":
    unittest.main()
