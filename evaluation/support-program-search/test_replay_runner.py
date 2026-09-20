"""Offline replay-runner checks; execute-path tests use the AI Service venv and MockTransport."""

import asyncio
import copy
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from evaluate import CAPTURE_SCHEMA_VERSION, eligible_catalog_fingerprint, query_set_sha256


RUNNER_PATH = Path(__file__).with_name("replay-ranking.py")
SPEC = importlib.util.spec_from_file_location("replay_runner_under_test", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
AI_DEPENDENCIES_AVAILABLE = all(
    importlib.util.find_spec(name) is not None for name in ("httpx", "fastapi", "agents", "qdrant_client")
)
SECRET_MARKER = "offline-test-key-do-not-log"


class ReplayRunnerTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.paths = {
            name: self.directory / f"{name}.json"
            for name in ("fixture", "requests", "source_capture", "export_metadata")
        }
        self.paths.update({name: self.directory / f"{name}.txt" for name in ("before_prompt", "after_prompt")})
        self.output = self.directory / "output"
        docs = [
            {"id": f"BIZINFO:TEST_{letter}", "text": f"테스트 공고 {letter}", "sortTimestamp": "2026-09-06T00:00:00"}
            for letter in "ABCDE"
        ]
        for doc in docs:
            doc["contentHash"] = hashlib.sha256(doc["text"].encode()).hexdigest()
        cases = [
            {"id": f"Q{number:02d}", "query": f"테스트 지원 질문 {number}",
             "split": "dev" if number <= 10 else "heldout", "relevantIds": []}
            for number in range(1, 17)
        ]
        catalog = {"presentProgramCount": len(docs), "eligibleProgramCount": len(docs),
                   "eligibleCatalogFingerprint": eligible_catalog_fingerprint(docs)}
        self.fixture = {
            "name": "synthetic-runner-test", "dataType": "synthetic_runner_test",
            "referenceDate": "2026-09-06", "docs": docs, "catalog": catalog, "cases": cases,
        }
        self.capture = {
            "schemaVersion": CAPTURE_SCHEMA_VERSION, "querySet": {
                "name": self.fixture["name"], "sha256": query_set_sha256(cases)},
            "capturedAt": "2026-09-06T01:00:00Z", "referenceDate": "2026-09-06",
            "acceptingOnly": True, "catalog": copy.deepcopy(catalog),
            "search": {"candidateLimit": 20, "finalResultLimit": 5,
                       "scoringVersion": "govbiz-support-program-ranking-v5"},
            "observations": [
                {**{key: case[key] for key in ("id", "query", "split")},
                 "candidateIds": [doc["id"] for doc in docs], "finalProgramIds": []}
                for case in cases
            ],
        }
        self.write_json(self.paths["fixture"], self.fixture)
        self.write_json(self.paths["source_capture"], self.capture)
        self.envelope = {
            "schemaVersion": "support-program-ranking-replay-input-v1", "referenceDate": "2026-09-06",
            "catalog": copy.deepcopy(catalog), "sourceCaptureSha256": runner.sha256_file(self.paths["source_capture"]),
            "queries": [
                {"id": case["id"], "split": case["split"], "request": {
                    "originalQuery": case["query"], "scoringVersion": "govbiz-support-program-ranking-v5", "resultLimit": 5,
                    "candidates": [
                        {"id": doc["id"], "title": doc["text"], "organization": "테스트 기관",
                         "summary": "오프라인 테스트 전용 내용", "categories": ["기술"], "regions": ["전국"],
                         "targetDescription": "중소기업", "applicationPeriod": "상시 접수", "status": "OPEN"}
                        for doc in docs
                    ],
                }} for case in cases
            ],
        }
        self.save_requests()
        self.paths["before_prompt"].write_text("before test prompt", encoding="utf-8")
        self.paths["after_prompt"].write_text("after test prompt", encoding="utf-8")

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def save_requests(self):
        self.write_json(self.paths["requests"], self.envelope)
        self.write_json(self.paths["export_metadata"], {
            "sourceHashes": {"requestFileSha256": runner.sha256_file(self.paths["requests"])}
        })

    def cli(self):
        arguments = [sys.executable, "-B", str(RUNNER_PATH)]
        for name, path in self.paths.items():
            arguments.extend(["--" + name.replace("_", "-"), str(path)])
        arguments.extend(["--output-dir", str(self.output)])
        # Exclude credentials and API settings while retaining Windows' asyncio runtime requirement.
        environment = {"PYTHONDONTWRITEBYTECODE": "1"}
        if "SYSTEMROOT" in os.environ:
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        return subprocess.run(arguments, env=environment, capture_output=True,
                              text=True, timeout=20, check=False)

    def test_dry_run_without_key_reports_32_calls_without_creating_output(self):
        result = self.cli()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual({"queryCount": 16, "maximumOpenaiCalls": 32, "embeddingCalls": 0, "execute": False},
                         json.loads(result.stdout))
        self.assertEqual("", result.stderr)
        self.assertFalse(self.output.exists())

    def test_dry_run_reads_utf8_inputs_with_a_legacy_locale(self):
        self.paths["before_prompt"].write_text("이전 안내 🔎", encoding="utf-8")
        self.paths["after_prompt"].write_text("현재 안내 🔎", encoding="utf-8")
        arguments = [str(RUNNER_PATH)]
        for name, path in self.paths.items():
            arguments.extend(["--" + name.replace("_", "-"), str(path)])
        arguments.extend(["--output-dir", str(self.output)])
        original_read = Path.read_text

        def read_with_legacy_default(path, encoding=None, **kwargs):
            return original_read(path, encoding=encoding or "cp949", **kwargs)

        output = io.StringIO()
        with patch.object(sys, "argv", arguments), patch.object(Path, "read_text", read_with_legacy_default), \
                patch.object(runner, "execute", side_effect=AssertionError("dry-run must not call a model")), \
                redirect_stdout(output):
            self.assertIsNone(runner.main())

        self.assertEqual(32, json.loads(output.getvalue())["maximumOpenaiCalls"])
        self.assertFalse(self.output.exists())

    def test_cli_rejects_partial_query_set_without_creating_output(self):
        self.envelope["queries"].pop()
        self.save_requests()
        result = self.cli()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("ValueError", result.stderr)
        self.assertEqual("", result.stdout)
        self.assertFalse(self.output.exists())

    def test_cli_rejects_reordered_queries_without_creating_output(self):
        self.envelope["queries"].reverse()
        self.save_requests()
        result = self.cli()
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(self.output.exists())

    async def execute_offline(self, *, upstream_status=200, fail_close=False,
                              ranking_timeouts=(25, 30), shared_timeouts=None,
                              responses_payload_transform=None, skip_upstream=False, settings=None):
        import httpx
        from fastapi import FastAPI
        from fastapi.responses import JSONResponse
        from app.support_program_ranking.agent import build_evidence_options
        from app.support_program_ranking.models import SupportProgramRankingRequest
        from app.support_program_ranking.prompt import SUPPORT_PROGRAM_RANKING_INSTRUCTIONS

        attempts, received_requests, closed = [], [], []

        def upstream(request):
            attempts.append(request)
            if upstream_status != 200:
                return httpx.Response(upstream_status, text=f"non-JSON upstream failure: {SECRET_MARKER}")
            return httpx.Response(200, json={
                "status": "completed", "model": "gpt-5.6-luna", "usage": {
                    "input_tokens": 11, "output_tokens": 7, "input_tokens_details": {"cached_tokens": 0},
                },
            })

        def create_offline_app(*, settings):
            app = FastAPI()
            # Both transports are local: this MockTransport and runner's ASGITransport.
            # No OpenAI client, Qdrant client, socket or database is created.
            upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))

            async def close():
                await upstream_client.aclose()
                closed.append(upstream_client)
                if fail_close:
                    raise RuntimeError(SECRET_MARKER)

            app.state.container = SimpleNamespace(
                support_program_ranking_service=SimpleNamespace(_agent=SimpleNamespace(
                    _model=SimpleNamespace(kwargs={"max_tokens": 10000}),
                    _instructions=SUPPORT_PROGRAM_RANKING_INSTRUCTIONS)),
                openai_client=SimpleNamespace(_client=upstream_client), close=close,
            )

            @app.post("/internal/v1/support-program-rankings/rank")
            async def rank(payload: dict):
                received_requests.append(copy.deepcopy(payload))
                normalized = SupportProgramRankingRequest.model_validate(payload)
                model_payload = normalized.model_dump(mode="json", by_alias=True)
                for candidate, source in zip(model_payload["candidates"], normalized.candidates, strict=True):
                    candidate["evidenceOptions"] = [
                        {"index": index, **option.model_dump()}
                        for index, option in enumerate(build_evidence_options(source))
                    ]
                # Match the Responses request boundary: instructions are separate
                # from the user input containing server-generated evidence options.
                responses_payload = {
                    "model": settings.openai_ranking_model or settings.openai_model,
                    "reasoning": {"effort": settings.openai_ranking_reasoning_effort},
                    "instructions": app.state.container.support_program_ranking_service._agent._instructions,
                    "input": [{"content": json.dumps(model_payload, ensure_ascii=False), "role": "user"}],
                    "store": False,
                }
                if responses_payload_transform is not None:
                    responses_payload = responses_payload_transform(responses_payload)
                if not skip_upstream:
                    response = await upstream_client.post("https://api.openai.com/v1/responses", json=responses_payload)
                    if response.status_code != 200:
                        return JSONResponse(status_code=503, content={"detail": "offline upstream unavailable"})
                return {"originalQuery": payload["originalQuery"], "scoringVersion": payload["scoringVersion"],
                        "rankings": []}

            return app

        args = SimpleNamespace(**self.paths, output_dir=self.output)
        prompts = {"before": "before test prompt", "after": SUPPORT_PROGRAM_RANKING_INSTRUCTIONS}
        self.execution_state = (attempts, received_requests, closed)
        environment = {"OPENAI_API_KEY": SECRET_MARKER}
        if ranking_timeouts is not None:
            environment.update(LLM_RANKING_MODEL_TIMEOUT_SECONDS=str(ranking_timeouts[0]),
                               LLM_RANKING_RUN_TIMEOUT_SECONDS=str(ranking_timeouts[1]))
        if shared_timeouts is not None:
            environment.update(LLM_MODEL_TIMEOUT_SECONDS=str(shared_timeouts[0]),
                               LLM_RUN_TIMEOUT_SECONDS=str(shared_timeouts[1]))
        environment.update(settings or {})
        with patch.dict(os.environ, environment, clear=True), \
                patch("app.main.create_app", side_effect=create_offline_app), redirect_stdout(io.StringIO()):
            await runner.execute(args, self.envelope, prompts)

    def read_usage(self):
        return [json.loads(line) for line in (self.output / "api-usage.jsonl").read_text(encoding="utf-8").splitlines()]

    def read_manifest(self):
        return json.loads((self.output / "execution-manifest.json").read_text(encoding="utf-8"))

    def assert_no_secret_in_artifacts(self):
        for path in self.output.iterdir():
            self.assertNotIn(SECRET_MARKER, path.read_text(encoding="utf-8"), str(path))

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_production_default_ranking_timeouts_are_rejected_before_creating_app_or_sending(self):
        with self.assertRaisesRegex(ValueError, "frozen 25/30 second ranking timeouts"):
            asyncio.run(self.execute_offline(ranking_timeouts=None, shared_timeouts=(25, 30)))
        self.assertFalse(self.output.exists())
        self.assertEqual(([], [], []), self.execution_state)

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_frozen_ranking_timeouts_are_independent_of_shared_timeouts_and_recorded(self):
        asyncio.run(self.execute_offline(shared_timeouts=(10, 15)))
        manifest = self.read_manifest()
        self.assertEqual("succeeded", manifest["status"])
        self.assertEqual({"model": 25.0, "agent": 30.0}, manifest["timeoutsSeconds"])
        self.assertEqual(32, manifest["actualCalls"])

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_changed_effective_ranking_model_is_rejected_before_creating_app_or_sending(self):
        for index, settings in enumerate((
                {"OPENAI_RANKING_MODEL": "gpt-5.6-sol"},
                {"OPENAI_MODEL": "gpt-5.6-sol"})):
            with self.subTest(settings=settings):
                self.output = self.directory / f"changed-model-{index}"
                with self.assertRaisesRegex(ValueError, "measured gpt-5.6-luna model"):
                    asyncio.run(self.execute_offline(settings=settings))
                self.assertFalse(self.output.exists())
                self.assertEqual(([], [], []), self.execution_state)

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_changed_ranking_reasoning_is_rejected_before_creating_app_or_sending(self):
        with self.assertRaisesRegex(ValueError, "frozen none ranking reasoning effort"):
            asyncio.run(self.execute_offline(settings={"OPENAI_RANKING_REASONING_EFFORT": "low"}))
        self.assertFalse(self.output.exists())
        self.assertEqual(([], [], []), self.execution_state)

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_explicit_frozen_ranking_settings_use_and_record_effective_model(self):
        asyncio.run(self.execute_offline(settings={
            "OPENAI_MODEL": "gpt-5.6-sol", "OPENAI_RANKING_MODEL": "gpt-5.6-luna",
            "OPENAI_RANKING_REASONING_EFFORT": "none",
        }))
        manifest = self.read_manifest()
        self.assertEqual("succeeded", manifest["status"])
        self.assertEqual("gpt-5.6-luna", manifest["model"])
        self.assertEqual("none", manifest["reasoningEffort"])
        self.assertEqual(32, manifest["actualCalls"])
        for request in self.execution_state[0]:
            payload = json.loads(request.content)
            self.assertEqual("gpt-5.6-luna", payload["model"])
            self.assertEqual("none", payload["reasoning"]["effort"])
        self.assert_no_secret_in_artifacts()

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_actual_responses_input_hash_includes_evidence_options_and_not_instructions(self):
        asyncio.run(self.execute_offline())
        results = [json.loads(line) for line in (self.output / "results.jsonl").read_text(encoding="utf-8").splitlines()]
        requests = [entry for entry in self.read_usage() if entry["event"] == "request"]
        for index, (attempt, result, usage) in enumerate(zip(self.execution_state[0], results, requests, strict=True)):
            payload = json.loads(attempt.content)
            actual_input = payload["input"]
            expected = hashlib.sha256(json.dumps(
                actual_input, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
            ).encode("utf-8")).hexdigest()
            self.assertEqual(expected, result["modelInputSha256"])
            self.assertEqual(expected, usage["modelInputSha256"])
            self.assertNotEqual(result["requestSha256"], expected)
            model_payload = json.loads(actual_input[0]["content"])
            for candidate in model_payload["candidates"]:
                self.assertEqual([
                    {"index": 0, "field": "SUMMARY", "quote": candidate["summary"]},
                    {"index": 1, "field": "TARGET_DESCRIPTION", "quote": candidate["targetDescription"]},
                ], candidate.pop("evidenceOptions"))
            without_options = [{**actual_input[0], "content": json.dumps(model_payload, ensure_ascii=False)}]
            self.assertNotEqual(expected, runner.evaluator.canonical_sha256(without_options))
            self.assertNotEqual(expected, runner.evaluator.canonical_sha256(payload))
        for path in self.output.iterdir():
            saved = path.read_text(encoding="utf-8")
            self.assertNotIn("evidenceOptions", saved)
            self.assertNotIn("오프라인 테스트 전용 내용", saved)
        self.assert_no_secret_in_artifacts()

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_missing_responses_input_is_rejected_before_upstream_without_fallback_hash(self):
        def without_input(payload):
            payload.pop("input")
            return payload

        with self.assertRaisesRegex(ValueError, "actual Responses input"):
            asyncio.run(self.execute_offline(responses_payload_transform=without_input))
        self.assertEqual([], self.execution_state[0])
        self.assertEqual("", (self.output / "results.jsonl").read_text(encoding="utf-8"))
        self.assertEqual("failed", self.read_manifest()["status"])
        self.assertEqual(0, self.read_manifest()["actualCalls"])
        self.assertEqual(["failed"], [entry["event"] for entry in self.read_usage()])
        self.assert_no_secret_in_artifacts()

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_uncaptured_model_input_does_not_fall_back_to_normalized_core_request(self):
        with self.assertRaisesRegex(ValueError, "did not capture the actual model input"):
            asyncio.run(self.execute_offline(skip_upstream=True))
        self.assertEqual([], self.execution_state[0])
        self.assertEqual("", (self.output / "results.jsonl").read_text(encoding="utf-8"))
        self.assertEqual("failed", self.read_manifest()["status"])
        self.assertEqual(0, self.read_manifest()["actualCalls"])
        self.assert_no_secret_in_artifacts()

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_non_json_upstream_failure_preserves_http_status_and_failed_manifest(self):
        with self.assertRaisesRegex(RuntimeError, "Ranking HTTP status 503"):
            asyncio.run(self.execute_offline(upstream_status=502))
        usage, manifest = self.read_usage(), self.read_manifest()
        self.assertEqual(["request", "response", "failed"], [entry["event"] for entry in usage])
        self.assertEqual(502, usage[1]["status"])
        self.assertEqual(1, usage[1]["sequence"])
        self.assertGreaterEqual(usage[1]["elapsedSeconds"], 0)
        self.assertIsNone(usage[1]["usage"])
        self.assertEqual("failed", manifest["status"])
        self.assertEqual(1, manifest["actualCalls"])
        self.assertEqual(0, manifest["completedRankings"])
        self.assertEqual(1, manifest["variants"]["before"]["httpFailures"])
        self.assertFalse(manifest["variants"]["before"]["usageComplete"])
        self.assertIsNone(manifest["variants"]["before"]["inputTokens"])
        self.assertIsNone(manifest["variants"]["before"]["outputTokens"])
        self.assertEqual(1, len(self.execution_state[0]))
        self.assertEqual(2, len(self.execution_state[2]))
        self.assert_no_secret_in_artifacts()

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_close_failures_preserve_manifest_and_all_identical_request_pairs(self):
        with self.assertRaisesRegex(RuntimeError, "Replay cleanup failed"):
            asyncio.run(self.execute_offline(fail_close=True))
        manifest, usage = self.read_manifest(), self.read_usage()
        self.assertEqual("failed", manifest["status"])
        self.assertEqual(["RuntimeError", "RuntimeError"], manifest["cleanupErrors"])
        self.assertEqual("cleanup_failed", usage[-1]["event"])
        self.assertEqual(32, manifest["plannedCalls"])
        self.assertEqual(32, manifest["actualCalls"])
        self.assertEqual(32, manifest["completedRankings"])
        self.assertEqual(10000, manifest["maxOutputTokens"])
        attempts, received, closed = self.execution_state
        self.assertEqual(32, len(attempts))
        self.assertEqual(2, len(closed))
        for index, query in enumerate(self.envelope["queries"]):
            self.assertEqual(query["request"], received[2 * index])
            self.assertEqual(received[2 * index], received[2 * index + 1])
        results = [json.loads(line) for line in (self.output / "results.jsonl").read_text(encoding="utf-8").splitlines()]
        for index in range(0, len(results), 2):
            self.assertEqual({"before", "after"}, {row["variant"] for row in results[index:index + 2]})
            self.assertEqual(results[index]["requestSha256"], results[index + 1]["requestSha256"])
            self.assertEqual(results[index]["modelInputSha256"], results[index + 1]["modelInputSha256"])
        self.assertEqual(runner.sha256_file(self.output / "results.jsonl"), manifest["resultsSha256"])
        self.assertEqual(runner.sha256_file(self.output / "api-usage.jsonl"), manifest["apiUsageSha256"])
        self.assert_no_secret_in_artifacts()

    @unittest.skipUnless(AI_DEPENDENCIES_AVAILABLE, "Execute-path tests require the AI Service venv")
    def test_legacy_scoring_requests_are_not_silently_replayed_with_v4(self):
        from pydantic import ValidationError

        for row in self.envelope["queries"]:
            row["request"]["scoringVersion"] = "govbiz-support-program-ranking-v3"
        with self.assertRaises(ValidationError):
            asyncio.run(self.execute_offline())
        self.assertFalse(self.output.exists())
        self.assertEqual([], self.execution_state[0])


if __name__ == "__main__":
    unittest.main()
