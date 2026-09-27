import json
import re
from hashlib import sha256

from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from . import prefect_client
from .catalog import DATASETS, LEGACY_DATASET_ID, selection
from .models import EvaluationRun

DATASET_ID = LEGACY_DATASET_ID
DATASET_LABEL = DATASETS[DATASET_ID]["label"]
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "CRASHED"}


class RequestConflict(Exception):
    pass


class ResultsUnavailable(Exception):
    pass


def submit_run(
    user, request_id, dataset_id, candidate_capture_id=DATASET_ID, reference_capture_id=DATASET_ID
):
    selection(dataset_id, candidate_capture_id, reference_capture_id)
    run, created = EvaluationRun.objects.get_or_create(
        id=request_id,
        defaults={
            "requested_by": user,
            "dataset_id": dataset_id,
            "candidate_capture_id": candidate_capture_id,
            "reference_capture_id": reference_capture_id,
        },
    )
    if (
        run.requested_by_id != user.pk
        or run.dataset_id != dataset_id
        or run.candidate_capture_id != candidate_capture_id
        or run.reference_capture_id != reference_capture_id
    ):
        raise RequestConflict
    if run.prefect_flow_run_id is None:
        # DB transaction 밖에서 전송한다. 응답 유실 후에도 같은 요청 키로 복구한다.
        try:
            flow_id = prefect_client.create_run(run)
        except prefect_client.PrefectUnavailable:
            EvaluationRun.objects.filter(pk=run.pk, prefect_flow_run_id=None).update(
                error_code="PREFECT_DISPATCH_UNCONFIRMED"
            )
        else:
            EvaluationRun.objects.filter(pk=run.pk, prefect_flow_run_id=None).update(
                prefect_flow_run_id=flow_id, status="QUEUED", error_code=""
            )
        run.refresh_from_db()
    return run, created


def artifact_path(run, name):
    root = settings.LLMOPS_RESULTS_DIR.resolve()
    path = (root / str(run.id) / name).resolve()
    if not path.is_relative_to(root / str(run.id)) or not path.is_file():
        raise ResultsUnavailable
    return path


def read_result(run):
    try:
        request = json.loads(artifact_path(run, "request.json").read_text())
        if (
            request["request_id"] != str(run.id)
            or request["dataset_id"] != run.dataset_id
            or request["prefect_flow_run_id"] != str(run.prefect_flow_run_id)
        ):
            raise ResultsUnavailable
        dataset, _, _ = selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )
        for name in ("candidate_capture_id", "reference_capture_id"):
            if request.get(name, LEGACY_DATASET_ID) != getattr(run, name):
                raise ResultsUnavailable
        manifest = json.loads(artifact_path(run, "evaluation/manifest.json").read_text())
        comparison = json.loads(artifact_path(run, "evaluation/comparison.json").read_text())
        if (
            manifest["status"] != "completed"
            or not re.fullmatch(r"[a-f0-9]{32}", manifest["evaluation_run_id"])
            or manifest["evaluation_run_id"] != comparison["evaluation_run_id"]
            or manifest["model_api_calls"] != 0
            or comparison["current"]["completed"] is not True
        ):
            raise ResultsUnavailable
        report = artifact_path(run, "evaluation/report.html")
        if sha256(report.read_bytes()).hexdigest() != manifest["artifact_sha256"]["report.html"]:
            raise ResultsUnavailable
        verified_comparison = {}
        if comparison.get("schema_version") == 2:
            comparison_path = artifact_path(run, "evaluation/comparison.json")
            if (
                sha256(comparison_path.read_bytes()).hexdigest()
                != manifest["artifact_sha256"]["comparison.json"]
                or comparison["reference_run_id"] != manifest["reference_run_id"]
                or comparison["fixture_sha256"] != manifest["fixture_sha256"]
                or comparison["case_ids"] != dataset["case_ids"]
                or comparison["reference"]["completed"] is not True
                or comparison["candidate_execution"]["run_id"] != comparison["evaluation_run_id"]
                or comparison["reference_execution"]["run_id"] != comparison["reference_run_id"]
            ):
                raise ResultsUnavailable
            verified_comparison = comparison
        elif (
            "schema_version" in comparison
            or "candidate_capture_id" in request
            or "reference_capture_id" in request
            or "comparison.json" in manifest["artifact_sha256"]
            or (run.dataset_id, run.candidate_capture_id, run.reference_capture_id)
            != (LEGACY_DATASET_ID,) * 3
        ):
            raise ResultsUnavailable
        return manifest["evaluation_run_id"], comparison["current"], report, verified_comparison
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ResultsUnavailable from exc


def sync_run(run):
    if run.prefect_flow_run_id is None or (run.status in TERMINAL and not run.error_code):
        return run
    try:
        remote = prefect_client.read_run(run.prefect_flow_run_id)
        state = remote["state_type"]
        status = {
            "SCHEDULED": "QUEUED",
            "PENDING": "QUEUED",
            "RUNNING": "RUNNING",
            "COMPLETED": "COMPLETED",
            "FAILED": "FAILED",
            "CANCELLED": "CANCELLED",
            "CRASHED": "CRASHED",
            "CANCELLING": "RUNNING",
            "PAUSED": "QUEUED",
        }.get(state)
        if status is None:
            raise prefect_client.PrefectUnavailable
        values = {"status": status, "synced_at": timezone.now(), "error_code": ""}
        for source, target in [("start_time", "started_at"), ("end_time", "finished_at")]:
            value = remote.get(source)
            values[target] = parse_datetime(value) if isinstance(value, str) else None
        if status == "COMPLETED":
            try:
                evaluation_id, summary, _, comparison = read_result(run)
                values.update(
                    evaluation_run_id=evaluation_id, summary=summary, comparison=comparison
                )
            except ResultsUnavailable:
                # Prefect만 완료되고 보고서를 읽지 못하면 Ops 완료로 표시하지 않는다.
                values.update(status="RESULT_ERROR", error_code="RESULTS_UNAVAILABLE")
        elif status in TERMINAL:
            values["error_code"] = f"EVALUATION_{status}"
    except (prefect_client.PrefectUnavailable, ValueError, TypeError):
        values = {"error_code": "PREFECT_STATUS_UNAVAILABLE"}
    # 동시에 조회한 오래된 RUNNING 응답이 이미 완료된 상태를 되돌리지 않도록 한다.
    EvaluationRun.objects.filter(pk=run.pk, status=run.status, synced_at=run.synced_at).update(
        **values
    )
    run.refresh_from_db()
    return run
