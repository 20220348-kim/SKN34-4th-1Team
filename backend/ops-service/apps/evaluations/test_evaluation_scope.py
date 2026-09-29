"""DB·모델 호출 없이 접수 범위, 결과 무결성, 품질 정책 경계를 검증한다."""

import json
from copy import deepcopy
from hashlib import sha256
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase

from .catalog import LEGACY_DATASET_ID, live_config, public_datasets
from .execution_spec import EVALUATION_SCOPE, digest, make_spec, read_release
from .models import EvaluationRun
from .prefect_client import run_parameters
from .quality import assessment_inputs, quality_pass
from .services import ResultsUnavailable, read_live_capture, read_result
from .views import run_data


class EvaluationScopeTests(SimpleTestCase):
    def setUp(self):
        release = read_release()
        spec = make_spec(
            release, LEGACY_DATASET_ID, "replay", {}, LEGACY_DATASET_ID, LEGACY_DATASET_ID
        )
        self.run = EvaluationRun(
            id=uuid4(),
            requested_by=get_user_model()(username="offline-operator"),
            dataset_id=LEGACY_DATASET_ID,
            status="COMPLETED",
            prefect_flow_run_id=uuid4(),
            execution_spec=spec,
            execution_spec_sha256=digest(spec),
        )
        self.comparison = {
            "schema_version": 2,
            "scope": EVALUATION_SCOPE,
            "retrieval_evaluated": False,
            "evaluation_run_id": "a" * 32,
            "reference_run_id": "b" * 32,
            "fixture_sha256": spec["dataset"]["fixture_sha256"],
            "case_ids": spec["dataset"]["case_ids"],
            "current": {"completed": True},
            "reference": {"completed": True},
            "candidate_execution": {"run_id": "a" * 32},
            "reference_execution": {"run_id": "b" * 32},
        }
        self.manifest = {
            "status": "completed",
            "scope": EVALUATION_SCOPE,
            "execution_spec_sha256": digest(spec),
            "evaluation_run_id": "a" * 32,
            "reference_run_id": "b" * 32,
            "model_api_calls": 0,
            "evaluator_version": spec["evaluation"]["version"],
            "fixture_sha256": spec["dataset"]["fixture_sha256"],
            "capture_sha256": spec["candidate_sha256"],
            "reference_capture_sha256": spec["reference_sha256"],
        }

    def read(self, comparison=None, manifest=None):
        comparison = self.comparison if comparison is None else comparison
        raw = json.dumps(comparison).encode()
        manifest = {
            **(self.manifest if manifest is None else manifest),
            "artifact_sha256": {
                "comparison.json": sha256(raw).hexdigest(),
                "report.html": sha256(b"report").hexdigest(),
            },
        }
        artifacts = {
            "request.json": json.dumps(
                {
                    **run_parameters(self.run),
                    "prefect_flow_run_id": str(self.run.prefect_flow_run_id),
                }
            ).encode(),
            "evaluation/comparison.json": raw,
            "evaluation/manifest.json": json.dumps(manifest).encode(),
            "evaluation/report.html": b"report",
        }
        with patch(
            "apps.evaluations.services.read_artifact", side_effect=lambda _, name: artifacts[name]
        ):
            return read_result(self.run)

    def test_scope_is_pinned_and_exposed_without_claiming_retrieval(self):
        self.assertEqual(self.run.execution_spec["schema_version"], 2)
        self.assertEqual(public_datasets()[0]["evaluation_scope"], EVALUATION_SCOPE)
        self.assertEqual(run_data(self.run)["evaluation_scope"], EVALUATION_SCOPE)
        comparison = self.read()[3]
        self.assertEqual(comparison["scope"], EVALUATION_SCOPE)
        self.assertIs(comparison["retrieval_evaluated"], False)

    def test_valid_hashes_do_not_authorize_different_or_missing_scope(self):
        for scope in ("core-http-mysql-frozen-html-ai-evidence-flow", None, "unknown"):
            with self.subTest(scope=scope), self.assertRaises(ResultsUnavailable):
                self.read({**self.comparison, "scope": scope})
        for field in ("scope", "retrieval_evaluated"):
            other = deepcopy(self.comparison)
            del other[field]
            with self.subTest(missing=field), self.assertRaises(ResultsUnavailable):
                self.read(other)
        with self.assertRaises(ResultsUnavailable):
            self.read({**self.comparison, "retrieval_evaluated": True})

    def test_pinned_scope_and_manifest_must_agree(self):
        for value in (None, "full-rag"):
            with self.subTest(manifest=value), self.assertRaises(ResultsUnavailable):
                self.read(manifest={**self.manifest, "scope": value})
        del self.run.execution_spec["evaluation_scope"]
        self.run.execution_spec_sha256 = digest(self.run.execution_spec)
        with self.assertRaises(ResultsUnavailable):
            self.read(
                manifest={**self.manifest, "execution_spec_sha256": self.run.execution_spec_sha256}
            )

    def test_legacy_comparison_keeps_explicit_scope_and_does_not_rewrite_receipt(self):
        self.run.execution_spec = {}
        self.run.execution_spec_sha256 = ""
        comparison = deepcopy(self.comparison)
        del comparison["retrieval_evaluated"]
        manifest = deepcopy(self.manifest)
        del manifest["scope"]
        self.assertEqual(self.read(comparison, manifest)[3], comparison)
        self.assertIsNone(run_data(self.run)["evaluation_scope"])
        self.run.comparison = comparison
        self.assertEqual(run_data(self.run)["evaluation_scope"], EVALUATION_SCOPE)
        self.assertEqual(self.run.execution_spec, {})

    def test_quality_policy_cannot_assess_or_promote_another_scope(self):
        for scope in (None, "full-rag"):
            with self.subTest(scope=scope):
                material = {"evaluation_scope": scope}
                with self.assertRaises(ResultsUnavailable):
                    assessment_inputs(self.run, material)
                self.assertFalse(quality_pass(self.run, material))

    def test_new_live_capture_must_explicitly_match_accepted_scope(self):
        self.run.live_config = live_config(LEGACY_DATASET_ID)
        capture = {"model": self.run.live_config["model"], "modelApiCalls": 1}
        for scope in (None, "full-rag"):
            with (
                self.subTest(scope=scope),
                patch("apps.evaluations.services.read_request"),
                patch(
                    "apps.evaluations.services.read_artifact",
                    return_value=json.dumps({**capture, "scope": scope}).encode(),
                ),
                self.assertRaises(ResultsUnavailable),
            ):
                read_live_capture(self.run)
