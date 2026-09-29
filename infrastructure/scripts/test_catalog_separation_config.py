"""Catalog verification preserves UTF-8, disposable networks and offline model boundaries."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("verify_catalog", Path(__file__).with_name("verify-catalog-separation.py"))
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class CatalogSeparationEncodingTests(unittest.TestCase):
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
