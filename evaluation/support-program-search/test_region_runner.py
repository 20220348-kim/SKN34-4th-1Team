"""Offline safety checks for the synthetic regional runner, using real SDK + MockTransport."""

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
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


RUNNER_PATH = Path(__file__).with_name("run-region-eligibility.py")
SPEC = importlib.util.spec_from_file_location("region_runner_under_test", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
sys.path.insert(0, str(runner.ROOT / "backend/ai-service"))
AI_AVAILABLE = all(importlib.util.find_spec(name) is not None for name in ("httpx2", "langchain_openai", "openai"))
SECRET = "fake-key-and-error-text-never-persist"


def response_body(output, *, usage=None):
    return {
        "id": "resp_synthetic", "created_at": 0, "error": None, "incomplete_details": None,
        "model": "gpt-5.6-luna", "object": "response", "status": "completed",
        "output": [{"id": "msg_synthetic", "role": "assistant", "status": "completed", "type": "message",
                    "content": [{"annotations": [], "text": json.dumps(output), "type": "output_text"}]}],
        "parallel_tool_calls": False, "tool_choice": "none", "tools": [],
        "usage": usage if usage is not None else {
            "input_tokens": 123, "output_tokens": 456, "total_tokens": 579,
            "input_tokens_details": {"cached_tokens": 12, "private": SECRET},
            "output_tokens_details": {"reasoning_tokens": 0, "private": SECRET}, "private": SECRET,
        },
    }


class RegionRunnerTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.output = self.directory / "new-output"
        self.fixture = runner.evaluator.replay.load_json(RUNNER_PATH.with_name("region-eligibility-fixture.json"))
        self.wires = []
        self.transports = []

    def read(self, name):
        return json.loads((self.output / name).read_text(encoding="utf-8"))

    def assert_redacted(self):
        for path in self.output.iterdir():
            self.assertNotIn(SECRET, path.read_text(encoding="utf-8"), str(path))

    def execute(self, *, failure_at=None, status=503, missing_usage=False, quality_failure=False,
                exception=False, settings=None, destination=None, double_call=False):
        import httpx2 as httpx
        import openai
        from app.support_program_ranking.agent import SupportProgramRecommendationAgent

        fixture = self.fixture
        wires = self.wires

        class TrackedTransport(httpx.MockTransport):
            closed = False

            async def aclose(self):
                self.closed = True
                await super().aclose()

        def handler(request):
            wire = json.loads(request.content)
            wires.append((wire, dict(request.extensions["timeout"])))
            index = len(wires) - 1
            if index == failure_at:
                if exception:
                    raise httpx.ConnectError(SECRET, request=request)
                return httpx.Response(status, json={"error": {"message": SECRET}})
            case = fixture["cases"][index]
            output = {"rankings": {}}
            for candidate in fixture["candidates"]:
                label = case["expected"][candidate["id"]]["eligibility"]
                if quality_failure:
                    label = "UNKNOWN"
                output["rankings"][candidate["id"]] = {
                    "semanticRelevance": 40,
                    "targetAssessment": {"eligibility": "MATCH", "evidence": [1],
                                         "explanation": "AI 분야 기업 조건을 확인했습니다."},
                    "regionAssessment": {"eligibility": label,
                                         "evidence": [] if label == "UNKNOWN" else [0],
                                         "explanation": "합성 원문의 지역 범위를 비교했습니다."},
                    "supportTypeFit": 10,
                    "recommendationReasons": ["AI 제품 사업화 비용을 지원합니다."],
                }
            return httpx.Response(200, json=response_body(output, usage={} if missing_usage else None))

        transport = TrackedTransport(handler)
        self.transports.append(transport)
        args = SimpleNamespace(execute=True, output_dir=self.output)
        environment = {"OPENAI_API_KEY": SECRET, **(settings or {})}
        if "SYSTEMROOT" in os.environ:
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        real_client = openai.AsyncOpenAI
        real_rank = SupportProgramRecommendationAgent.rank

        def create_client(**kwargs):
            self.assertEqual(0, kwargs["max_retries"])
            if destination:
                kwargs["base_url"] = destination
            return real_client(**kwargs)

        async def rank_twice(agent, request):
            await real_rank(agent, request)
            return await real_rank(agent, request)

        async def run():
            with patch.dict(os.environ, environment, clear=True), \
                    patch("openai.AsyncOpenAI", side_effect=create_client), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if double_call:
                    with patch.object(SupportProgramRecommendationAgent, "rank", rank_twice):
                        return await runner.execute(args, fixture, transport=transport)
                return await runner.execute(args, fixture, transport=transport)

        return asyncio.run(run())

    def test_default_cli_needs_no_api_key_and_never_creates_output(self):
        environment = {"PYTHONDONTWRITEBYTECODE": "1"}
        if "SYSTEMROOT" in os.environ:
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        result = subprocess.run([sys.executable, "-B", str(RUNNER_PATH), "--output-dir", str(self.output)],
                                env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(0, result.returncode, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(0, summary["actualApiCalls"])
        self.assertEqual(3, summary["maximumOpenaiCalls"])
        self.assertFalse(summary["execute"])
        self.assertFalse(self.output.exists())

    def test_direct_execute_requires_explicit_flag(self):
        with self.assertRaises(ValueError):
            asyncio.run(runner.execute(SimpleNamespace(execute=False, output_dir=self.output), self.fixture))
        self.assertFalse(self.output.exists())

    def test_four_cases_are_rejected_before_runtime_or_output(self):
        extra = copy.deepcopy(self.fixture["cases"][0])
        extra["id"] = "FOURTH_CASE"
        self.fixture["cases"].append(extra)
        with self.assertRaises(ValueError):
            asyncio.run(runner.execute(SimpleNamespace(execute=True, output_dir=self.output), self.fixture))
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_overwritten(self):
        self.output.mkdir()
        sentinel = self.output / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            asyncio.run(runner.execute(SimpleNamespace(execute=True, output_dir=self.output), self.fixture))
        self.assertEqual("keep", sentinel.read_text(encoding="utf-8"))
        self.assertEqual([sentinel], list(self.output.iterdir()))

    def test_usage_is_a_strict_nonnegative_integer_allowlist(self):
        self.assertEqual({"total_tokens": 3}, runner.allowed_usage({
            "input_tokens": True, "output_tokens": -1, "total_tokens": 3,
            "input_tokens_details": {"cached_tokens": "1"}, "private": SECRET,
        }))

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_three_real_sdk_calls_capture_all_candidates_hashes_and_safe_usage(self):
        self.assertEqual(0, self.execute())
        manifest = self.read("execution-manifest.json")
        capture = self.read("capture.json")
        usage = self.read("api-usage.json")
        self.assertEqual("passed", manifest["status"])
        self.assertEqual(3, manifest["actualCalls"])
        self.assertEqual(3, manifest["completedRankings"])
        self.assertTrue(self.read("report.json")["passed"])
        self.assertEqual("mock", capture["provenance"]["kind"])
        self.assertEqual(6, len(usage))
        for index, ((wire, timeouts), observation) in enumerate(zip(self.wires, capture["observations"], strict=True)):
            self.assertEqual(8, len(observation["output"]["rankings"]))
            self.assertLessEqual(len(observation["response"]["rankings"]), 5)
            self.assertEqual(dict.fromkeys(("connect", "read", "write", "pool"), 45), timeouts)
            self.assertEqual(runner.canonical_sha256(wire["input"]), observation["modelInputSha256"])
            self.assertEqual(runner.canonical_sha256(wire["text"]["format"]["schema"]), observation["outputSchemaSha256"])
            self.assertEqual(hashlib.sha256(next(message["content"] for message in wire["input"] if message["role"] == "system").encode("utf-8")).hexdigest(), observation["promptSha256"])
            user_data = json.loads(next(message["content"] for message in wire["input"] if message["role"] == "user"))
            self.assertIn("evidenceOptions", user_data["candidates"][0])
            for forbidden in ("expected", "requiredEvidence", "rationale", "labelProvenance"):
                self.assertNotIn(forbidden, json.dumps(user_data))
            self.assertEqual(123, usage[index * 2 + 1]["usage"]["input_tokens"])
            self.assertEqual({"cached_tokens": 12}, usage[index * 2 + 1]["usage"]["input_tokens_details"])
        self.assertTrue(self.transports[0].closed)
        self.assert_redacted()

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_followup_fixture_makes_only_two_calls_and_captures_sixteen_assessments(self):
        self.fixture = runner.evaluator.replay.load_json(
            RUNNER_PATH.with_name("region-eligibility-followup-fixture.json"),
        )
        self.assertEqual(["REGION_SEOUL", "REGION_BUSAN"], [case["id"] for case in self.fixture["cases"]])
        self.assertEqual(0, self.execute())
        manifest = self.read("execution-manifest.json")
        capture = self.read("capture.json")
        report = self.read("report.json")
        self.assertEqual(2, len(self.wires))
        self.assertEqual(2, manifest["plannedCalls"])
        self.assertEqual(2, manifest["actualCalls"])
        self.assertEqual(2, manifest["completedRankings"])
        self.assertEqual(["REGION_SEOUL", "REGION_BUSAN"], [row["caseId"] for row in capture["observations"]])
        self.assertEqual([8, 8], [len(row["output"]["rankings"]) for row in capture["observations"]])
        self.assertEqual(16, report["assessmentCount"])
        self.assertEqual(16, report["passedAssessments"])
        self.assertEqual(["request", "response", "request", "response"],
                         [entry["event"] for entry in self.read("api-usage.json")])
        self.assertTrue(self.transports[0].closed)
        self.assert_redacted()

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_ranking_override_does_not_change_the_frozen_luna_none_experiment(self):
        self.assertEqual(0, self.execute(settings={
            "OPENAI_RANKING_MODEL": "gpt-5.6-sol", "OPENAI_RANKING_REASONING_EFFORT": "low",
        }))
        manifest = self.read("execution-manifest.json")
        self.assertEqual("gpt-5.6-luna", manifest["model"])
        self.assertEqual("none", manifest["reasoningEffort"])
        self.assertEqual("gpt-5.6-luna", self.read("capture.json")["provenance"]["model"])
        self.assertEqual(3, len(self.wires))
        for payload, _ in self.wires:
            self.assertEqual("gpt-5.6-luna", payload["model"])
            self.assertEqual("none", payload["reasoning"]["effort"])
        self.assertTrue(self.transports[0].closed)
        self.assert_redacted()

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_semantic_failure_finishes_three_cases_and_returns_one(self):
        self.assertEqual(1, self.execute(quality_failure=True))
        self.assertEqual(3, len(self.wires))
        self.assertEqual("quality_failed", self.read("execution-manifest.json")["status"])
        self.assertFalse(self.read("report.json")["passed"])
        self.assertTrue(self.transports[0].closed)

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_http_failure_stops_immediately_without_retry_and_preserves_partial_capture(self):
        self.assertEqual(2, self.execute(failure_at=1))
        manifest = self.read("execution-manifest.json")
        self.assertEqual(2, len(self.wires))
        self.assertEqual(2, manifest["actualCalls"])
        self.assertEqual(1, manifest["completedRankings"])
        self.assertEqual(1, len(self.read("capture.json")["observations"]))
        self.assertEqual(503, self.read("api-usage.json")[-2]["status"])
        self.assertFalse((self.output / "report.json").exists())
        self.assertTrue(self.transports[0].closed)
        self.assert_redacted()

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_network_exception_logs_only_type_and_stops_after_one(self):
        self.assertEqual(2, self.execute(failure_at=0, exception=True))
        self.assertEqual(1, len(self.wires))
        self.assertEqual(1, self.read("execution-manifest.json")["actualCalls"])
        self.assertEqual("AgentExecutionError", self.read("execution-manifest.json")["errorType"])
        self.assertTrue(self.transports[0].closed)
        self.assert_redacted()

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_missing_usage_fails_before_second_call(self):
        self.assertEqual(2, self.execute(missing_usage=True))
        self.assertEqual(1, len(self.wires))
        self.assertEqual(0, self.read("execution-manifest.json")["completedRankings"])
        self.assertTrue(self.transports[0].closed)

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_one_case_cannot_make_a_second_upstream_request(self):
        self.assertEqual(2, self.execute(double_call=True))
        self.assertEqual(1, len(self.wires))
        self.assertEqual(1, self.read("execution-manifest.json")["actualCalls"])
        self.assertTrue(self.transports[0].closed)

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_nonofficial_environment_endpoint_is_rejected_before_client_calls(self):
        self.assertEqual(2, self.execute(settings={"OPENAI_BASE_URL": "https://unapproved.example/v1"}))
        self.assertEqual([], self.wires)
        self.assertEqual(0, self.read("execution-manifest.json")["actualCalls"])

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_request_hook_rejects_wrong_host_even_if_client_constructor_is_changed(self):
        self.assertEqual(2, self.execute(destination="https://unapproved.example/v1"))
        self.assertEqual([], self.wires)
        self.assertEqual(0, self.read("execution-manifest.json")["actualCalls"])
        self.assertTrue(self.transports[0].closed)

    @unittest.skipUnless(AI_AVAILABLE, "Requires the AI Service venv")
    def test_modified_model_and_timeouts_fail_without_api_calls(self):
        for index, setting in enumerate(({"OPENAI_MODEL": "other"}, {"LLM_RANKING_MODEL_TIMEOUT_SECONDS": "25"},
                                         {"LLM_RANKING_RUN_TIMEOUT_SECONDS": "55"})):
            self.output = self.directory / f"settings-{index}"
            self.assertEqual(2, self.execute(settings=setting))
            self.assertEqual(0, self.read("execution-manifest.json")["actualCalls"])
        self.assertEqual([], self.wires)


if __name__ == "__main__":
    unittest.main()
