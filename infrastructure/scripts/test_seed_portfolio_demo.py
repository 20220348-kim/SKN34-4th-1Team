from datetime import date
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("portfolio_seed", Path(__file__).with_name("seed-portfolio-demo.py"))
seed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seed)


class PortfolioSeedTests(unittest.TestCase):
    def test_fixed_demo_scope_and_real_sources_never_impersonated(self):
        rows = seed.fixtures(date(2026, 9, 20))
        self.assertEqual(len(rows), 8)
        self.assertEqual({r["source"] for r in rows}, set(seed.SOURCES))
        self.assertEqual(len({r["id"] for r in rows}), 8)
        for row in rows:
            self.assertTrue(row["id"].startswith("portfolio-demo-"))
            self.assertTrue(row["title"].startswith("[데모]"))
            self.assertTrue(row["organization"].startswith("[데모]"))
            self.assertIn("실제 모집", row["summary"])
            self.assertEqual(row["end"], "2026-12-19")

    def test_catalog_seed_does_not_claim_ai_index_or_real_sync_success(self):
        sql = seed.catalog_sql(seed.fixtures(date(2026, 9, 20)))
        self.assertNotIn("'SUCCESS'", sql)
        self.assertEqual(sql.count("FALSE,'NONE'"), 4)
        self.assertIn("WHERE revision<>0", sql)
        self.assertNotRegex(sql, r"\b(DELETE|TRUNCATE|DROP|REPLACE)\b")
        self.assertEqual(sql.count("START TRANSACTION;"), 1)
        self.assertEqual(sql.count("COMMIT;"), 1)

    def test_source_links_are_provider_homepages_not_fabricated_programs(self):
        sql = seed.catalog_sql(seed.fixtures(date(2026, 9, 20)))
        for homepage in seed.SOURCE_HOME.values():
            self.assertIn(seed.text(homepage + "#govbiz-portfolio-demo"), sql)
        self.assertNotIn(seed.text("https://example.invalid/portfolio-demo/portfolio-demo-01"), sql)

    def test_accounts_are_user_only_with_no_password_overwrites(self):
        hashes = {email: "$2b$12$" + "a" * 53 for email in seed.EMAILS}
        sql = seed.core_sql(hashes)
        self.assertNotIn("ADMIN", sql)
        self.assertNotRegex(sql, r"\b(UPDATE|DELETE|REPLACE|TRUNCATE)\b")
        self.assertEqual(sql.count("INSERT INTO account("), 2)
        self.assertIn("COUNT(*)=0 FROM account", sql)
        self.assertIn("COUNT(*)=8 FROM support_program", sql)
        self.assertEqual(sql.count("COMMIT;"), 1)
        with self.assertRaises(ValueError):
            seed.core_sql({email: "plaintext" for email in seed.EMAILS})

    def test_sql_literals_are_utf8_hex_not_raw_input(self):
        self.assertNotIn("DELETE", seed.text("'; DELETE FROM account; 한글"))
        self.assertIn("USING utf8mb4", seed.text("한글"))

    def test_other_contexts_are_rejected_before_data_access(self):
        with patch.object(seed, "run", return_value=json.dumps({"clusters": [{"cluster": {"server": "https://cloud.example"}}]})):
            with self.assertRaises(ValueError):
                seed.verify_context(["kubectl"])
        config = json.dumps({"clusters": [{"cluster": {"server": "https://127.0.0.1:12345"}}]})
        with patch.object(seed, "run", side_effect=[config, json.dumps({"items": [{"metadata": {"name": "other-control-plane"}}]})]):
            with self.assertRaises(ValueError):
                seed.verify_context(["kubectl"])


if __name__ == "__main__":
    unittest.main()
