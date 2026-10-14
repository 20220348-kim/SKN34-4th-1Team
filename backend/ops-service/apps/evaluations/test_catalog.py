import os
from copy import deepcopy
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from .catalog import (
    DATASETS,
    LEGACY_DATASET_ID,
    LIVE_CAPTURE_ID,
    allowed_models,
    live_config,
    public_datasets,
    validate_execution,
)
from .execution_spec import digest, profile, read_release
from .views import api_evaluation_catalog

RAG = "rag-synthetic-multichunk-v1"


class LiveModelCatalogTests(SimpleTestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"LLMOPS_LIVE_MODEL": "gpt-6-luna"})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("LLMOPS_ALLOWED_MODELS", None)
        cache = patch("apps.evaluations.vector_cache.discover", return_value=None)
        self.cache_lookup = cache.start()
        self.addCleanup(cache.stop)

    def test_default_and_explicit_model_choices_keep_configured_model_first(self):
        self.assertEqual(allowed_models(), ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-luna"])
        with patch.dict(os.environ, {"LLMOPS_ALLOWED_MODELS": " gpt-6-sol, gpt-6-sol "}):
            self.assertEqual(allowed_models(), ["gpt-6-luna", "gpt-6-sol"])
        with patch.dict(os.environ, {"LLMOPS_ALLOWED_MODELS": "gpt-6-luna"}):
            self.assertEqual(allowed_models(), ["gpt-6-luna"])

    def test_invalid_operator_configuration_fails_explicitly(self):
        for value in ("", "gpt-6-sol,", "gpt 6 sol", "gpt-6-sol,,gpt-6-luna", "x" * 201):
            with (
                self.subTest(value=value),
                patch.dict(os.environ, {"LLMOPS_ALLOWED_MODELS": value}),
            ):
                with self.assertRaises(ValueError):
                    allowed_models()

    def test_each_model_has_its_own_immutable_execution_profile(self):
        release = read_release()
        datasets = {row["id"]: row for row in public_datasets()}
        for dataset_id in (LEGACY_DATASET_ID, RAG):
            row = datasets[dataset_id]
            options = row["live_options"]
            self.assertEqual(len({item["execution_profile"] for item in options}), 3)
            self.assertEqual(options[0]["live_config"], row["live_config"])
            self.assertEqual(options[0]["execution_profile"], row["execution_profiles"]["live"])
            for option in options:
                config = option["live_config"]
                self.assertEqual(config, live_config(dataset_id, model=config["model"]))
                spec = profile(release, dataset_id, "live", config)
                self.assertEqual(option["execution_profile"], digest(spec))
                self.assertEqual(
                    {
                        item["model"]
                        for item in spec["model_operations"]
                        if item["kind"] == "answer"
                    },
                    {config["model"]},
                )
        replay_only = next(row for row in datasets.values() if row["live_config"] is None)
        self.assertEqual(replay_only["live_options"], [])
        self.assertIsNone(replay_only["execution_profiles"]["live"])

    def test_selected_model_preserves_budget_fixture_and_embedding_plan(self):
        for dataset_id in (LEGACY_DATASET_ID, RAG):
            original = live_config(dataset_id)
            config = live_config(dataset_id, model="gpt-6-sol")
            self.assertEqual({**original, "model": "gpt-6-sol"}, config)
            reference = DATASETS[dataset_id]["captures"][0]["id"]
            self.assertEqual(
                validate_execution(dataset_id, LIVE_CAPTURE_ID, reference, "live", config)[0]["id"],
                dataset_id,
            )
            altered = deepcopy(config)
            altered["max_output_tokens"] += 1
            with self.assertRaises(ValueError):
                validate_execution(dataset_id, LIVE_CAPTURE_ID, reference, "live", altered)

    def test_unknown_or_removed_models_are_rejected_for_api_and_runner(self):
        config = live_config(LEGACY_DATASET_ID, model="gpt-6-sol")
        for pinned in (False, True):
            with patch.dict(os.environ, {"LLMOPS_ALLOWED_MODELS": "gpt-6-luna"}):
                with self.assertRaises(ValueError):
                    validate_execution(
                        LEGACY_DATASET_ID,
                        LIVE_CAPTURE_ID,
                        LEGACY_DATASET_ID,
                        "live",
                        config,
                        pinned_vectors=pinned,
                    )
        for model in ("unapproved-model", " gpt-6-luna", [], None):
            with self.subTest(model=model), self.assertRaises(ValueError):
                validate_execution(
                    LEGACY_DATASET_ID,
                    LIVE_CAPTURE_ID,
                    LEGACY_DATASET_ID,
                    "live",
                    {**config, "model": model},
                )

    def test_runner_uses_pinned_vectors_with_selected_model_after_cache_change(self):
        config = live_config(RAG, model="gpt-6-sol")
        self.cache_lookup.return_value = "b" * 64
        reference = DATASETS[RAG]["captures"][0]["id"]
        validate_execution(RAG, LIVE_CAPTURE_ID, reference, "live", config, pinned_vectors=True)
        with self.assertRaises(ValueError):
            validate_execution(RAG, LIVE_CAPTURE_ID, reference, "live", config)


class DatasetSelectionGuideTests(SimpleTestCase):
    def setUp(self):
        # 이 테스트는 기존 파일 카탈로그 계약만 확인한다. DB 자료는 별도 통합 테스트 대상이다.
        managed = patch("apps.evaluations.catalog.managed_datasets", return_value=[])
        managed.start()
        self.addCleanup(managed.stop)

    def catalog(self, *, authenticated=True):
        request = APIRequestFactory().get("/api/v1/ops/evaluation-catalog")
        if authenticated:
            force_authenticate(request, user=get_user_model()(username="offline-operator"))
        return api_evaluation_catalog(request)

    @patch("apps.evaluations.vector_cache.discover", return_value=None)
    @patch("apps.evaluations.views.baseline_choices", return_value={})
    def test_catalog_groups_every_registered_dataset_and_preserves_execution_contract(
        self, baselines, cache
    ):
        expected = {
            "target-coverage-20260907-v1": "development",
            "fixed-context-e01-v1": "historical",
            "rag-synthetic-multichunk-v1": "development",
            "core-rag-20261002-v1": "development",
            "core-rag-20261002-v2": "development",
            "official-answer-20260907-v2": "historical",
            "official-answer-20260907-v3": "quality",
            "official-rag-20261006-v1": "historical",
            "official-rag-20261006-v2": "quality",
            "core-official-640f14b8cf87bd9e5d3f2319": "historical",
        }
        original = {row["id"]: row for row in public_datasets()}
        response = self.catalog()
        self.assertEqual(response.status_code, 200)
        rows = response.data["datasets"]
        self.assertEqual({row["id"] for row in rows}, set(expected))
        for row in rows:
            with self.subTest(dataset=row["id"]):
                guide = row["selection_guide"]
                self.assertEqual(guide, DATASETS[row["id"]]["selection_guide"])
                self.assertEqual(guide["category"], expected[row["id"]])
                self.assertEqual(
                    set(guide), {"category", "title", "purpose", "material", "limitations"}
                )
                for value in guide.values():
                    self.assertIsInstance(value, str)
                    self.assertTrue(value.strip())
                self.assertEqual(
                    {
                        key: value
                        for key, value in row.items()
                        if key not in {"selection_guide", "baseline"}
                    },
                    original[row["id"]],
                )

    @patch("apps.evaluations.views.baseline_choices", return_value={})
    def test_missing_guidance_and_unknown_catalog_rows_have_no_invented_category(self, baselines):
        original = {"id": LEGACY_DATASET_ID, "label": "기존 자료"}
        unknown = {"id": "newly-registered", "label": "새 자료"}
        with (
            patch("apps.evaluations.views.public_datasets", return_value=[original, unknown]),
            patch("apps.evaluations.views.DATASETS", {LEGACY_DATASET_ID: original}),
        ):
            response = self.catalog()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["datasets"],
            [
                {**original, "selection_guide": None, "baseline": None},
                {**unknown, "selection_guide": None, "baseline": None},
            ],
        )

    @patch("apps.evaluations.views.public_datasets")
    @patch("apps.evaluations.views.baseline_choices")
    def test_anonymous_catalog_does_not_expose_dataset_guidance(self, baselines, datasets):
        response = self.catalog(authenticated=False)
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("datasets", response.data)
        datasets.assert_not_called()
        baselines.assert_not_called()

    @patch("apps.evaluations.vector_cache.discover", return_value=None)
    def test_display_guidance_does_not_change_execution_options_or_approval_profiles(self, cache):
        original = public_datasets()
        without_guidance = deepcopy(DATASETS)
        for item in without_guidance.values():
            item.pop("selection_guide")
        with patch.dict(DATASETS, without_guidance, clear=True):
            self.assertEqual(public_datasets(), original)
