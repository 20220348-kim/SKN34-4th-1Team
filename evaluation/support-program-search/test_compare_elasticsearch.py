import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import compare_elasticsearch as experiment
from evaluate import eligible_catalog_fingerprint


class ElasticsearchComparisonTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.fixture_path = Path(self.directory.name) / "fixture.json"
        docs = [
            {"id": "BIZINFO:A", "text": "서울 창업 지원사업", "sortTimestamp": "2026-09-01"},
            {"id": "OTHER:A", "text": "부산 제조 지원사업", "sortTimestamp": "2026-09-01"},
        ]
        for doc in docs:
            doc["contentHash"] = hashlib.sha256(doc["text"].encode()).hexdigest()
        self.fixture = {
            "name": "lexical-contract-test", "dataType": "synthetic_contract_test",
            "referenceDate": "2026-09-06", "docs": docs,
            "catalog": {
                "presentProgramCount": 2, "eligibleProgramCount": 2,
                "eligibleCatalogFingerprint": eligible_catalog_fingerprint(docs),
            },
            "cases": [
                {"id": "Q1", "query": "서울에서 창업지원을", "split": "dev", "relevantIds": ["BIZINFO:A"]},
                {"id": "Q2", "query": "zzznomatch", "split": "heldout", "relevantIds": []},
                {"id": "Q3", "query": "부산", "split": "heldout", "relevantIds": None},
            ],
        }
        self.write_fixture()

    def write_fixture(self):
        self.fixture_path.write_text(json.dumps(self.fixture, ensure_ascii=False), encoding="utf-8")

    def test_endpoint_rejects_remote_credentials_and_paths(self):
        for address in (
            "https://api.openai.com", "http://localhost:19200", "http://example.com:9200",
            "http://user:password@127.0.0.1:19200", "http://127.0.0.1:19200/index",
            "http://127.0.0.1:19200?x=1", "http://127.0.0.1:19200#x", "http://127.0.0.1",
        ):
            with self.subTest(address=address), self.assertRaises(ValueError):
                experiment.LocalElasticsearch(address)
        self.assertEqual("http://127.0.0.1:19200", experiment.LocalElasticsearch("http://127.0.0.1:19200/").endpoint)

    def test_redirect_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "redirects"):
            experiment.NoRedirect().redirect_request(None, None, 302, "", {}, "http://example.com")

    def test_wrong_cluster_or_version_is_rejected_before_writes(self):
        for name, version in (("production", experiment.VERSION), (experiment.CLUSTER, "9.0.0")):
            client = experiment.LocalElasticsearch("http://127.0.0.1:19200")
            client.request = Mock(return_value={"cluster_name": name, "version": {"number": version}})
            with self.assertRaisesRegex(ValueError, "isolated"):
                client.verify_cluster()
            client.request.assert_called_once_with("GET", "/")

    def test_missing_plugin_is_rejected(self):
        client = experiment.LocalElasticsearch("http://127.0.0.1:19200")
        client.request = Mock(side_effect=[
            {"cluster_name": experiment.CLUSTER, "version": {"number": experiment.VERSION}},
            {"nodes": {"node": {"plugins": []}}},
        ])
        with self.assertRaisesRegex(ValueError, "analysis-nori"):
            client.verify_cluster()

    def test_tampered_text_is_rejected_before_client_creation(self):
        self.fixture["docs"][0]["text"] = "changed"
        self.write_fixture()
        with patch.object(experiment, "LocalElasticsearch") as client, self.assertRaisesRegex(ValueError, "contentHash"):
            experiment.run_experiment(self.fixture_path, "http://127.0.0.1:19200")
        client.assert_not_called()

    def test_count_fingerprint_and_identity_validation_are_reused(self):
        for field, value in (("eligibleProgramCount", 1), ("eligibleCatalogFingerprint", "0" * 64)):
            changed = copy.deepcopy(self.fixture)
            changed["catalog"][field] = value
            self.fixture_path.write_text(json.dumps(changed), encoding="utf-8")
            with self.subTest(field=field), self.assertRaises(ValueError):
                experiment.load_snapshot(self.fixture_path)

    def test_partial_bulk_is_not_evaluated(self):
        client = Mock()
        client.request.side_effect = [
            {"acknowledged": True, "shards_acknowledged": True},
            {"errors": True, "items": [{"create": {"status": 201}}, {"create": {"status": 400}}]},
        ]
        with self.assertRaisesRegex(ValueError, "bulk"):
            experiment.index_snapshot(client, "test", self.fixture["docs"], {})
        self.assertEqual(2, client.request.call_count)
        sent = client.request.call_args.args[2].decode().splitlines()
        self.assertEqual("BIZINFO:A", json.loads(sent[1])["id"])
        self.assertEqual("OTHER:A", json.loads(sent[3])["id"])
        self.assertNotEqual(json.loads(sent[0]), json.loads(sent[2]))

    def test_index_count_mismatch_is_rejected(self):
        client = Mock()
        healthy = {"_shards": {"total": 1, "successful": 1, "failed": 0}}
        client.request.side_effect = [
            {"acknowledged": True, "shards_acknowledged": True},
            {"errors": False, "items": [{"create": {"status": 201}}] * 2},
            healthy, {**healthy, "count": 1},
        ]
        with self.assertRaisesRegex(ValueError, "count"):
            experiment.index_snapshot(client, "test", self.fixture["docs"], {})

    def test_partial_or_timed_out_search_is_rejected(self):
        for failed, successful, timed_out in ((1, 0, False), (0, 0, False), (0, 1, True)):
            with self.subTest(failed=failed, successful=successful, timed_out=timed_out), self.assertRaises(ValueError):
                experiment.check_shards({"timed_out": timed_out, "_shards": {"failed": failed, "total": 1, "successful": successful}})

    def test_query_settings_preserve_ties_and_do_not_inject_labels(self):
        body = experiment.search_body("text.nori", "서울에서", 20)
        self.assertEqual(20, body["size"])
        self.assertEqual({"query": "서울에서", "operator": "or", "zero_terms_query": "none"}, body["query"]["match"]["text.nori"])
        self.assertEqual([{"_score": "desc"}, {"sortTimestamp": "desc"}, {"id": "asc"}], body["sort"])
        self.assertNotIn("relevantIds", json.dumps(body))

    def test_search_rejects_hash_mismatch_duplicates_and_truncation(self):
        doc = self.fixture["docs"][0]
        good_hit = {"_source": {"id": doc["id"], "contentHash": doc["contentHash"]}, "_score": 1}
        for hits, total in (([{**good_hit, "_source": {"id": doc["id"], "contentHash": "bad"}}], 1),
                            ([good_hit, good_hit], 2), ([good_hit], 2)):
            client = Mock()
            client.request.return_value = {
                "_shards": {"total": 1, "successful": 1, "failed": 0}, "took": 1,
                "hits": {"total": {"relation": "eq", "value": total}, "hits": hits},
            }
            with self.subTest(hits=hits), self.assertRaises(ValueError):
                experiment.search(client, "test", "text", "서울", 20, {doc["id"]: doc["contentHash"]})

    def test_all_questions_captured_but_unlabeled_excluded_from_metrics(self):
        results = {"Q1": ["BIZINFO:A"], "Q2": [], "Q3": ["OTHER:A"]}
        report = experiment.metrics(self.fixture, results, 20)
        self.assertEqual(1.0, report["all"]["macroRecallAtK"])
        self.assertEqual(1, report["all"]["unlabeledQueriesSkipped"])
        self.assertIsNone(report["heldout"]["macroRecallAtK"])
        del results["Q3"]
        with self.assertRaisesRegex(ValueError, "every question"):
            experiment.metrics(self.fixture, results, 20)

    @unittest.skipUnless(os.environ.get("LOCAL_ES_INTEGRATION_URL"), "Opt-in local Elasticsearch/Nori integration")
    def test_live_nori_particle_search_and_offline_recheck(self):
        report = experiment.run_experiment(self.fixture_path, os.environ["LOCAL_ES_INTEGRATION_URL"], repeats=1)
        self.assertEqual([], report["variants"]["standard_bm25"]["candidateIds"]["Q1"])
        self.assertIn("BIZINFO:A", report["variants"]["nori_bm25"]["candidateIds"]["Q1"])
        self.assertEqual([], report["variants"]["nori_bm25"]["candidateIds"]["Q2"])
        self.assertEqual(0, report["actualModelApiCalls"])
        experiment.verify_report(self.fixture_path, report)
        report["variants"]["nori_bm25"]["metrics"]["all"]["macroRecallAtK"] = 0.123
        with self.assertRaisesRegex(ValueError, "metrics"):
            experiment.verify_report(self.fixture_path, report)


if __name__ == "__main__":
    unittest.main()
