import json
import re
from datetime import timedelta
from hashlib import sha256

from django.conf import settings
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from . import prefect_client
from .baselines import lock_baseline
from .catalog import (
    DATASETS,
    LEGACY_DATASET_ID,
    reference_run_id,
    selection,
    validate_execution,
    validate_reference_config,
)
from .execution_spec import digest, make_spec, read_release
from .models import EvaluationBaseline, EvaluationRun
from .review_eligibility import current_approval

DATASET_ID = LEGACY_DATASET_ID
DATASET_LABEL = DATASETS[DATASET_ID]["label"]
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "CRASHED"}
PENDING_SYNC = {"REQUESTED", "QUEUED", "RUNNING", "RESULT_ERROR"}


class RequestConflict(Exception):
    pass


class ResultsUnavailable(Exception):
    pass


def submit_run(
    user,
    request_id,
    dataset_id,
    candidate_capture_id=DATASET_ID,
    reference_capture_id=DATASET_ID,
    execution_mode="replay",
    live_config=None,
    confirm_paid_run=False,
    baseline_version=None,
    execution_profile=None,
):
    config = live_config or {}

    def check_request(run):
        if (
            run.requested_by_id != user.pk
            or run.dataset_id != dataset_id
            or run.candidate_capture_id != candidate_capture_id
            or run.reference_capture_id != reference_capture_id
            or run.execution_mode != execution_mode
            or run.live_config != config
            or run.baseline_version != baseline_version
            or run.execution_spec.get("profile_sha256") != execution_profile
        ):
            raise RequestConflict

    existing = EvaluationRun.objects.filter(pk=request_id).first()
    if existing:
        check_request(existing)
        return dispatch_run(existing), False

    # 파일 검증은 잠금 밖에서 수행하고 기준 버전·승인 기록을 잠금 안에서 재확인한다.
    prepared_baseline = None
    capture_hash = None
    if reference_capture_id.startswith("run:"):
        prepared_baseline = (
            EvaluationBaseline.objects.select_related("review__run")
            .filter(dataset_id=dataset_id, review__run_id=reference_run_id(reference_capture_id))
            .first()
        )
        if prepared_baseline is not None:
            _, capture_hash, _ = read_candidate(prepared_baseline.review.run)
            if capture_hash != prepared_baseline.review.capture_sha256:
                raise ResultsUnavailable

    with transaction.atomic():
        baseline = lock_baseline(dataset_id)
        existing = EvaluationRun.objects.filter(pk=request_id).first()
        if existing:
            check_request(existing)
            run, created = existing, False
        else:
            validate_execution(
                dataset_id, candidate_capture_id, reference_capture_id, execution_mode, config
            )
            if execution_mode == "live" and (
                not settings.LLMOPS_LIVE_ENABLED or not confirm_paid_run
            ):
                raise ValueError("새 모델 평가는 활성화와 전송 자료·호출 예산 확인이 필요합니다.")
            reference_config = {}
            if reference_capture_id.startswith("run:"):
                if (
                    prepared_baseline is None
                    or baseline.review_id != prepared_baseline.review_id
                    or baseline.version != baseline_version
                    or baseline.version != prepared_baseline.version
                ):
                    raise ValueError("현재 자료의 검토 기준이 변경되었습니다. 다시 선택하세요.")
                source = EvaluationRun.objects.select_for_update().get(
                    pk=prepared_baseline.review.run_id
                )
                if source.status != "COMPLETED":
                    raise ResultsUnavailable
                if not current_approval(prepared_baseline.review, source):
                    raise ValueError("기준의 사례별 검토가 필요합니다. 다시 선택하세요.")
                from .quality import quality_pass

                if not quality_pass(source):
                    raise ValueError("기준의 유효한 품질 판정이 필요합니다. 다시 선택하세요.")
                reference_config = {
                    "run_id": str(prepared_baseline.review.run_id),
                    "capture_sha256": capture_hash,
                    "fixture_sha256": DATASETS[dataset_id]["fixture_sha256"],
                }
            elif baseline_version is not None:
                raise ValueError("저장 캡처에는 검토 기준 버전을 지정할 수 없습니다.")
            validate_reference_config(dataset_id, reference_capture_id, reference_config)
            spec = make_spec(
                read_release(),
                dataset_id,
                execution_mode,
                config,
                candidate_capture_id,
                reference_capture_id,
                reference_config,
                baseline_version,
                baseline.review_id if reference_config else None,
            )
            if execution_profile != spec["profile_sha256"]:
                raise ValueError("실행 명세가 변경되었습니다. 새로고침 후 다시 확인하세요.")
            run, created = EvaluationRun.objects.get_or_create(
                id=request_id,
                defaults={
                    "requested_by": user,
                    "dataset_id": dataset_id,
                    "candidate_capture_id": candidate_capture_id,
                    "reference_capture_id": reference_capture_id,
                    "reference_config": reference_config,
                    "baseline_version": baseline_version,
                    "baseline_review_id": baseline.review_id if reference_config else None,
                    "execution_mode": execution_mode,
                    "live_config": config,
                    "execution_spec": spec,
                    "execution_spec_sha256": digest(spec),
                    "model_api_calls": None if execution_mode == "live" else 0,
                },
            )
            check_request(run)
    # 외부 전송은 기준 검증과 접수를 커밋한 다음 수행한다.
    return dispatch_run(run), created


def dispatch_run(run):
    if not run.execution_spec and run.prefect_flow_run_id is None:
        # 기존 접수의 응답 유실 여부를 확인할 수 있으므로 호출 수는 추정하지 않는다.
        EvaluationRun.objects.filter(pk=run.pk, prefect_flow_run_id=None).update(
            error_code="EXECUTION_SPEC_REQUIRED"
        )
        run.refresh_from_db()
        return run
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
    return run


def artifact_path(run, name):
    root = settings.LLMOPS_RESULTS_DIR.resolve()
    path = (root / str(run.id) / name).resolve()
    if not path.is_relative_to(root / str(run.id)) or not path.is_file():
        raise ResultsUnavailable
    return path


def read_request(run):
    request = json.loads(artifact_path(run, "request.json").read_text())
    if (
        request["request_id"] != str(run.id)
        or request["dataset_id"] != run.dataset_id
        or request["prefect_flow_run_id"] != str(run.prefect_flow_run_id)
        or request.get("execution_mode", "replay") != run.execution_mode
        or request.get("live_config", {}) != run.live_config
        or request.get("reference_config", {}) != run.reference_config
        or request.get("recovery_config", {}) != run.recovery_config
        or request.get("execution_spec", {}) != run.execution_spec
        or request.get("execution_spec_sha256", "") != run.execution_spec_sha256
        or (bool(run.execution_spec) and digest(run.execution_spec) != run.execution_spec_sha256)
    ):
        raise ResultsUnavailable
    for name in ("candidate_capture_id", "reference_capture_id"):
        if request.get(name, LEGACY_DATASET_ID) != getattr(run, name):
            raise ResultsUnavailable
    return request


def read_live_capture(run):
    read_request(run)
    path = artifact_path(run, "capture/capture.json")
    capture = json.loads(path.read_text())
    config = run.live_config
    calls = capture["modelApiCalls"]
    if (
        capture["model"] != config["model"]
        or capture["fixtureSha256"] != config["fixture_sha256"]
        or capture["caseIds"]
        != run.execution_spec.get("dataset", DATASETS[run.dataset_id])["case_ids"]
        or capture["maxModelCalls"] != config["max_model_calls"]
        or capture["maxOutputTokens"] != config["max_output_tokens"]
        or type(calls) is not int
        or not 0 <= calls <= config["max_model_calls"]
    ):
        raise ResultsUnavailable
    if run.execution_spec:
        generation = run.execution_spec["generation"]
        if (
            capture["promptSha256"] != generation["prompt_sha256"]
            or capture["runnerSha256"]
            != generation["files"]["evaluation/support-program-evidence/evaluate.py"]
            or capture["modelTimeoutSeconds"] != generation["settings"]["model_timeout_seconds"]
            or capture["runTimeoutSeconds"] != generation["settings"]["run_timeout_seconds"]
        ):
            raise ResultsUnavailable
    return capture, sha256(path.read_bytes()).hexdigest()


def read_result(run):
    try:
        request = read_request(run)
        dataset, _, _ = selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )
        dataset = run.execution_spec.get("dataset", dataset)
        manifest = json.loads(artifact_path(run, "evaluation/manifest.json").read_text())
        comparison = json.loads(artifact_path(run, "evaluation/comparison.json").read_text())
        if run.execution_spec and (
            manifest.get("execution_spec_sha256") != run.execution_spec_sha256
            or manifest.get("evaluator_version") != run.execution_spec["evaluation"]["version"]
            or manifest.get("fixture_sha256") != run.execution_spec["dataset"]["fixture_sha256"]
            or (
                run.execution_mode != "live"
                and manifest.get("capture_sha256") != run.execution_spec["candidate_sha256"]
            )
            or manifest.get("reference_capture_sha256") != run.execution_spec["reference_sha256"]
            or comparison.get("case_ids") != run.execution_spec["dataset"]["case_ids"]
        ):
            raise ResultsUnavailable
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
        if run.execution_mode == "live":
            capture, capture_hash = read_live_capture(run)
            if (
                capture["completed"] is not True
                or capture["modelApiCalls"] != run.live_config["max_model_calls"]
                or capture_hash != manifest["capture_sha256"]
                or comparison.get("schema_version") != 2
                or comparison["candidate_execution"]["capture_sha256"] != capture_hash
                or comparison["candidate_execution"]["model"] != run.live_config["model"]
                or manifest["fixture_sha256"] != run.live_config["fixture_sha256"]
            ):
                raise ResultsUnavailable
        if run.execution_mode == "recovery":
            config = run.recovery_config
            if (
                str(run.source_run_id) != config["source_run_id"]
                or manifest["capture_sha256"] != config["capture_sha256"]
                or manifest["reference_capture_sha256"] != config["reference_capture_sha256"]
                or manifest["fixture_sha256"] != config["fixture_sha256"]
                or comparison.get("schema_version") != 2
                or comparison["candidate_execution"]["capture_sha256"] != config["capture_sha256"]
                or comparison["reference_execution"]["capture_sha256"]
                != config["reference_capture_sha256"]
                or sha256(artifact_path(run, "capture/capture.json").read_bytes()).hexdigest()
                != config["capture_sha256"]
                or sha256(artifact_path(run, "reference-capture.json").read_bytes()).hexdigest()
                != config["reference_capture_sha256"]
                or sha256(artifact_path(run, "recovery-fixture.json").read_bytes()).hexdigest()
                != config["fixture_sha256"]
            ):
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
            if run.reference_config:
                validate_reference_config(
                    run.dataset_id, run.reference_capture_id, run.reference_config
                )
                if (
                    manifest["reference_capture_sha256"] != run.reference_config["capture_sha256"]
                    or comparison["reference_execution"]["capture_sha256"]
                    != run.reference_config["capture_sha256"]
                    or manifest["fixture_sha256"] != run.reference_config["fixture_sha256"]
                ):
                    raise ResultsUnavailable
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


def evidence_path(name):
    root = settings.LLMOPS_EVIDENCE_DIR.resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ResultsUnavailable
    return path


def read_candidate(run):
    """검토와 기준 지정에 쓰는 실제 응답을 완료 보고서의 해시와 대조한다."""
    try:
        if run.status != "COMPLETED":
            raise ResultsUnavailable
        _, _, _, comparison = read_result(run)
        if not comparison:
            raise ResultsUnavailable
        dataset, candidate, _ = selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )
        path = (
            artifact_path(run, "capture/capture.json")
            if run.execution_mode in {"live", "recovery"}
            else evidence_path(candidate["path"])
        )
        raw = path.read_bytes()
        capture = json.loads(raw)
        capture_hash = sha256(raw).hexdigest()
        if (
            capture_hash != comparison["candidate_execution"]["capture_sha256"]
            or capture["completed"] is not True
            or capture["fixtureSha256"] != dataset["fixture_sha256"]
            or comparison["fixture_sha256"] != dataset["fixture_sha256"]
        ):
            raise ResultsUnavailable
        return capture, capture_hash, comparison
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ResultsUnavailable from exc


def sync_run(run):
    if run.status == "COMPLETED" and not run.error_code:
        try:
            read_result(run)
        except ResultsUnavailable:
            EvaluationRun.objects.filter(pk=run.pk, status="COMPLETED").update(
                status="RESULT_ERROR", error_code="RESULTS_UNAVAILABLE"
            )
            run.refresh_from_db()
        return run
    if run.status in TERMINAL and not run.error_code:
        return run
    observed = {
        "pk": run.pk,
        "status": run.status,
        "synced_at": run.synced_at,
        "sync_attempted_at": run.sync_attempted_at,
        "prefect_flow_run_id": run.prefect_flow_run_id,
    }
    values = {"sync_attempted_at": timezone.now()}
    try:
        flow_id = run.prefect_flow_run_id or prefect_client.find_run(run)
        if flow_id is None:
            values["error_code"] = (
                "PREFECT_DISPATCH_UNCONFIRMED" if run.execution_spec else "EXECUTION_SPEC_REQUIRED"
            )
        else:
            run.prefect_flow_run_id = flow_id
            values["prefect_flow_run_id"] = flow_id
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
            values.update(status=status, synced_at=timezone.now(), error_code="")
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
    except (prefect_client.PrefectUnavailable, ValueError, TypeError, KeyError):
        values = {
            "sync_attempted_at": values["sync_attempted_at"],
            "error_code": "PREFECT_STATUS_UNAVAILABLE",
            "prefect_flow_run_id": run.prefect_flow_run_id,
        }
    if run.execution_mode == "live":
        try:
            capture, _ = read_live_capture(run)
            values["model_api_calls"] = capture["modelApiCalls"]
        except (ResultsUnavailable, OSError, ValueError, KeyError, TypeError):
            # 파일이 없거나 확인할 수 없는 호출 수를 0으로 표시하지 않는다.
            pass
    if values.get("status") in TERMINAL and values.get("status") != "COMPLETED":
        try:
            read_request(run)
            preflight = json.loads(artifact_path(run, "preflight.json").read_text())
            if (
                preflight["phase"] == "before_model_call"
                and type(preflight["model_api_calls"]) is int
                and preflight["model_api_calls"] == 0
                and preflight["execution_spec_sha256"] == run.execution_spec_sha256
                and preflight["error_code"]
                in {"EXECUTION_SPEC_MISMATCH", "EXECUTION_SPEC_REQUIRED"}
            ):
                values.update(error_code=preflight["error_code"], model_api_calls=0)
        except (ResultsUnavailable, OSError, ValueError, KeyError, TypeError):
            pass
    # 동시에 조회한 오래된 RUNNING 응답이 이미 완료된 상태를 되돌리지 않도록 한다.
    EvaluationRun.objects.filter(**observed).update(**values)
    run.refresh_from_db()
    return run


def sync_pending_runs(*, batch_size=25, interval_seconds=10):
    """오래 확인하지 않은 미완료 실행을 제한된 수만 조회한다. 새 실행은 만들지 않는다."""
    cutoff = timezone.now() - timedelta(seconds=interval_seconds)
    runs = list(
        EvaluationRun.objects.filter(
            Q(status__in=PENDING_SYNC) | Q(error_code="PREFECT_STATUS_UNAVAILABLE"),
            Q(sync_attempted_at__isnull=True) | Q(sync_attempted_at__lte=cutoff),
        ).order_by(F("sync_attempted_at").asc(nulls_first=True), "created_at", "id")[:batch_size]
    )
    for run in runs:
        sync_run(run)
    return len(runs)
