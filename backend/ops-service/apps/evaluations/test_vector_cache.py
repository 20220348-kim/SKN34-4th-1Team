"""파일 불변성, 원격 조회 실패와 접수 예산을 DB·모델 호출 없이 검증한다."""

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase, override_settings

from . import vector_cache
from .artifact_server import application
from .artifact_store import ResultsUnavailable
from .catalog import live_config
from .execution_spec import make_spec, read_release
from .test_artifact_store import TOKEN, ArtifactServerMixin


class VectorCacheTests(ArtifactServerMixin, SimpleTestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.key = "a" * 64
        self.points = [{"id": str(uuid4()), "vector": [1.0, 0.0], "payload": {"text": "한글 근거"}}]

    def test_concurrent_writers_keep_one_complete_immutable_file(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            values = list(
                pool.map(
                    lambda _: vector_cache.publish(self.root, self.key, 2, self.points), range(4)
                )
            )
        self.assertTrue(all(value == values[0] for value in values))
        changed = [{**self.points[0], "vector": [0.0, 1.0]}]
        self.assertEqual(vector_cache.publish(self.root, self.key, 2, changed), values[0])
        self.assertEqual(
            list((self.root / "vector-cache").iterdir()),
            [self.root / vector_cache.cache_name(self.key)],
        )

    def test_only_missing_file_is_a_cache_miss(self):
        self.assertIsNone(vector_cache.status(self.root, self.key)["sha256"])
        _, fingerprint = vector_cache.publish(self.root, self.key, 2, self.points)
        self.assertEqual(vector_cache.read(self.root, self.key, fingerprint)[1], fingerprint)
        target = self.root / vector_cache.cache_name(self.key)
        target.write_bytes(target.read_bytes() + b" ")
        with self.assertRaisesMessage(ValueError, "changed"):
            vector_cache.read(self.root, self.key, fingerprint)
        target.write_text('{"bad":true}')
        with self.assertRaises(ValueError):
            vector_cache.status(self.root, self.key)
        target.unlink()
        target.symlink_to(self.root / "absent")
        with self.assertRaises((ValueError, OSError)):
            vector_cache.status(self.root, self.key)
        with self.assertRaises(ValueError):
            vector_cache.status(self.root, "../secret")

    def test_http_storage_returns_only_authenticated_identity_and_fails_closed(self):
        _, fingerprint = vector_cache.publish(self.root, self.key, 2, self.points)
        url = self.serve(application(self.root, self.root, TOKEN))
        with override_settings(LLMOPS_ARTIFACT_URL=url, LLMOPS_ARTIFACT_TOKEN=TOKEN):
            self.assertEqual(vector_cache.discover(self.key), fingerprint)
            self.assertIsNone(vector_cache.discover("b" * 64))
            (self.root / vector_cache.cache_name(self.key)).write_text("broken")
            with self.assertRaises(ResultsUnavailable):
                vector_cache.discover(self.key)
        with override_settings(LLMOPS_ARTIFACT_URL=url, LLMOPS_ARTIFACT_TOKEN="wrong"):
            with self.assertRaises(ResultsUnavailable):
                vector_cache.discover("b" * 64)

    def test_warm_plan_reserves_only_question_embedding_and_answer(self):
        dataset = "rag-synthetic-multichunk-v1"
        with patch.object(vector_cache, "discover", return_value=None):
            cold = live_config(dataset)
        with patch.object(vector_cache, "discover", return_value="b" * 64):
            warm = live_config(dataset)
        self.assertEqual((cold["max_model_calls"], warm["max_model_calls"]), (8, 6))
        spec = make_spec(
            read_release(), dataset, "live", warm, "new-model-response", "rag-synthetic-capture-v1"
        )
        self.assertEqual(
            [item["kind"] for item in spec["model_operations"]], ["query_embedding", "answer"] * 3
        )
        self.assertEqual(
            warm["max_total_input_tokens"],
            sum(item["max_input_tokens"] for item in spec["model_operations"]),
        )
        self.assertLess(warm["max_total_input_tokens"], cold["max_total_input_tokens"])

    def test_malformed_remote_fingerprint_is_not_a_miss(self):
        with override_settings(LLMOPS_ARTIFACT_URL="http://artifacts", LLMOPS_ARTIFACT_TOKEN=TOKEN):
            with patch(
                "apps.evaluations.artifact_store.remote_read",
                return_value=json.dumps({"key": self.key, "sha256": 123}).encode(),
            ):
                with self.assertRaises(ValueError):
                    vector_cache.discover(self.key)
