"""Exercise only the local K-Startup HTTP fixture, without Docker or real APIs."""

import importlib.util
import json
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlencode, urlparse
import unittest


STUB_PATH = Path(__file__).parents[1] / "stubs" / "kstartup" / "server.py"
SPEC = importlib.util.spec_from_file_location("kstartup_compose_stub", STUB_PATH)
STUB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STUB)


class KStartupStubTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), STUB.KStartupStubHandler)
        cls.worker = Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(timeout=5)

    def request(self, path):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_and_real_endpoint_are_distinct(self):
        self.assertEqual((200, {"status": "up"}), self.request("/health"))
        self.assertEqual(404, self.request("/wrong-path")[0])

    def test_fixture_preserves_numeric_source_ids_target_metadata_and_official_urls(self):
        query = urlencode(STUB.expected_query(), doseq=True)
        status, body = self.request(f"{STUB.SEARCH_PATH}?{query}")
        self.assertEqual(200, status)
        self.assertEqual(2, body["currentCount"])
        self.assertEqual(body["currentCount"], body["matchCount"])
        self.assertEqual(body["currentCount"], len(body["data"]))
        for item in body["data"]:
            self.assertNotEqual(str(item["id"]), str(item["pbanc_sn"]))
            self.assertEqual(
                [str(item["pbanc_sn"])],
                parse_qs(urlparse(item["detl_pg_url"]).query)["pbancSn"],
            )
            self.assertTrue(item["aply_trgt_ctnt"])
            self.assertTrue(item["aply_excl_trgt_ctnt"])
            for field in ("aply_trgt", "biz_enyy", "biz_trgt_age"):
                self.assertTrue(item[field])

    def test_wrong_key_duplicate_page_or_missing_scope_never_returns_fixture_or_secret(self):
        for mutation in ("key", "page", "scope"):
            with self.subTest(mutation=mutation):
                query = STUB.expected_query()
                if mutation == "key":
                    query["serviceKey"] = ["must-not-appear-in-response"]
                elif mutation == "page":
                    query["page"] = ["1", "2"]
                else:
                    del query["cond[pbanc_rcpt_bgng_dt::GTE]"]
                status, body = self.request(f"{STUB.SEARCH_PATH}?{urlencode(query, doseq=True)}")
                self.assertEqual((400, {"error": "unexpected query"}), (status, body))


if __name__ == "__main__":
    unittest.main()
