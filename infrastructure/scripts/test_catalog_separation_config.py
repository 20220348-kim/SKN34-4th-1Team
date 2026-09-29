"""Catalog verification preserves UTF-8, disposable networks and offline model boundaries."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("verify_catalog", Path(__file__).with_name("verify-catalog-separation.py"))
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class CatalogSeparationEncodingTests(unittest.TestCase):
    def test_evidence_option_requires_shared_tracing_and_distinct_fresh_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            first = str(Path(directory) / "first.json")
            with patch("sys.argv", ["verify", "--config-only", "--evidence-traces-output", first]), \
                    patch.object(checker.subprocess, "run") as run:
                with self.assertRaisesRegex(AssertionError, "requires --search-traces-output"):
                    checker.main()
                run.assert_not_called()
            env = {"LANGFUSE_BASE_URL": "http://localhost:13000", "LANGFUSE_PUBLIC_KEY": "pk-test", "LANGFUSE_SECRET_KEY": "sk-test"}
            for option in ("--search-traces-output", "--assistant-traces-output"):
                args = ["verify", "--config-only", "--search-traces-output", str(Path(directory) / "search.json")]
                if option == "--assistant-traces-output":
                    args += [option, first]
                else:
                    args[-1] = first
                args += ["--evidence-traces-output", first]
                with patch("sys.argv", args), patch.dict(checker.os.environ, env), patch.object(checker.subprocess, "run") as run:
                    with self.assertRaisesRegex(AssertionError, "distinct trace"):
                        checker.main()
                    run.assert_not_called()

    def test_evidence_option_only_changes_disposable_fixture_settings(self):
        calls = []
        def render(command, **kwargs):
            values = dict(line.split("=", 1) for line in Path(command[command.index("--env-file") + 1]).read_text(encoding="utf-8").splitlines())
            overlay = json.loads(Path(command[-4]).read_text(encoding="utf-8"))
            self.assertEqual(values["LLM_MODEL_TIMEOUT_SECONDS"], "2")
            self.assertEqual(values["LLM_RUN_TIMEOUT_SECONDS"], "3")
            self.assertEqual(values["ASSISTANT_AGENT_ENABLED"], "false")
            self.assertEqual(overlay["services"]["openai-stub"]["environment"], {"CORE_TRACE_FIXTURE": "true"})
            self.assertEqual(overlay["networks"]["tracing"]["name"], "govbiz-llmops_default")
            self.assertEqual(overlay["services"]["core-service"]["extra_hosts"], {"www.bizinfo.go.kr": "127.0.0.1", "bizinfo.go.kr": "127.0.0.1"})
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, json.dumps({"services": {"catalog-service": {"environment": {
                name: "false" for name in {source + "_SYNC_ENABLED" for source in checker.SOURCES} | {"SUPPORT_PROGRAM_INDEX_ENABLED"}
            }}}}), "")

        with tempfile.TemporaryDirectory() as directory, patch.dict(checker.os.environ, {
            "LANGFUSE_BASE_URL": "http://localhost:13000", "LANGFUSE_PUBLIC_KEY": "pk-test", "LANGFUSE_SECRET_KEY": "sk-test",
        }), patch("sys.argv", ["verify", "--config-only", "--search-traces-output", directory + "/search.json",
                              "--evidence-traces-output", directory + "/evidence.json"]), \
                patch.object(checker.subprocess, "run", side_effect=render), patch.object(checker, "validate_boundaries") as validate:
            checker.main()
            self.assertTrue(validate.call_args.kwargs["search_traces"])
            self.assertTrue(validate.call_args.kwargs["evidence_traces"])
        self.assertEqual(len(calls), 2)

    def test_config_only_handles_cp949_and_keeps_tracing_boundaries(self):
        models = []
        original_read = Path.read_text
        def cp949_default(path, encoding=None, **kwargs):
            return original_read(path, encoding=encoding or "cp949", **kwargs)

        def compose_config(command, **kwargs):
            self.assertEqual(command[-3:], ["config", "--format", "json"])
            self.assertEqual(kwargs.get("encoding"), "utf-8")
            fixture = Path(command[command.index("--env-file") + 1])
            active = fixture.name == "fixture.env"
            core = {"CATALOG_PROJECTION_ENABLED": "true", "CATALOG_SERVICE_URL": "http://catalog-service:8081",
                    "CATALOG_INTERNAL_TOKEN": checker.TOKEN, "SUPPORT_PROGRAM_INDEX_ENABLED": "false"}
            catalog = {"CATALOG_INTERNAL_TOKEN": checker.TOKEN, "SUPPORT_PROGRAM_INDEX_ENABLED": str(active).lower()}
            for source in checker.SOURCES:
                core[source + "_SYNC_ENABLED"] = "false"
                catalog[source + "_SYNC_ENABLED"] = str(active).lower()
            for key in ("DATA_GO_KR_SERVICE_KEY", "KSTARTUP_API_KEY", "MSIT_API_KEY", "CNTRADE_NOTICE_API_KEY"):
                core[key] = ""
            for key in ("SPRING_DATASOURCE_URL", "SPRING_DATASOURCE_USERNAME", "SPRING_DATASOURCE_PASSWORD"):
                core[key] = "core-fixture"
                catalog[key] = "catalog-mysql:fixture"
            model = {"services": {
                "core-service": {"environment": core, "build": {"context": str(checker.ROOT / "backend/core-service")}},
                "catalog-service": {"environment": catalog, "build": {"context": str(checker.ROOT / "backend/catalog-service")}},
                "catalog-mysql": {},
            }, "volumes": {}, "networks": {}}
            models.append(model)
            return subprocess.CompletedProcess(command, 0, json.dumps(model), "")

        with patch("sys.argv", ["verify-catalog-separation.py", "--config-only"]), \
                patch.object(Path, "read_text", cp949_default), \
                patch.object(checker.subprocess, "run", side_effect=compose_config) as run:
            checker.main()
        self.assertEqual(run.call_count, 2)

        # Reuse the rendered boundary fixture to ensure the opt-in cannot expand
        # access to developer databases or the real model API.
        model = models[0]
        tracing = {"LANGFUSE_ENABLED": "true", "LANGFUSE_BASE_URL": "http://langfuse-web:3000",
                   "LANGFUSE_PUBLIC_KEY": "pk-local", "LANGFUSE_SECRET_KEY": "sk-local"}
        model["services"]["core-service"]["environment"].update(tracing)
        model["services"]["core-service"]["environment"].update({
            "CATALOG_SERVICE_URL": "http://fixture-catalog-service-1:8081",
            "AI_SERVICE_BASE_URL": "http://fixture-ai-service-1:8000",
        })
        model["services"]["core-service"]["networks"] = {"default": None, "tracing": None}
        model["services"]["ai-service"] = {
            "environment": {**tracing, "OPENAI_BASE_URL": "http://fixture-openai-stub-1:8002/v1",
                            "OPENAI_API_KEY": "catalog-verification-key-never-sent"},
            "networks": {"default": None, "tracing": None},
        }
        model["networks"] = {"tracing": {"external": True, "name": "govbiz-llmops_default"}}
        checker.validate_boundaries(model, "fixture", search_traces=True)
        model["services"]["ai-service"]["environment"].update({"LLM_MODEL_TIMEOUT_SECONDS": "2", "LLM_RUN_TIMEOUT_SECONDS": "3"})
        with self.assertRaisesRegex(AssertionError, "block official"):
            checker.validate_boundaries(model, "fixture", search_traces=True, evidence_traces=True)
        model["services"]["core-service"]["extra_hosts"] = ["www.bizinfo.go.kr=127.0.0.1", "bizinfo.go.kr=127.0.0.1"]
        checker.validate_boundaries(model, "fixture", search_traces=True, evidence_traces=True)
        model["services"]["ai-service"]["environment"]["LLM_MODEL_TIMEOUT_SECONDS"] = "25"
        with self.assertRaisesRegex(AssertionError, "timeout fixture"):
            checker.validate_boundaries(model, "fixture", search_traces=True, evidence_traces=True)
        model["services"]["core-service"]["environment"]["CATALOG_SERVICE_URL"] = "http://catalog-service:8081"
        with self.assertRaisesRegex(AssertionError, "network is not isolated"):
            checker.validate_boundaries(model, "fixture")
        model["services"]["core-service"]["environment"]["CATALOG_SERVICE_URL"] = "http://fixture-catalog-service-1:8081"
        model["networks"]["tracing"]["name"] = "developer-network"
        with self.assertRaisesRegex(AssertionError, "Only the local Langfuse"):
            checker.validate_boundaries(model, "fixture", search_traces=True)
        model["networks"]["tracing"]["name"] = "govbiz-llmops_default"
        model["services"]["catalog-mysql"]["networks"] = {"tracing": None}
        with self.assertRaisesRegex(AssertionError, "Unexpected service"):
            checker.validate_boundaries(model, "fixture", search_traces=True)
        model["services"]["catalog-mysql"].pop("networks")
        model["services"]["ai-service"]["environment"]["OPENAI_BASE_URL"] = "https://api.openai.com/v1"
        with self.assertRaisesRegex(AssertionError, "offline OpenAI"):
            checker.validate_boundaries(model, "fixture", search_traces=True)
        model["services"]["ai-service"]["environment"]["OPENAI_BASE_URL"] = "http://fixture-openai-stub-1:8002/v1"
        model["services"]["ai-service"]["environment"]["LANGFUSE_SECRET_KEY"] = "different-project"
        with self.assertRaisesRegex(AssertionError, "settings disagree"):
            checker.validate_boundaries(model, "fixture", search_traces=True)
