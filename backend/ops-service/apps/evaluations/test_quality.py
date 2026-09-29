import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TestCase, TransactionTestCase

from .execution_spec import digest
from .models import EvaluationBaseline, FixtureReview, QualityAssessment
from .quality import assess, quality_pass, save_fixture_review
from .quality_policy import judge
from .reviews import promote_baseline, review_material
from .services import RequestConflict
from .test_reviews import ReviewFixture


class QualityPolicyTests(SimpleTestCase):
    def test_unreviewed_labels_and_null_inapplicable_citations_are_not_false_failures(self):
        case = {
            "case_id": "TC01",
            "review": "SUITABLE",
            "status_match": False,
            "citation_recall": None,
        }
        self.assertEqual(judge({"fixture_approved": False, "cases": [case]})[0], "NEEDS_REVIEW")
        self.assertEqual(judge({"fixture_approved": True, "cases": [case]})[0], "FAIL")
        case["status_match"] = True
        self.assertEqual(judge({"fixture_approved": True, "cases": [case]})[0], "PASS")

    def test_one_critical_failure_is_not_averaged_away(self):
        cases = [
            {"case_id": str(i), "review": "SUITABLE", "status_match": True, "citation_recall": 1}
            for i in range(6)
        ]
        cases[-1]["review"] = "UNSUITABLE"
        status, reasons = judge({"fixture_approved": True, "cases": cases})
        self.assertEqual(status, "FAIL")
        self.assertEqual(reasons, [{"code": "CASE_UNSUITABLE", "case_id": "5"}])
        cases[-1]["review"] = "DEFERRED"
        self.assertEqual(judge({"fixture_approved": True, "cases": cases})[0], "NEEDS_REVIEW")
        cases[-1]["citation_recall"] = 0
        self.assertEqual(judge({"fixture_approved": True, "cases": cases})[0], "FAIL")


class QualityTests(ReviewFixture, TestCase):
    def state(self):
        return self.client.get(self.url + "/review").json()

    def test_different_scope_blocks_review_and_quality_even_with_matching_artifact_hash(self):
        current = self.state()
        folder = self.root / str(self.run.id) / "evaluation"
        path = folder / "comparison.json"
        comparison = json.loads(path.read_bytes())
        comparison["scope"] = "full-rag"
        path.write_text(json.dumps(comparison))
        manifest_path = folder / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["artifact_sha256"]["comparison.json"] = sha256(path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        blocked = self.state()
        self.assertIsNone(blocked["material"])
        self.assertFalse(blocked["can_approve"])
        self.assertFalse(blocked["can_promote"])
        self.assertEqual(
            self.client.post(
                self.url + "/quality",
                {
                    "input_sha256": current["quality"]["input_sha256"],
                },
                format="json",
            ).status_code,
            503,
        )
        self.assertFalse(QualityAssessment.objects.exists())

    def fixture_payload(self, decision="APPROVED"):
        state = self.state()
        return {
            "decision": decision,
            "comment": "테스트 자료 검토: 실제 품질 승인이 아님",
            "fixture_sha256": state["material"]["fixture_sha256"],
            "case_ids": [case["case_id"] for case in state["material"]["cases"]],
            "rubric_version": state["quality"]["fixture_rubric_version"],
            "fixture_version": state["quality"]["fixture_version"],
        }

    def calculate(self):
        response = self.client.post(
            self.url + "/quality",
            {
                "input_sha256": self.state()["quality"]["input_sha256"],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["quality"]

    def test_completed_legacy_run_is_unassessed_until_explicit_action(self):
        state = self.state()["quality"]
        self.assertEqual(state["status"], "NOT_EVALUATED")
        self.assertEqual(state["history"], [])
        result = self.calculate()
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertEqual(
            {item["code"] for item in result["history"][0]["reasons"]},
            {"FIXTURE_REVIEW_REQUIRED", "CASE_REVIEW_REQUIRED"},
        )
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, "COMPLETED")
        self.assertEqual(self.run.execution_spec, {})

    def test_fixture_review_and_answer_approval_are_separate(self):
        state = self.state()
        for case in state["material"]["cases"]:
            response = self.client.post(
                self.url + "/case-review",
                {
                    "case_id": case["case_id"],
                    "decision": "SUITABLE",
                    "comment": "답변만 확인",
                    "capture_sha256": state["material"]["capture_sha256"],
                    "fixture_sha256": state["material"]["fixture_sha256"],
                    "rubric_version": state["rubric"]["version"],
                    "review_version": state["review_version"],
                },
                format="json",
            )
            state = response.json()
        self.assertEqual(self.calculate()["status"], "NEEDS_REVIEW")
        self.assertFalse(FixtureReview.objects.exists())
        self.assertFalse(self.state()["can_promote"])
        response = self.client.post(
            self.url + "/fixture-review", self.fixture_payload(), format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calculate()["status"], "PASS")
        self.assertFalse(self.state()["approval_current"])

    def test_idempotent_assessment_and_fixture_retry_preserve_author_and_history(self):
        payload = self.fixture_payload()
        first = self.client.post(self.url + "/fixture-review", payload, format="json")
        repeated = self.client.post(self.url + "/fixture-review", payload, format="json")
        self.assertEqual(
            first.json()["quality"]["fixture_reviews"],
            repeated.json()["quality"]["fixture_reviews"],
        )
        self.assertEqual(self.calculate(), self.calculate())
        self.assertEqual(FixtureReview.objects.count(), 1)
        self.assertEqual(QualityAssessment.objects.count(), 1)
        self.assertEqual(
            self.client.post(
                self.url + "/fixture-review", {**payload, "decision": "DEFERRED"}, format="json"
            ).status_code,
            409,
        )

    def test_stale_hash_unknown_cases_and_empty_reason_are_rejected(self):
        payload = self.fixture_payload()
        for changes, status in [
            ({"fixture_sha256": "0" * 64}, 409),
            ({"case_ids": ["unknown"]}, 409),
            ({"rubric_version": "future"}, 409),
            ({"comment": " "}, 400),
        ]:
            self.assertEqual(
                self.client.post(
                    self.url + "/fixture-review", {**payload, **changes}, format="json"
                ).status_code,
                status,
            )
        old_hash = self.state()["quality"]["input_sha256"]
        self.client.post(self.url + "/fixture-review", payload, format="json")
        self.assertEqual(
            self.client.post(
                self.url + "/quality", {"input_sha256": old_hash}, format="json"
            ).status_code,
            409,
        )
        self.assertFalse(QualityAssessment.objects.exists())

    def test_fixture_revocation_invalidates_pass_and_baseline_without_erasing_history(self):
        self.promote()
        original = deepcopy(QualityAssessment.objects.get().inputs)
        response = self.client.post(
            self.url + "/fixture-review", self.fixture_payload("CHANGES_REQUESTED"), format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["quality"]["is_current"])
        self.assertFalse(response.json()["can_promote"])
        self.assertIsNone(EvaluationBaseline.objects.get(pk=self.dataset).review_id)
        self.assertEqual(QualityAssessment.objects.get().inputs, original)
        self.assertEqual(QualityAssessment.objects.get().status, "PASS")
        self.assertFalse(quality_pass(self.run))
        self.assertEqual(self.calculate()["status"], "NEEDS_REVIEW")

    def test_changed_policy_requires_new_assessment_and_keeps_prior_snapshot(self):
        self.review()
        original = QualityAssessment.objects.get()
        policy = deepcopy(original.policy)
        policy["definition"]["version"] = "next-policy"
        with patch("apps.evaluations.quality.current_policy", return_value=policy):
            self.assertFalse(quality_pass(self.run))
            self.assertFalse(self.state()["quality"]["is_current"])
            self.assertEqual(self.calculate()["status"], "PASS")
            self.assertEqual(QualityAssessment.objects.count(), 2)
        original.refresh_from_db()
        self.assertNotEqual(original.policy["definition"]["version"], "next-policy")

    def test_baseline_api_rejects_approval_without_current_quality_pass(self):
        review = self.review().json()["reviews"][0]
        QualityAssessment.objects.all().delete()
        response = self.client.post(
            self.url + "/baseline",
            {"review_id": review["id"], "baseline_version": 0},
            format="json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertFalse(self.state()["can_promote"])

    def test_corrupt_results_are_not_quality_failure_or_current_pass(self):
        self.promote()
        (self.root / str(self.run.pk) / "evaluation/comparison.json").write_text("broken")
        state = self.state()
        self.assertEqual(state["quality"]["status"], "NOT_EVALUATED")
        self.assertIsNone(state["quality"]["input_sha256"])
        self.assertFalse(state["can_promote"])
        self.assertEqual(state["quality"]["history"][0]["status"], "PASS")

    def test_fixture_change_rolls_back_when_baseline_audit_write_fails(self):
        self.promote()
        payload = self.fixture_payload("DEFERRED")
        before = self.state()
        with patch(
            "apps.evaluations.baselines.EvaluationBaselineChange.objects.create",
            side_effect=RuntimeError,
        ):
            with self.assertRaises(RuntimeError):
                self.client.post(self.url + "/fixture-review", payload, format="json")
        self.assertEqual(self.state(), before)


class ConcurrentQualityTests(ReviewFixture, TransactionTestCase):
    def test_fixture_revocation_racing_promotion_cannot_leave_an_invalid_baseline(self):
        review = self.review().json()["reviews"][0]
        material = review_material(self.run)
        fixture = FixtureReview.objects.get()
        barrier = Barrier(2)

        def action(kind):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                if kind == "revoke":
                    save_fixture_review(
                        self.run,
                        self.user,
                        "DEFERRED",
                        "근거 재검토",
                        material["fixture_sha256"],
                        fixture.case_ids,
                        fixture.rubric_version,
                        fixture.version,
                    )
                else:
                    try:
                        promote_baseline(self.run, self.user, review["id"], 0)
                    except RequestConflict:
                        pass
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(action, ["revoke", "promote"]))
        self.assertIsNone(EvaluationBaseline.objects.get(pk=self.dataset).review_id)
        self.assertFalse(quality_pass(self.run))

    def test_concurrent_assessment_stores_one_record(self):
        state = self.client.get(self.url + "/review").json()["quality"]
        barrier = Barrier(2)

        def action(_):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return assess(self.run, self.user, state["input_sha256"]).pk
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(action, range(2)))
        self.assertEqual(ids[0], ids[1])
        self.assertEqual(QualityAssessment.objects.count(), 1)


class QualityMigrationTests(TransactionTestCase):
    def test_existing_run_review_and_baseline_survive_without_invented_quality(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0009_execution_spec")]
        try:
            executor.migrate(old)
            apps = executor.loader.project_state(old).apps
            user = apps.get_model("auth", "User").objects.create(username="legacy")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                requested_by_id=user.pk,
                dataset_id="fixed-context-e01-v1",
                status="COMPLETED",
                execution_spec={"original": True},
                execution_spec_sha256=digest({"original": True}),
            )
            review = apps.get_model("evaluations", "EvaluationReview").objects.create(
                run_id=run.pk,
                reviewed_by_id=user.pk,
                decision="APPROVED",
                comment="과거 검토",
                capture_sha256="a" * 64,
            )
            apps.get_model("evaluations", "EvaluationBaseline").objects.create(
                dataset_id=run.dataset_id,
                review_id=review.pk,
                version=1,
                selected_by_id=user.pk,
            )
            executor = MigrationExecutor(connection)
            executor.migrate(latest)
            apps = executor.loader.project_state(latest).apps
            self.assertEqual(
                apps.get_model("evaluations", "EvaluationRun")
                .objects.get(pk=run.pk)
                .execution_spec,
                {"original": True},
            )
            self.assertEqual(
                apps.get_model("evaluations", "EvaluationBaseline").objects.get().review_id,
                review.pk,
            )
            self.assertFalse(apps.get_model("evaluations", "QualityAssessment").objects.exists())
            self.assertFalse(apps.get_model("evaluations", "FixtureReview").objects.exists())
        finally:
            MigrationExecutor(connection).migrate(latest)
