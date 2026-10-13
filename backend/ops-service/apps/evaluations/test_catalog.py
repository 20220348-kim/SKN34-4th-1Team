import os
from copy import deepcopy
from unittest.mock import patch

from django.test import SimpleTestCase

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
