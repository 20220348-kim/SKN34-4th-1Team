"""저장된 실측 결과를 같은 평가 조건끼리 묶는 읽기 전용 대시보드."""

import math
import os
import re

from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .catalog import DATASETS
from .execution_spec import digest
from .models import EvaluationRun

RUN_LIMIT = 200
FIXED_SCOPE = "fixed-answer-context-only"
RAG_SCOPE = "source-chunks-retrieval-answer"
METRICS = ("status", "citation", "retrieval", "latency", "input_tokens", "output_tokens")


def number(value, *, rate=False):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return None
    return value if not rate or value <= 1 else None


def fingerprint(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def measurement(run):
    """replay는 새 실측으로 세지 않는다. 복구는 원본 live 실행 시각에 귀속한다."""
    origin = run.source_run if run.execution_mode == "recovery" else run
    if origin is None or origin.execution_mode != "live":
        return None
    comparison = run.comparison
    scope = comparison.get("scope")
    fixture = comparison.get("fixture_sha256")
    case_ids = comparison.get("case_ids")
    evaluator = run.execution_spec.get("evaluation", {}).get("version")
    if (
        not fingerprint(fixture)
        or not fingerprint(evaluator)
        or not isinstance(case_ids, list)
        or not case_ids
        or any(not isinstance(case, str) for case in case_ids)
        or len(set(case_ids)) != len(case_ids)
    ):
        return None
    values = dict.fromkeys(METRICS)
    samples = dict.fromkeys(METRICS)
    # 같은 평균이라도 측정 사례가 다르면 전회 대비 차이를 표시하지 않는다.
    coverage = dict.fromkeys(METRICS)
    retrieval_k = None
    if scope == FIXED_SCOPE and comparison.get("schema_version") == 2:
        execution = comparison.get("candidate_execution", {})
        model = execution.get("model")
        capture = execution.get("capture_sha256")
        prompt = execution.get("prompt_sha256")
        metrics = {row["key"]: row.get("candidate") for row in comparison.get("metrics", [])}
        cases = comparison.get("cases", [])
        for key, source, field in (
            ("status", "statusAccuracy", "status_match"),
            ("citation", "referenceCitationRecall", "citation_recall"),
        ):
            values[key] = number(metrics.get(source), rate=True)
            measured = sorted(
                row["case_id"]
                for row in cases
                if number(row.get("candidate", {}).get(field), rate=True) is not None
            )
            samples[key] = len(measured)
            coverage[key] = digest(measured)
        for key, source in (
            ("latency", "meanLatencyMs"),
            ("input_tokens", "meanInputTokens"),
            ("output_tokens", "meanOutputTokens"),
        ):
            values[key] = number(metrics.get(source))
        # 저장 요약은 지연·토큰 평균의 표본 수를 보존하지 않아 추이 차이는 계산하지 않는다.
    elif scope == RAG_SCOPE and comparison.get("schema_version") == 3:
        report = comparison.get("current", {})
        if (
            report.get("measurementKind")
            not in {"recorded-live-evaluation", "recorded-capture-replay"}
            or report.get("completed") is not True
        ):
            return None
        execution = report.get("execution", {})
        model = execution.get("model")
        capture = report.get("captureSha256")
        prompt = execution.get("promptSha256")
        cases = report.get("cases", [])
        retrieval_k = sorted((row["caseId"], row.get("k")) for row in cases)
        for key, source, field in (
            ("status", "answerStatusAccuracy", "answerStatusMatches"),
            ("citation", "answerCitationRecall", "answerCitationRecall"),
            ("retrieval", "retrievalRecallAtK", "retrievalRecallAtK"),
        ):
            metric = report.get("metrics", {}).get(source, {})
            values[key] = number(metric.get("value"), rate=True)
            samples[key] = number(metric.get("measuredCaseCount"))
            coverage[key] = digest(
                sorted(row["caseId"] for row in cases if row.get(field) is not None)
            )
    else:
        return None
    if not model or model != origin.live_config.get("model") or not fingerprint(capture):
        return None
    group = {
        "dataset_id": run.dataset_id,
        "dataset_label": DATASETS.get(run.dataset_id, {}).get("label", run.dataset_id),
        "model": model,
        "scope": scope,
        "fixture_sha256": fixture,
        "evaluator_version": evaluator,
        "case_ids": sorted(case_ids),
        "retrieval_k": retrieval_k,
    }
    return (
        group,
        capture,
        {
            "run_id": str(run.id),
            "source_run_id": str(origin.id) if origin != run else None,
            "mode": run.execution_mode,
            "measured_at": (origin.started_at or origin.created_at).isoformat(),
            "evaluated_at": (run.finished_at or run.created_at).isoformat(),
            "prompt_sha256": prompt if fingerprint(prompt) else None,
            "values": values,
            "samples": samples,
            "coverage": coverage,
        },
    )


def dashboard_data(runs, total):
    groups = {}
    seen = set()
    excluded = {"replay": 0, "incomplete": 0, "unverifiable": 0, "duplicate": 0}
    states = {"completed": 0, "failed": 0, "active": 0, "cancelled": 0}
    for run in runs:
        state = (
            "completed"
            if run.status == "COMPLETED"
            else "cancelled"
            if run.status == "CANCELLED"
            else "failed"
            if run.status in {"FAILED", "CRASHED", "RESULT_ERROR"}
            else "active"
        )
        states[state] += 1
        if run.execution_mode == "replay":
            excluded["replay"] += 1
            continue
        if run.status != "COMPLETED":
            excluded["incomplete"] += 1
            continue
        item = measurement(run)
        if item is None:
            excluded["unverifiable"] += 1
            continue
        group, capture, point = item
        key = digest(group)
        if (key, capture) in seen:
            excluded["duplicate"] += 1
            continue
        seen.add((key, capture))
        groups.setdefault(key, {**group, "id": key, "points": []})["points"].append(point)
    for group in groups.values():
        group["points"].sort(key=lambda point: (point["measured_at"], point["run_id"]))
    series = sorted(
        groups.values(), key=lambda group: group["points"][-1]["measured_at"], reverse=True
    )
    return {
        "as_of": timezone.now().isoformat(),
        "configured_model": os.environ.get("LLMOPS_LIVE_MODEL", "gpt-6-luna"),
        "window": {
            "limit": RUN_LIMIT,
            "loaded": len(runs),
            "total": total,
            "truncated": total > len(runs),
        },
        "states": states,
        "excluded": excluded,
        "series": series,
    }


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_dashboard(request):
    # 산출물 서버·Prefect·OpenAI 호출이나 상태 동기화 없이 DB의 검증된 요약만 읽는다.
    runs = EvaluationRun.objects.select_related("source_run").order_by("-created_at", "-id")
    return Response(dashboard_data(list(runs[:RUN_LIMIT]), runs.count()))
