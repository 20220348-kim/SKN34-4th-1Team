"""Catalog verifier must work on Windows with a non-UTF-8 default locale."""
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
    def test_config_only_handles_korean_sources_under_cp949_without_engine(self):
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
            return subprocess.CompletedProcess(command, 0, json.dumps(model), "")

        with patch("sys.argv", ["verify-catalog-separation.py", "--config-only"]), \
                patch.object(Path, "read_text", cp949_default), \
                patch.object(checker.subprocess, "run", side_effect=compose_config) as run:
            checker.main()
        self.assertEqual(run.call_count, 2)