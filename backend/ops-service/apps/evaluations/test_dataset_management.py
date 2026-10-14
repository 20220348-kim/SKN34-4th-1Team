from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .dataset_management import DatasetConflict, change_dataset, lock_for_submission
from .models import (
    EvaluationDataset,
    EvaluationDatasetChange,
    EvaluationDatasetRevision,
    EvaluationRun,
)

URL = "/api/v1/ops/datasets"


def content():
    return {
        "title": "지원 대상 회귀 자료",
        "description": "한글·특수문자 & 원문을 보존하는 관리자 입력 자료",
        "documents": [
            {
                "id": "doc-1",
                "title": "디지털 전환 지원",
                "source_url": "https://example.org/program?id=1",
                "chunks": ["지원 대상은 서울 소재 중소 제조기업입니다."],
            }
        ],
        "cases": [
            {
                "id": "Q01",
                "document_id": "doc-1",
                "question": "지원 대상은 누구인가요?",
                "expected_status": "ANSWERED",
                "expected_citation_orders": [0],
                "reference_facts": ["서울 소재 중소 제조기업"],
                "forbidden_claims": ["전국 모든 기업이 신청 가능"],
                "answer": {
                    "text": "서울 소재 중소 제조기업이 대상입니다.",
                    "status": "ANSWERED",
                    "citation_orders": [0],
                },
            }
        ],
    }


@override_settings(LLMOPS_LIVE_ENABLED=False, LLMOPS_RAG_LIVE_ENABLED=False)
class DatasetManagementTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="dataset-admin")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def payload(self, version=0, **values):
        return {"request_id": str(uuid4()), "expected_version": version, **values}

    def create(self, value=None):
        body = self.payload(content=content() if value is None else value)
        response = self.client.post(URL, body, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        return response.data, body

    def publish(self, dataset):
        body = self.payload(dataset["version"])
        response = self.client.post(f"{URL}/{dataset['id']}/publish", body, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data, body

    def test_create_list_read_preserve_content_without_evaluation(self):
        self.assertEqual(self.client.get(URL).json()["datasets"], [])
        self.assertFalse(EvaluationDataset.objects.exists())
        dataset, _ = self.create()
        self.assertEqual(dataset["version"], 1)
        self.assertFalse(dataset["archived"])
        self.assertEqual(dataset["content"], content())
        self.assertEqual(dataset["revisions"], [])
        self.assertEqual(self.client.get(f"{URL}/{dataset['id']}").json(), dataset)
        listing = self.client.get(URL)
        self.assertEqual(listing.json()["datasets"], [dataset])
        self.assertGreater(listing.json()["builtin_count"], 0)
        self.assertIn("no-store", listing["Cache-Control"])
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertEqual(EvaluationDataset.objects.get().created_by, self.user)

    def test_draft_without_answer_is_saved_but_cannot_be_published(self):
        value = content()
        value["cases"][0]["answer"] = None
        dataset, _ = self.create(value)
        response = self.client.post(
            f"{URL}/{dataset['id']}/publish", self.payload(1), format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "DATASET_VALIDATION_ERROR")
        self.assertFalse(EvaluationDatasetRevision.objects.exists())
        self.assertEqual(EvaluationDataset.objects.get().version, 1)

    def test_publish_freezes_version_and_edit_does_not_change_it(self):
        dataset, _ = self.create()
        published, _ = self.publish(dataset)
        first = EvaluationDatasetRevision.objects.get()
        original = deepcopy(first.snapshot)
        self.assertEqual(first.pk, f"managed-{EvaluationDataset.objects.get().pk.hex}-v1")
        self.assertEqual(first.published_by, self.user)
        self.assertEqual(published["version"], 2)
        changed = content()
        changed["title"] = "두 번째 자료 제목"
        changed["cases"][0]["answer"]["text"] = "서울의 중소 제조기업입니다."
        edited = self.client.put(
            f"{URL}/{dataset['id']}", self.payload(2, content=changed), format="json"
        )
        self.assertEqual(edited.status_code, 200, edited.data)
        first.refresh_from_db()
        self.assertEqual(first.snapshot, original)
        second, _ = self.publish(edited.data)
        self.assertEqual([row["number"] for row in second["revisions"]], [2, 1])
        self.assertEqual(len({row["id"] for row in second["revisions"]}), 2)
        self.assertNotEqual(EvaluationDatasetRevision.objects.first().snapshot, original)
        self.assertFalse(EvaluationRun.objects.exists())

    def test_stale_update_is_rejected_without_overwriting(self):
        dataset, _ = self.create()
        value = content()
        value["description"] = "먼저 저장한 의견"
        first = self.client.put(
            f"{URL}/{dataset['id']}", self.payload(1, content=value), format="json"
        )
        self.assertEqual(first.status_code, 200)
        stale = self.client.put(
            f"{URL}/{dataset['id']}", self.payload(1, content=content()), format="json"
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["code"], "DATASET_CONFLICT")
        self.assertEqual(EvaluationDataset.objects.get().draft, value)

    def test_create_retry_returns_original_response_without_undoing_edit(self):
        dataset, body = self.create()
        value = content()
        value["title"] = "수정된 이름"
        self.client.put(f"{URL}/{dataset['id']}", self.payload(1, content=value), format="json")
        retry = self.client.post(URL, body, format="json")
        self.assertEqual(retry.status_code, 201)
        self.assertEqual(retry.data, dataset)
        self.assertEqual(EvaluationDataset.objects.count(), 1)
        self.assertEqual(EvaluationDataset.objects.get().draft, value)
        self.assertEqual(EvaluationDatasetChange.objects.count(), 2)

    def test_request_reuse_with_other_content_actor_or_action_conflicts(self):
        dataset, body = self.create()
        altered = deepcopy(body)
        altered["content"]["description"] = "다른 요청 내용"
        self.assertEqual(self.client.post(URL, altered, format="json").status_code, 409)
        other = get_user_model().objects.create_user(username="other-admin")
        self.client.force_authenticate(other)
        self.assertEqual(self.client.post(URL, body, format="json").status_code, 409)
        self.client.force_authenticate(self.user)
        self.assertEqual(
            self.client.post(
                f"{URL}/{dataset['id']}/publish",
                {"request_id": body["request_id"], "expected_version": 1},
                format="json",
            ).status_code,
            409,
        )
        self.assertEqual(EvaluationDatasetChange.objects.count(), 1)

    def test_archive_restore_preserve_versions_and_publication_retry(self):
        dataset, _ = self.create()
        published, publication = self.publish(dataset)
        identifier = published["revisions"][0]["id"]
        archived = self.client.post(
            f"{URL}/{dataset['id']}/archive", self.payload(2, archived=True), format="json"
        )
        self.assertEqual(archived.status_code, 200, archived.data)
        self.assertTrue(archived.data["archived"])
        with transaction.atomic(), self.assertRaisesRegex(ValueError, "보관"):
            lock_for_submission(identifier)
        retry = self.client.post(f"{URL}/{dataset['id']}/publish", publication, format="json")
        self.assertEqual(retry.data, published)
        self.assertTrue(EvaluationDataset.objects.get().archived)
        self.assertEqual(EvaluationDatasetRevision.objects.count(), 1)
        self.assertEqual(
            self.client.post(
                f"{URL}/{dataset['id']}/publish", self.payload(3), format="json"
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.put(
                f"{URL}/{dataset['id']}", self.payload(3, content=content()), format="json"
            ).status_code,
            400,
        )
        restored = self.client.post(
            f"{URL}/{dataset['id']}/archive", self.payload(3, archived=False), format="json"
        )
        self.assertEqual(restored.status_code, 200)
        self.assertFalse(restored.data["archived"])
        with transaction.atomic():
            self.assertEqual(
                lock_for_submission(identifier), EvaluationDatasetRevision.objects.get().snapshot
            )
        self.assertEqual(
            self.client.get(f"{URL}/{dataset['id']}").data["revisions"], published["revisions"]
        )

    def test_archive_stale_version_and_retry_do_not_undo_restore(self):
        dataset, _ = self.create()
        archive = self.payload(1, archived=True)
        first = self.client.post(f"{URL}/{dataset['id']}/archive", archive, format="json")
        stale = self.client.post(
            f"{URL}/{dataset['id']}/archive", self.payload(1, archived=False), format="json"
        )
        self.assertEqual(stale.status_code, 409)
        self.client.post(
            f"{URL}/{dataset['id']}/archive", self.payload(2, archived=False), format="json"
        )
        self.assertEqual(
            self.client.post(f"{URL}/{dataset['id']}/archive", archive, format="json").data,
            first.data,
        )
        self.assertFalse(EvaluationDataset.objects.get().archived)

    def test_invalid_payload_is_rejected_before_writes(self):
        for change in (
            {"expected_version": True},
            {"expected_version": "0"},
            {"expected_version": -1},
            {"request_id": "not-a-uuid"},
            {"unexpected": "field"},
            {"content": []},
            {"content": {"title": ""}},
        ):
            with self.subTest(change=change):
                response = self.client.post(
                    URL, {**self.payload(content=content()), **change}, format="json"
                )
                self.assertEqual(response.status_code, 400)
        self.assertFalse(EvaluationDataset.objects.exists())
        self.assertFalse(EvaluationDatasetChange.objects.exists())

    def test_unknown_dataset_is_not_found(self):
        url = f"{URL}/{uuid4()}"
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(
            self.client.put(url, self.payload(1, content=content()), format="json").status_code, 404
        )
        self.assertEqual(
            self.client.post(f"{url}/publish", self.payload(1), format="json").status_code, 404
        )
        self.assertEqual(
            self.client.post(
                f"{url}/archive", self.payload(1, archived=True), format="json"
            ).status_code,
            404,
        )

    def test_audit_failure_rolls_back_draft_and_publication(self):
        with patch.object(EvaluationDatasetChange.objects, "create", side_effect=IntegrityError):
            with self.assertRaises(IntegrityError):
                self.create()
        self.assertFalse(EvaluationDataset.objects.exists())
        dataset, _ = self.create()
        with patch.object(EvaluationDatasetChange.objects, "create", side_effect=IntegrityError):
            with self.assertRaises(IntegrityError):
                self.publish(dataset)
        self.assertFalse(EvaluationDatasetRevision.objects.exists())
        self.assertEqual(EvaluationDataset.objects.get().version, 1)

    def test_database_enforces_positive_versions_and_unique_revision(self):
        dataset, _ = self.create()
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationDataset.objects.filter(pk=dataset["id"]).update(version=0)
        self.publish(dataset)
        first = EvaluationDatasetRevision.objects.get()
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationDatasetRevision.objects.create(
                id="other-id",
                dataset=first.dataset,
                number=1,
                snapshot=first.snapshot,
                published_by=self.user,
            )

    def test_admin_auth_csrf_origin_and_attribution(self):
        client = APIClient(enforce_csrf_checks=True)
        self.assertEqual(client.get(URL).status_code, 401)
        self.assertEqual(
            client.post(URL, self.payload(content=content()), format="json").status_code, 401
        )
        client.cookies["govbiz_session"] = "test-session"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(client.get(URL).status_code, 403)
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={"accountId": 151, "email": "dataset@example.com", "role": "ADMIN"},
        ):
            self.assertEqual(client.get(URL).status_code, 200)
            body = self.payload(content=content())
            self.assertEqual(client.post(URL, body, format="json").status_code, 403)
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            self.assertEqual(
                client.post(
                    URL,
                    body,
                    format="json",
                    HTTP_X_CSRFTOKEN=token,
                    HTTP_ORIGIN="https://outside.invalid",
                ).status_code,
                403,
            )
            result = client.post(URL, body, format="json", HTTP_X_CSRFTOKEN=token)
            self.assertEqual(result.status_code, 201, result.data)
        change = EvaluationDatasetChange.objects.get()
        self.assertEqual(change.actor.username, "core:151")
        self.assertEqual(change.dataset.created_by, change.actor)


@skipUnless(connection.vendor == "mysql", "실제 MySQL 행 잠금은 CI에서 확인합니다.")
class DatasetConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="concurrent-dataset-admin")

    def concurrent(self, function):
        barrier = Barrier(2)

        def worker(index):
            close_old_connections()
            try:
                user = get_user_model().objects.get(pk=self.user.pk)
                barrier.wait(timeout=10)
                return function(index, user)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(worker, range(2)))

    def test_simultaneous_same_create_request_leaves_one_dataset(self):
        request_id = uuid4()
        result = self.concurrent(
            lambda index, user: change_dataset(
                user=user,
                request_id=request_id,
                expected_version=0,
                action="CREATE",
                content=content(),
            )
        )
        self.assertEqual(result[0], result[1])
        self.assertEqual(EvaluationDataset.objects.count(), 1)
        self.assertEqual(EvaluationDatasetChange.objects.count(), 1)

    def test_simultaneous_updates_accept_only_one_editor_version(self):
        dataset = change_dataset(
            user=self.user,
            request_id=uuid4(),
            expected_version=0,
            action="CREATE",
            content=content(),
        )

        def update(index, user):
            value = content()
            value["description"] = f"편집 {index}"
            try:
                change_dataset(
                    user=user,
                    request_id=uuid4(),
                    expected_version=1,
                    action="UPDATE",
                    dataset_id=dataset["id"],
                    content=value,
                )
                return "saved"
            except DatasetConflict:
                return "conflict"

        self.assertCountEqual(self.concurrent(update), ["saved", "conflict"])
        self.assertEqual(EvaluationDataset.objects.get().version, 2)
        self.assertEqual(EvaluationDatasetChange.objects.count(), 2)
