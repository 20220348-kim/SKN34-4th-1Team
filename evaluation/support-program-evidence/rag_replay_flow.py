"""등록된 RAG 캡처의 무료 재계산·보고서·점수 등록. 새 검색·모델 호출은 하지 않는다."""

from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

import pandas as pd
import pandera.pandas as pa
import rag_evaluate
from apps.evaluations import rag_replay
from evidently import Report
from evidently.metrics import MeanValue, RowCount
from filelock import FileLock
from llmops import ROOT, LangfuseSettings, publish_payloads, write_json
from prefect import flow
from prefect.runtime import flow_run

RESULT_SCHEMA = pa.DataFrameSchema(
    {
        "case_id": pa.Column(str, unique=True),
        "retrieval_recall": pa.Column(float, pa.Check.in_range(0, 1), nullable=True),
        "citation_recall": pa.Column(float, pa.Check.in_range(0, 1), nullable=True),
        "status_match": pa.Column(float, pa.Check.isin([0.0, 1.0]), nullable=True),
        "failed": pa.Column(float, pa.Check.isin([0.0, 1.0])),
    },
    strict=True,
)


def result_frame(report):
    frame = pd.DataFrame(
        [
            {
                "case_id": case["caseId"],
                "retrieval_recall": case["retrievalRecallAtK"],
                "citation_recall": case["answerCitationRecall"],
                "status_match": case["answerStatusMatches"],
                "failed": case["failure"] is not None,
            }
            for case in report["cases"]
        ]
    )
    for column in frame.columns.difference(["case_id"]):
        frame[column] = frame[column].astype(float)
    return RESULT_SCHEMA.validate(frame, lazy=True)


def render(value, output):
    current, reference = (result_frame(value[key]) for key in ("current", "reference"))
    # 실패율은 전체 사례, 품질 평균은 측정 사례만 포함한다. 각 분모를 함께 보존한다.
    columns = [
        name
        for name in current.columns
        if name != "case_id"
        and current[name].notna().any()
        and reference[name].notna().any()
    ]
    metadata = {
        "scope": rag_replay.SCOPE,
        "evaluation_run_id": value["evaluation_run_id"],
        "baseline_eligible": False,
        "current_measurement_kind": value["current"]["measurementKind"],
        "reference_measurement_kind": value["reference"]["measurementKind"],
        "current_metrics": value["current"]["metrics"],
        "reference_metrics": value["reference"]["metrics"],
        "current_coverage": value["current"]["coverage"],
        "reference_coverage": value["reference"]["coverage"],
    }
    snapshot = Report(
        [RowCount(), *[MeanValue(column=name) for name in columns]],
        metadata=metadata,
        include_tests=False,
    ).run(
        current_data=current[["case_id", *columns]],
        reference_data=reference[["case_id", *columns]],
        name="GovBiz RAG saved capture replay",
    )
    snapshot.save_html(str(output / "report.html.partial"))
    (output / "report.html.partial").replace(output / "report.html")
    current.to_json(
        output / "results.json", orient="records", force_ascii=False, indent=2
    )


def score_payloads(value, spec, settings):
    result = value["current"]
    payloads = []
    for case in result["cases"]:
        for name, measured in (
            ("ragRetrievalRecallAtK", case["retrievalRecallAtK"]),
            ("ragAnswerCitationRecall", case["answerCitationRecall"]),
            ("ragAnswerStatusMatch", case["answerStatusMatches"]),
            ("ragSourceCaseFailed", case["failure"] is not None),
        ):
            if measured is None:
                continue
            payload = {
                "id": sha256(
                    f"{value['evaluation_run_id']}:{case['caseId']}:{name}".encode()
                ).hexdigest(),
                "name": name,
                "value": float(measured),
                "data_type": "NUMERIC",
                "environment": settings.environment,
                "metadata": {
                    "scope": rag_replay.SCOPE,
                    "evaluation_run_id": value["evaluation_run_id"],
                    "case_id": case["caseId"],
                    "fixture_sha256": result["fixtureSha256"],
                    "capture_sha256": result["captureSha256"],
                    "measurement_kind": result["measurementKind"],
                    "evaluator_version": spec["evaluation"]["version"],
                    "baseline_eligible": False,
                    "source_completed": result["completed"],
                    "model_api_calls": 0,
                },
            }
            if case["traceId"]:
                payload["trace_id"] = case["traceId"]
            else:
                # Langfuse 점수는 trace 또는 session 중 한 대상에만 연결한다.
                payload["session_id"] = value["evaluation_run_id"]
            payloads.append(payload)
    return payloads


@flow(
    name="govbiz-rag-capture-replay",
    retries=0,
    timeout_seconds=300,
    persist_result=False,
)
def evaluate_rag_capture(
    fixture, capture, reference, output_dir, *, execution_spec, execution_spec_sha256
):
    spec = execution_spec
    lock_dir = ROOT / "work/llmops"
    lock_dir.mkdir(parents=True, exist_ok=True)
    with FileLock(str(lock_dir / "evaluation.lock"), timeout=0):
        output = Path(output_dir)
        output.mkdir(parents=True, exist_ok=False)
        manifest = {
            "status": "running",
            "stage": "validate",
            "scope": rag_replay.SCOPE,
            "model_api_calls": 0,
            "prefect_flow_run_id": str(flow_run.id),
            "execution_spec_sha256": execution_spec_sha256,
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        write_json(output / "manifest.json", manifest)
        try:
            current = rag_evaluate.evaluate(Path(fixture), Path(capture))
            baseline = rag_evaluate.evaluate(Path(fixture), Path(reference))
            value = rag_replay.comparison(current, baseline, spec)
            # 저장 원본이 실패한 사례도 정상적인 재계산 대상이다. 원본 완료 여부는 별도 필드다.
            manifest.update(
                evaluation_run_id=value["evaluation_run_id"],
                reference_run_id=value["reference_run_id"],
                evaluator_version=spec["evaluation"]["version"],
                fixture_sha256=current["fixtureSha256"],
                capture_sha256=current["captureSha256"],
                reference_capture_sha256=baseline["captureSha256"],
                stage="report",
            )
            write_json(output / "manifest.json", manifest)
            render(value, output)
            write_json(output / "comparison.json", value)
            manifest.update(
                stage="publish",
                artifact_sha256={
                    name: sha256((output / name).read_bytes()).hexdigest()
                    for name in ("report.html", "comparison.json")
                },
            )
            write_json(output / "manifest.json", manifest)
            settings = LangfuseSettings.from_environment()
            manifest["score_ids"] = publish_payloads(
                score_payloads(value, spec, settings), settings
            )
            manifest.update(status="completed", stage="completed")
        except BaseException:
            manifest["status"] = "failed"
            raise
        finally:
            manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
            write_json(output / "manifest.json", manifest)
        return manifest
