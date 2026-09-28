from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

from . import services
from .models import EvaluationBaseline, EvaluationBaselineChange, EvaluationRun
from .reviews import clear_baseline, promote_baseline
from .services import RequestConflict, ResultsUnavailable, submit_run
from .test_reviews import ReviewFixture


class BaselineTests(ReviewFixture, TransactionTestCase):
    def threaded(self, action):
        close_old_connections()
        try:
            return action()
        finally:
            close_old_connections()

    def submit(self, request_id=None):
        return submit_run(
            self.user,
            request_id or uuid4(),
            self.dataset,
            self.capture_id,
            f"run:{self.run.id}",
            baseline_version=1,
        )

    def test_history_clear_retry_and_stale_replacement(self):
        review = self.promote()
        promote_baseline(self.run, self.user, review["id"], 0)
        self.assertEqual(EvaluationBaselineChange.objects.count(), 1)
        response = self.client.delete(
            self.url + "/baseline",
            {"baseline_version": 1, "reason": "기준 오류 재검토"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["is_baseline"])
        self.assertEqual(response.json()["baseline_version"], 2)
        clear_baseline(self.run, self.user, 1, "기준 오류 재검토")
        self.assertEqual(EvaluationBaselineChange.objects.count(), 2)
        with self.assertRaises(RequestConflict):
            promote_baseline(self.run, self.user, review["id"], 1)
        promote_baseline(self.run, self.user, review["id"], 2)
        history = self.client.get(self.url + "/review").json()["baseline_history"]
        self.assertEqual([item["version"] for item in history], [3, 2, 1])
        self.assertEqual(history[1]["previous_run_id"], str(self.run.pk))
        self.assertIsNone(history[1]["run_id"])
        self.assertEqual(history[1]["reason"], "기준 오류 재검토")
        self.assertEqual(history[0]["capture_sha256"], review["capture_sha256"])

    def test_corrupted_baseline_can_be_explicitly_cleared_without_a_false_http_failure(self):
        self.promote()
        (self.root / str(self.run.id) / "capture/capture.json").write_text("broken")
        response = self.client.delete(
            self.url + "/baseline",
            {"baseline_version": 1, "reason": "결과 손상으로 해제"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["material"])
        self.assertFalse(response.json()["is_baseline"])
        self.assertEqual(response.json()["baseline_version"], 2)

    def test_two_initial_promotions_accept_one_version(self):
        first = self.review().json()["reviews"][0]["id"]
        other = self.completed_run()
        second = self.review(url=f"/api/v1/ops/evaluations/{other.id}").json()["reviews"][0]["id"]
        # 기준 행도 없는 최초 지정 경쟁을 재현한다.
        EvaluationBaseline.objects.all().delete()
        barrier = Barrier(2)

        def promote(pair):
            def action():
                barrier.wait(timeout=10)
                try:
                    promote_baseline(pair[0], self.user, pair[1], 0)
                    return "accepted"
                except RequestConflict:
                    return "conflict"

            return self.threaded(action)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(promote, [(self.run, first), (other, second)]))
        self.assertCountEqual(results, ["accepted", "conflict"])
        self.assertEqual(EvaluationBaselineChange.objects.count(), 1)
        self.assertEqual(EvaluationBaseline.objects.get(pk=self.dataset).version, 1)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_clear_commits_before_submission_rejects_old_reference(self, create):
        self.promote()
        prepared, proceed = Event(), Event()
        original = services.read_candidate

        def read(run):
            value = original(run)
            prepared.set()
            self.assertTrue(proceed.wait(10))
            return value

        with patch.object(services, "read_candidate", side_effect=read):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.threaded, self.submit)
                try:
                    self.assertTrue(prepared.wait(10))
                    clear_baseline(self.run, self.user, 1, "접수 전 철회")
                finally:
                    proceed.set()
                with self.assertRaises(ValueError):
                    future.result(timeout=10)
        create.assert_not_called()
        self.assertEqual(EvaluationRun.objects.count(), 1)

    def test_submission_commits_before_clear_pins_review_and_dispatches_outside_lock(self):
        review = self.promote()
        locked, release, clearing = Event(), Event(), Event()
        original = services.lock_baseline

        def lock(dataset):
            baseline = original(dataset)
            locked.set()
            self.assertTrue(release.wait(10))
            return baseline

        def clear():
            clearing.set()
            clear_baseline(self.run, self.user, 1, "접수 후 철회")

        def dispatch(run):
            self.assertFalse(connection.in_atomic_block)
            self.assertEqual(EvaluationRun.objects.get(pk=run.pk).baseline_review_id, review["id"])
            return uuid4()

        with (
            patch.object(services, "lock_baseline", side_effect=lock),
            patch("apps.evaluations.prefect_client.create_run", side_effect=dispatch),
        ):
            with ThreadPoolExecutor(max_workers=2) as pool:
                future = pool.submit(self.threaded, self.submit)
                try:
                    self.assertTrue(locked.wait(10))
                    revoke = pool.submit(self.threaded, clear)
                    self.assertTrue(clearing.wait(10))
                finally:
                    release.set()
                run, created = future.result(timeout=10)
                revoke.result(timeout=10)
        self.assertTrue(created)
        self.assertEqual(run.baseline_version, 1)
        self.assertEqual(run.baseline_review_id, review["id"])
        self.assertIsNone(EvaluationBaseline.objects.get(pk=self.dataset).review_id)
        with patch("apps.evaluations.prefect_client.create_run") as create:
            repeated, created = self.submit(run.pk)
        self.assertFalse(created)
        self.assertEqual(repeated.reference_config, run.reference_config)
        create.assert_not_called()

    def test_history_failure_rolls_back_baseline_change(self):
        review = self.promote()
        with patch.object(EvaluationBaselineChange.objects, "create", side_effect=RuntimeError):
            with self.assertRaises(RuntimeError):
                clear_baseline(self.run, self.user, 1, "실패 주입")
        baseline = EvaluationBaseline.objects.get(pk=self.dataset)
        self.assertEqual((baseline.version, baseline.review_id), (1, review["id"]))
        self.assertEqual(baseline.changes.count(), 1)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_result_invalidated_between_file_check_and_lock_cannot_be_selected(self, create):
        self.promote()
        original = services.read_candidate

        def read(run):
            result = original(run)
            EvaluationRun.objects.filter(pk=run.pk).update(status="RESULT_ERROR")
            return result

        with patch.object(services, "read_candidate", side_effect=read):
            with self.assertRaises(ResultsUnavailable):
                self.submit()
        create.assert_not_called()
        self.assertEqual(EvaluationRun.objects.count(), 1)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_accepted_request_survives_config_change_but_other_owner_cannot_retry(self, create):
        create.return_value = uuid4()
        self.promote()
        run, _ = self.submit()
        with patch("apps.evaluations.services.validate_execution", side_effect=ValueError):
            repeated, created = self.submit(run.pk)
            self.assertEqual(repeated.pk, run.pk)
            self.assertFalse(created)
        other = get_user_model().objects.create_user("other")
        with self.assertRaises(RequestConflict):
            submit_run(
                other,
                run.pk,
                self.dataset,
                self.capture_id,
                f"run:{self.run.pk}",
                baseline_version=1,
            )
        self.assertEqual(create.call_count, 1)


class BaselineMigrationTests(TransactionTestCase):
    def test_existing_selection_is_preserved_without_inventing_old_run_approval(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0006_evaluationrun_sync_attempted_at")]
        new = [("evaluations", "0007_baseline_versions")]
        try:
            executor.migrate(old)
            apps = executor.loader.project_state(old).apps
            user = apps.get_model("auth", "User").objects.create(username="legacy-reviewer")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                dataset_id="legacy", requested_by_id=user.pk
            )
            review = apps.get_model("evaluations", "EvaluationReview").objects.create(
                run_id=run.pk,
                reviewed_by_id=user.pk,
                decision="APPROVED",
                comment="과거 검토",
                capture_sha256="a" * 64,
            )
            baseline = apps.get_model("evaluations", "EvaluationBaseline").objects.create(
                dataset_id="legacy", review_id=review.pk, selected_by_id=user.pk
            )
            executor = MigrationExecutor(connection)
            executor.migrate(new)
            apps = executor.loader.project_state(new).apps
            preserved = apps.get_model("evaluations", "EvaluationBaseline").objects.get(pk="legacy")
            self.assertEqual((preserved.version, preserved.review_id), (1, review.pk))
            change = preserved.changes.get()
            self.assertEqual(change.created_at, baseline.selected_at)
            self.assertEqual(change.fixture_sha256, "")
            self.assertIsNone(change.previous_review_id)
            self.assertIsNone(
                apps.get_model("evaluations", "EvaluationRun")
                .objects.get(pk=run.pk)
                .baseline_review_id
            )
            self.assertEqual(
                apps.get_model("evaluations", "EvaluationReview").objects.get(pk=review.pk).comment,
                "과거 검토",
            )
        finally:
            MigrationExecutor(connection).migrate(latest)
