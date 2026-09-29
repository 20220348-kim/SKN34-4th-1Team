"""Read-only deployment diagnostics; never starts an evaluation or repairs files."""

import os
from hashlib import sha256
from pathlib import Path
from urllib.parse import quote, urlsplit
from uuid import UUID

from django.conf import settings
from django.db import DatabaseError

from . import prefect_client
from .catalog import DATASETS
from .execution_spec import read_release


def check_evidence():
    root = Path(settings.LLMOPS_EVIDENCE_DIR).resolve(strict=True)
    pinned = read_release()["datasets"]
    if set(pinned) != set(DATASETS):
        return False
    for dataset_id, dataset in DATASETS.items():
        expected = pinned[dataset_id]
        if (
            expected["fixture_sha256"] != dataset["fixture_sha256"]
            or expected["case_ids"] != dataset["case_ids"]
            or set(expected["captures"]) != {item["id"] for item in dataset["captures"]}
        ):
            return False
        files = [(dataset["fixture"], expected["fixture_sha256"])]
        files.extend(
            (item["path"], expected["captures"][item["id"]]) for item in dataset["captures"]
        )
        for name, fingerprint in files:
            path = (root / name).resolve(strict=True)
            if not path.is_relative_to(root) or not path.is_file():
                return False
            # Bound local reads even when a mounted file has been replaced.
            with path.open("rb") as source:
                payload = source.read(8 * 1024 * 1024 + 1)
            if len(payload) > 8 * 1024 * 1024 or sha256(payload).hexdigest() != fingerprint:
                return False
    return True


def inspect_runtime(run_id=None):
    checks = {}
    try:
        checks["evidence"] = "PASS" if check_evidence() else "FAIL"
    except (OSError, ValueError, KeyError, TypeError):
        checks["evidence"] = "FAIL"
    try:
        # Ops only reads runner output. Do not create a directory or test-write here.
        with os.scandir(settings.LLMOPS_RESULTS_DIR) as entries:
            next(entries, None)
        checks["results_directory"] = "PASS"
    except OSError:
        checks["results_directory"] = "FAIL"
    try:
        endpoint = urlsplit(settings.PREFECT_API_URL)
        if (
            endpoint.scheme not in {"http", "https"}
            or not endpoint.hostname
            or endpoint.hostname.endswith(".invalid")
            or endpoint.username
            or endpoint.password
            or endpoint.query
            or endpoint.fragment
        ):
            raise ValueError("Prefect is not configured")
        deployment = prefect_client.request_json(
            "/deployments/name/" + quote(settings.PREFECT_DEPLOYMENT_NAME, safe="/")
        )
        UUID(str(deployment["id"]))
        UUID(str(deployment["flow_id"]))
        if (
            deployment["name"] != settings.PREFECT_DEPLOYMENT_NAME.rsplit("/", 1)[1]
            or deployment["paused"] is not False
        ):
            raise ValueError("Expected an unpaused deployment")
        checks["prefect_deployment"] = "PASS"
    except (prefect_client.PrefectUnavailable, ValueError, KeyError, TypeError):
        checks["prefect_deployment"] = "FAIL"
    checks["result_artifact"] = "NOT_CHECKED"
    if run_id is not None:
        from .models import EvaluationRun
        from .services import ResultsUnavailable, read_result

        try:
            run = EvaluationRun.objects.get(pk=run_id)
            if run.status != "COMPLETED":
                raise ResultsUnavailable
            read_result(run)
            checks["result_artifact"] = "PASS"
        except (EvaluationRun.DoesNotExist, DatabaseError, ResultsUnavailable):
            checks["result_artifact"] = "FAIL"
    return {
        "scope": "deployment_configuration",
        "status": "FAIL" if "FAIL" in checks.values() else "PASS",
        "checks": checks,
        "evaluation_executed": False,
        "runner_liveness_verified": False,
        "shared_volume_identity_verified": False,
        "result_artifact_verified": checks["result_artifact"] == "PASS",
    }
