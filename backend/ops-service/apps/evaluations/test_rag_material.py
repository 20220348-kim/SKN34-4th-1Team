"""DB·모델 호출 없이 관리자 RAG 자료 조회와 해시·보고서 경계를 검증한다."""

import json
from copy import deepcopy
from hashlib import sha256
from unittest.mock import patch
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import get_user_model
from django.http import Http404
from django.test import SimpleTestCase
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .catalog import selection
from .execution_spec import digest, make_spec, read_release
from .models import EvaluationRun
from .rag_material import read_material
from .services import ResultsUnavailable

DATASET = "rag-synthetic-multichunk-v1"
CAPTURE = "rag-synthetic-capture-v1"


class RagMaterialTests(SimpleTestCase):
    def setUp(self):
        spec = make_spec(read_release(), DATASET, "replay", {}, CAPTURE, CAPTURE)
        self.run = EvaluationRun(
            id=uuid4(),
            status="COMPLETED",
            execution_mode="replay",
            dataset_id=DATASET,
            candidate_capture_id=CAPTURE,
            reference_capture_id=CAPTURE,
            execution_spec=spec,
            execution_spec_sha256=digest(spec),
        )
        dataset, candidate, _ = selection(DATASET, CAPTURE, CAPTURE)
        self.sources = {
            path: (settings.LLMOPS_EVIDENCE_DIR / path).read_bytes()
            for path in (dataset["fixture"], candidate["path"])
        }
        self.fixture_path, self.capture_path = dataset["fixture"], candidate["path"]
        self.fixture = json.loads(self.sources[self.fixture_path])
        self.capture = json.loads(self.sources[self.capture_path])
        # read_result 이후의 원본·보고서 결합을 검사한다.
        # 실제 계산기 보고서와의 호환성은 test_rag_replay_flow에서 확인한다.
        report = {
            "fixtureSha256": spec["dataset"]["fixture_sha256"],
            "captureSha256": spec["candidate_sha256"],
            "measurementKind": "synthetic-contract-check",
            "execution": self.capture["execution"],
            "cases": [
                {
                    "caseId": row["caseId"],
                    "traceId": row["traceId"],
                    "failure": None,
                    "retrievalMeasured": True,
                    "answerMeasured": True,
                    "retrievedChunkIds": [
                        match["id"] for match in row["search"]["response"]["matches"]
                    ],
                    "citedChunkIds": row["answer"]["response"]["citationChunkIds"],
                }
                for row in self.capture["cases"]
            ],
        }
        self.comparison = {
            "scope": dataset["evaluation_scope"],
            "case_ids": dataset["case_ids"],
            "current": report,
            "reference": deepcopy(report),
        }

    def read(self):
        with (
            patch(
                "apps.evaluations.services.read_result",
                return_value=(None, None, None, self.comparison),
            ),
            patch(
                "apps.evaluations.artifact_store.read_evidence",
                side_effect=self.sources.__getitem__,
            ),
        ):
            return read_material(self.run)

    def test_pinned_korean_sources_answers_and_hash_are_preserved(self):
        result = self.read()
        first = result["cases"][0]
        self.assertEqual(first["content"], self.fixture["documents"][0]["content"])
        self.assertEqual(
            first["candidate"]["answer"], self.capture["cases"][0]["answer"]["response"]["answer"]
        )
        self.assertEqual(first["candidate"], first["reference"])
        self.assertEqual(
            first["candidate"]["context_chunk_ids"], first["candidate"]["retrieved_chunk_ids"]
        )
        self.assertFalse(result["baseline_eligible"])
        self.assertEqual(result, self.read())
        material_hash = result.pop("material_sha256")
        self.assertEqual(material_hash, digest(result))

    def test_changed_source_bytes_are_rejected_before_projection(self):
        for path in self.sources:
            original = self.sources[path]
            self.sources[path] += b" "
            with self.subTest(path=path), self.assertRaises(ResultsUnavailable):
                self.read()
            self.sources[path] = original
        self.run.execution_spec["reference_sha256"] = "0" * 64
        with self.assertRaises(ResultsUnavailable):
            self.read()

    def test_report_source_disagreement_fails_closed(self):
        original = deepcopy(self.comparison)
        for side in ("current", "reference"):
            for key, value in (
                ("traceId", "f" * 32),
                ("retrievedChunkIds", []),
                ("citedChunkIds", []),
                ("answerMeasured", False),
                ("failure", {"stage": "search", "code": "timeout"}),
            ):
                self.comparison = deepcopy(original)
                self.comparison[side]["cases"][0][key] = value
                with self.subTest(side=side, field=key), self.assertRaises(ResultsUnavailable):
                    self.read()

    def test_invalid_raw_context_is_rejected_even_with_updated_hash(self):
        self.capture["cases"][0]["answer"]["request"]["chunks"][0]["text"] += "변조"
        raw = json.dumps(self.capture).encode()
        self.sources[self.capture_path] = raw
        self.run.execution_spec.update(
            candidate_sha256=sha256(raw).hexdigest(), reference_sha256=sha256(raw).hexdigest()
        )
        with self.assertRaises(ResultsUnavailable):
            self.read()

    def test_uncompleted_or_non_rag_runs_cannot_publish_material(self):
        for status, mode, scope in (
            ("RUNNING", "replay", "source-chunks-retrieval-answer"),
            ("COMPLETED", "live", "source-chunks-retrieval-answer"),
            ("COMPLETED", "replay", "fixed-answer-context-only"),
        ):
            self.run.status, self.run.execution_mode = status, mode
            self.run.execution_spec["evaluation_scope"] = scope
            with (
                self.subTest(status=status, mode=mode, scope=scope),
                self.assertRaises(ResultsUnavailable),
            ):
                self.read()

    def test_invalid_result_never_reads_raw_material(self):
        with (
            patch("apps.evaluations.services.read_result", side_effect=ResultsUnavailable),
            patch("apps.evaluations.artifact_store.read_evidence") as raw,
            self.assertRaises(ResultsUnavailable),
        ):
            read_material(self.run)
        raw.assert_not_called()

    def test_recovery_uses_pinned_artifacts_without_falling_back_to_catalog(self):
        self.run.execution_mode = "recovery"
        artifacts = {
            "recovery-fixture.json": self.sources[self.fixture_path],
            "capture/capture.json": self.sources[self.capture_path],
            "reference-capture.json": self.sources[self.capture_path],
        }
        with (
            patch(
                "apps.evaluations.services.read_result",
                return_value=(None, None, None, self.comparison),
            ),
            patch(
                "apps.evaluations.artifact_store.read_artifact",
                side_effect=lambda _, path: artifacts[path],
            ),
            patch("apps.evaluations.artifact_store.read_evidence") as evidence,
        ):
            self.assertEqual(len(read_material(self.run)["cases"]), 3)
            artifacts["reference-capture.json"] += b" "
            with self.assertRaises(ResultsUnavailable):
                read_material(self.run)
        evidence.assert_not_called()

    def test_api_requires_current_admin_session_and_is_read_only(self):
        client = APIClient()
        url = f"/api/v1/ops/evaluations/{self.run.pk}/rag-material"
        with patch("apps.evaluations.views.get_object_or_404", return_value=self.run) as lookup:
            self.assertEqual(client.get(url).status_code, 401)
            client.cookies["govbiz_session"] = "non-admin-token"
            with patch(
                "apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied
            ):
                self.assertEqual(client.get(url).status_code, 403)
            lookup.assert_not_called()
            client.force_authenticate(get_user_model()(username="operator"))
            self.assertEqual(client.post(url, {}, format="json").status_code, 405)
            with patch("apps.evaluations.views.read_rag_material", return_value=self.read()):
                response = client.get(url)
                self.assertEqual(response.status_code, 200)
                self.assertIn("no-store", response["Cache-Control"])
                self.assertFalse(response.json()["baseline_eligible"])
            with patch(
                "apps.evaluations.views.read_rag_material",
                side_effect=ResultsUnavailable("private path"),
            ):
                response = client.get(url)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"code": "RESULTS_UNAVAILABLE"})
            lookup.side_effect = Http404
            self.assertEqual(client.get(url).status_code, 404)
