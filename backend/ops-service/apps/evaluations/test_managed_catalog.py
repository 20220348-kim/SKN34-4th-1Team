from copy import deepcopy
from datetime import time
from hashlib import sha256
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .artifact_store import read_evidence
from .catalog import DATASETS, LIVE_CAPTURE_ID, get_dataset, get_snapshot
from .execution_spec import digest, read_release
from .managed_materials import encoded
from .models import (
    EvaluationAdmission,
    EvaluationBaseline,
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationDatasetRevision,
    EvaluationRun,
    EvaluationSchedule,
    EvaluationScheduleOccurrence,
)
from .reviews import review_material
from .schedules import SEOUL, create_schedule
from .services import submit_run
from .test_dataset_management import content

CATALOG = "/api/v1/ops/evaluation-catalog"
DATASET_URL = "/api/v1/ops/datasets"


@override_settings(LLMOPS_LIVE_ENABLED=False, LLMOPS_RAG_LIVE_ENABLED=False)
class ManagedCatalogTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="managed-catalog-admin")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        cache = patch("apps.evaluations.vector_cache.discover", return_value=None)
        cache.start()
        self.addCleanup(cache.stop)
        self.draft = self.create_and_publish()
        self.dataset_id = self.draft["revisions"][0]["id"]

    def write_payload(self, version, **extra):
        return {"request_id": str(uuid4()), "expected_version": version, **extra}

    def create_and_publish(self):
        created = self.client.post(
            DATASET_URL, self.write_payload(0, content=content()), format="json"
        )
        self.assertEqual(created.status_code, 201, created.data)
        published = self.client.post(
            f"{DATASET_URL}/{created.data['id']}/publish", self.write_payload(1), format="json"
        )
        self.assertEqual(published.status_code, 200, published.data)
        return published.data

    def catalog(self):
        response = self.client.get(CATALOG)
        self.assertEqual(response.status_code, 200, response.data)
        return {row["id"]: row for row in response.data["datasets"]}

    def run_payload(self, *, mode="replay", confirmed=False):
        selected = self.catalog()[self.dataset_id]
        return {
            "request_id": uuid4(),
            "dataset_id": self.dataset_id,
            "candidate_capture_id": LIVE_CAPTURE_ID if mode == "live" else "manual",
            "reference_capture_id": "manual",
            "execution_mode": mode,
            "live_config": selected["live_config"] if mode == "live" else {},
            "execution_profile": selected["execution_profiles"][mode],
            "confirm_paid_run": confirmed,
        }

    def submit(self, payload):
        deployment_id, flow_id = uuid4(), uuid4()
        with patch(
            "apps.evaluations.prefect_client.request_json",
            side_effect=[{"id": str(deployment_id)}, {"id": str(flow_id)}],
        ) as prefect:
            run, created = submit_run(self.user, **payload)
        return run, created, prefect

    def archive(self, version):
        response = self.client.post(
            f"{DATASET_URL}/{self.draft['id']}/archive",
            self.write_payload(version, archived=True),
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_published_material_appears_without_enabling_paid_execution(self):
        with patch("apps.evaluations.prefect_client.request_json") as prefect:
            rows = self.catalog()
        prefect.assert_not_called()
        self.assertEqual(set(rows), {*DATASETS, self.dataset_id})
        row = rows[self.dataset_id]
        self.assertEqual(row["label"], content()["title"])
        self.assertEqual(row["case_ids"], ["Q01"])
        self.assertEqual(
            row["captures"],
            [
                {
                    "id": "manual",
                    "label": "관리자 입력 답변 · 모델 호출 기록 아님",
                }
            ],
        )
        self.assertIsNone(row["baseline"])
        self.assertEqual(row["evaluation_scope"], "fixed-answer-context-only")
        self.assertEqual(row["selection_guide"]["category"], "quality")
        session = self.client.get("/api/v1/ops/session").data
        self.assertFalse(session["live_enabled"])
        self.assertFalse(session["rag_live_enabled"])
        self.assertFalse(EvaluationBudget.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        self.assertFalse(EvaluationRun.objects.exists())

    def test_replay_submission_pins_inputs_and_dispatches_same_spec(self):
        payload = self.run_payload()
        run, created, prefect = self.submit(payload)
        self.assertTrue(created)
        snapshot = EvaluationDatasetRevision.objects.get(pk=self.dataset_id).snapshot
        self.assertEqual(run.execution_spec["dataset"]["managed_snapshot"], snapshot)
        self.assertEqual(run.execution_spec_sha256, digest(run.execution_spec))
        self.assertEqual(run.model_api_calls, 0)
        self.assertEqual(run.execution_spec["model_operations"], [])
        self.assertIsNone(run.execution_spec["generation"])
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        dispatched = prefect.call_args_list[1].args[1]
        self.assertEqual(dispatched["parameters"]["execution_spec"], run.execution_spec)
        self.assertEqual(
            dispatched["parameters"]["execution_spec_sha256"], run.execution_spec_sha256
        )
        self.assertEqual(dispatched["idempotency_key"], f"ops-{run.pk}")
        self.assertEqual(dispatched["parameters"]["execution_mode"], "replay")

    def test_mysql_json_roundtrip_preserves_fixture_and_capture_bytes(self):
        # MySQL JSON 저장은 객체 키 순서를 정규화한다. 재조회 뒤에도 바이트 해시는 같아야 한다.
        snapshot = get_snapshot(self.dataset_id)
        catalog = snapshot["catalog"]
        fixture_raw = read_evidence(catalog["fixture"])
        capture_raw = read_evidence(catalog["captures"][0]["path"])
        self.assertEqual(fixture_raw, encoded(snapshot["fixture"]))
        self.assertEqual(capture_raw, encoded(snapshot["capture"]))
        self.assertEqual(sha256(fixture_raw).hexdigest(), catalog["fixture_sha256"])
        self.assertEqual(snapshot["capture"]["fixtureSha256"], catalog["fixture_sha256"])
        release = read_release(self.dataset_id)["datasets"][self.dataset_id]
        self.assertEqual(sha256(capture_raw).hexdigest(), release["captures"]["manual"])
        self.assertEqual(release["fixture_sha256"], catalog["fixture_sha256"])

    def test_replay_api_accepts_dynamic_material_identifier(self):
        payload = self.run_payload()
        payload["request_id"] = str(payload["request_id"])
        with patch("apps.evaluations.prefect_client.create_run", return_value=uuid4()):
            response = self.client.post("/api/v1/ops/evaluations", payload, format="json")
        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(response.data["dataset_id"], self.dataset_id)
        self.assertEqual(response.data["candidate_label"], "관리자 입력 답변 · 모델 호출 기록 아님")
        self.assertEqual(response.data["model_api_calls"], 0)

    def test_edit_and_new_publication_keep_prior_spec_and_catalog_only_latest(self):
        payload = self.run_payload()
        run, _, _ = self.submit(payload)
        original = deepcopy(run.execution_spec)
        edited = content()
        edited["title"] = "수정한 지원 대상 자료"
        edited["documents"][0]["chunks"] = ["지원 대상은 부산 소재 중소 제조기업입니다."]
        edited["cases"][0]["reference_facts"] = ["부산 소재 중소 제조기업"]
        edited["cases"][0]["answer"]["text"] = "부산 소재 중소 제조기업입니다."
        response = self.client.put(
            f"{DATASET_URL}/{self.draft['id']}",
            self.write_payload(2, content=edited),
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        published = self.client.post(
            f"{DATASET_URL}/{self.draft['id']}/publish", self.write_payload(3), format="json"
        )
        self.assertEqual(published.status_code, 200, published.data)
        newer_id = published.data["revisions"][0]["id"]
        self.assertNotEqual(newer_id, self.dataset_id)
        self.assertNotIn(self.dataset_id, self.catalog())
        self.assertIn(newer_id, self.catalog())
        run.refresh_from_db()
        self.assertEqual(run.execution_spec, original)
        self.assertEqual(get_snapshot(self.dataset_id), original["dataset"]["managed_snapshot"])
        self.assertNotEqual(
            get_dataset(newer_id)["fixture_sha256"], original["dataset"]["fixture_sha256"]
        )

    def test_archive_blocks_new_admission_but_preserves_original_retry(self):
        payload = self.run_payload()
        run, _, _ = self.submit(payload)
        original = deepcopy(run.execution_spec)
        self.archive(2)
        self.assertNotIn(self.dataset_id, self.catalog())
        with patch("apps.evaluations.prefect_client.request_json") as prefect:
            with self.assertRaisesRegex(ValueError, "보관"):
                submit_run(self.user, **{**payload, "request_id": uuid4()})
            retry, created = submit_run(self.user, **payload)
        prefect.assert_not_called()
        self.assertFalse(created)
        self.assertEqual(retry.pk, run.pk)
        self.assertEqual(retry.execution_spec, original)
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertEqual(get_snapshot(self.dataset_id), original["dataset"]["managed_snapshot"])

    def test_managed_review_material_preserves_manual_origin_and_source(self):
        run, _, _ = self.submit(self.run_payload())
        run.status = "COMPLETED"
        run.save(update_fields=["status"])
        snapshot = run.execution_spec["dataset"]["managed_snapshot"]
        capture_hash = sha256(encoded(snapshot["capture"])).hexdigest()
        comparison = {
            "scope": "fixed-answer-context-only",
            "fixture_sha256": snapshot["catalog"]["fixture_sha256"],
            "candidate_execution": {"capture_sha256": capture_hash},
            "reference_execution": {"capture_sha256": capture_hash},
        }
        # 보고서 완료 여부만 대역이다. 자료·캡처는 실제 게시 DB 버전과 해시로 읽는다.
        with patch(
            "apps.evaluations.services.read_result", return_value=(None, None, None, comparison)
        ):
            material = review_material(run)
        self.assertEqual(material["data_type"], "admin-provided")
        self.assertEqual(material["reference_source"], "admin-authored")
        self.assertEqual(material["candidate_origin"], "admin-entered-answer")
        self.assertEqual(material["recorded_model"], "not-recorded")
        self.assertIsNone(material["recorded_at"])
        case = material["cases"][0]
        self.assertEqual(case["case_id"], "Q01")
        self.assertEqual(case["source_url"], content()["documents"][0]["source_url"])
        self.assertIsNone(case["source"])
        self.assertEqual(case["cited_orders"], [0])
        self.assertEqual(case["answer"], content()["cases"][0]["answer"]["text"])
        self.assertEqual(case["reference_answer"], case["answer"])
        self.archive(2)
        self.assertEqual(
            read_evidence(snapshot["catalog"]["fixture"]), encoded(snapshot["fixture"])
        )
        with patch(
            "apps.evaluations.services.read_result", return_value=(None, None, None, comparison)
        ):
            self.assertEqual(review_material(run), material)

    @override_settings(LLMOPS_SCHEDULES_ENABLED=True, LLMOPS_LIVE_ENABLED=True)
    def test_archive_blocks_new_schedule_but_preserves_original_request_retry(self):
        selected = self.catalog()[self.dataset_id]
        today = timezone.now().astimezone(SEOUL).date()
        baseline = EvaluationBaseline.objects.create(dataset_id=self.dataset_id, version=1)
        reference_id = f"run:{uuid4()}"
        payload = {
            "request_id": uuid4(),
            "dataset_id": self.dataset_id,
            "reference_capture_id": reference_id,
            "baseline_version": baseline.version,
            "execution_profile": selected["execution_profiles"]["live"],
            "live_config": selected["live_config"],
            "confirm_paid_run": True,
            "daily_at": time(9),
            "starts_on": today,
            "ends_on": today,
            "reason": "격리 테스트의 정기 계획",
        }
        # 기준 승인·예산 상태만 대역이다. 게시/보관 자료 잠금과 계획 저장은 실제 DB를 사용한다.
        with (
            patch(
                "apps.evaluations.schedules.baseline_choices",
                return_value={self.dataset_id: {"id": reference_id, "version": 1}},
            ),
            patch("apps.evaluations.schedules.require_budget") as budget,
            patch("apps.evaluations.prefect_client.request_json") as prefect,
        ):
            original, created = create_schedule(self.user, **payload)
            self.assertTrue(created)
            budget.assert_called_once_with(
                {"calls": 1, "input_tokens": 32768, "output_tokens": 2000}
            )
            budget.reset_mock()
            self.archive(2)
            with self.assertRaisesRegex(ValueError, "보관"):
                create_schedule(self.user, **{**payload, "request_id": uuid4()})
            retry, created = create_schedule(self.user, **payload)
            self.assertFalse(created)
            self.assertEqual(retry.pk, original.pk)
            self.assertEqual(retry.request, original.request)
            budget.assert_not_called()
            prefect.assert_not_called()
        self.assertEqual(EvaluationSchedule.objects.count(), 1)
        self.assertFalse(EvaluationScheduleOccurrence.objects.exists())
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())

    def test_live_disabled_or_missing_confirmation_never_reserves_or_dispatches(self):
        for server_enabled, confirmed in [(False, False), (False, True), (True, False)]:
            payload = self.run_payload(mode="live", confirmed=confirmed)
            with (
                self.subTest(server_enabled=server_enabled, confirmed=confirmed),
                override_settings(LLMOPS_LIVE_ENABLED=server_enabled),
                patch("apps.evaluations.services.reserve") as reserve,
                patch("apps.evaluations.prefect_client.request_json") as prefect,
            ):
                with self.assertRaisesRegex(ValueError, "활성화"):
                    submit_run(self.user, **payload)
                reserve.assert_not_called()
                prefect.assert_not_called()
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())

    def test_archived_readiness_reports_blocker_without_reserving_or_dispatching(self):
        selected = self.catalog()[self.dataset_id]
        self.archive(2)
        with (
            patch("apps.evaluations.services.reserve") as reserve,
            patch("apps.evaluations.prefect_client.request_json") as prefect,
        ):
            response = self.client.get(
                "/api/v1/ops/evaluations/live-readiness",
                {
                    "dataset_id": self.dataset_id,
                    "execution_profile": selected["execution_profiles"]["live"],
                },
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["state"], "blocked")
        self.assertIn("DATASET_ARCHIVED", [item["code"] for item in response.data["blockers"]])
        reserve.assert_not_called()
        prefect.assert_not_called()
        self.assertFalse(EvaluationAdmission.objects.exists())
        self.assertFalse(EvaluationBudget.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        self.assertFalse(EvaluationRun.objects.exists())
