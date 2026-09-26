"""저장 캡처만 처리하는 무료 LLMOps 파이프라인. 모델 실행·스케줄은 자동 활성화하지 않는다."""

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from math import isfinite
import os
from pathlib import Path
import time

# 평가 라이브러리의 사용량 telemetry도 외부로 보내지 않는다.
os.environ["DO_NOT_TRACK"] = "1"
os.environ["PREFECT_SERVER_ANALYTICS_ENABLED"] = "false"
os.environ.setdefault("PREFECT_HOME", str(Path(__file__).resolve().parents[2] / "work/llmops/prefect-client"))

import pandas as pd
import pandera.pandas as pa
import httpx
from evidently import Report
from evidently.metrics import MeanValue, RowCount
from filelock import FileLock
from langfuse.api.client import LangfuseAPI
from prefect import flow, task
from prefect.cache_policies import NO_CACHE
from prefect.runtime import flow_run

import evaluate
from app.config import LangfuseSettings


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# 지표 계산 코드가 달라지면 같은 캡처도 다른 평가 실행으로 식별한다.
EVALUATOR_VERSION = sha256((HERE / "evaluate.py").read_bytes() + Path(__file__).read_bytes()).hexdigest()

INPUT_SCHEMA = pa.DataFrameSchema({
    "case_id": pa.Column(str, unique=True),
    "expected_status": pa.Column(str, pa.Check.isin(["ANSWERED", "INSUFFICIENT_EVIDENCE"])),
    "chunk_count": pa.Column(int, pa.Check.in_range(1, 5)),
}, strict=True)

RESULT_SCHEMA = pa.DataFrameSchema({
    "case_id": pa.Column(str, unique=True),
    "outcome": pa.Column(str, pa.Check.isin(["success", "error", "missing"])),
    "status_match": pa.Column(float, pa.Check.isin([0.0, 1.0]), nullable=True),
    "citation_recall": pa.Column(float, pa.Check.in_range(0, 1), nullable=True),
    "failed": pa.Column(float, pa.Check.isin([0.0, 1.0])),
    "missing": pa.Column(float, pa.Check.isin([0.0, 1.0])),
    "elapsed_ms": pa.Column(float, pa.Check.ge(0), nullable=True),
    "input_tokens": pa.Column(float, pa.Check.ge(0), nullable=True),
    "output_tokens": pa.Column(float, pa.Check.ge(0), nullable=True),
}, strict=True, checks=[
    pa.Check(lambda frame: (frame.status_match.notna() == (frame.outcome == "success")).all()),
    pa.Check(lambda frame: (frame.failed == (frame.outcome == "error").astype(float)).all()),
    pa.Check(lambda frame: (frame.missing == (frame.outcome == "missing").astype(float)).all()),
    pa.Check(lambda frame: frame.loc[frame.outcome != "success", "citation_recall"].isna().all()),
])


def load_results(fixture_path: Path, capture_path: Path) -> dict:
    fixture, prepared, fixture_hash = evaluate.load_fixture(fixture_path)
    raw = capture_path.read_bytes()
    capture = json.loads(raw)
    evaluate.require(isinstance(capture, dict), "capture must be an object")
    selected = evaluate.select_cases(prepared, capture.get("caseIds", [case["id"] for case, _ in prepared]))
    inputs = pd.DataFrame([{
        "case_id": case["id"], "expected_status": case["expectedStatus"], "chunk_count": len(request.chunks),
    } for case, request in selected])
    INPUT_SCHEMA.validate(inputs, lazy=True)
    summary = evaluate.report(fixture, prepared, fixture_hash, capture)
    observations = {case["id"]: case for case in summary["cases"]}
    records = {case["caseId"]: case for case in capture["cases"]}
    rows = []
    for case, _ in selected:
        observed = observations.get(case["id"], {})
        record = records.get(case["id"], {})
        outcome = observed.get("outcome", "missing")
        expected = observed.get("expectedCitationOrders", [])
        # 기존 report()의 사례별 지표 정의를 사용하고 집계 일치를 아래에서 확인한다.
        recall = evaluate.reference_citation_recall(observed.get("citedOrders", []), expected)
        indexes = record.get("apiResponseIndexes", [])
        evaluate.require(isinstance(indexes, list) and len(indexes) <= 1
                         and all(type(index) is int and 0 <= index < len(capture.get("apiResponses", [])) for index in indexes),
                         "invalid response indexes")
        responses = [capture["apiResponses"][index] for index in indexes]
        usage = responses[0].get("usage") if len(responses) == 1 else None
        evaluate.require(usage is None or isinstance(usage, dict), "invalid usage record")
        elapsed = record.get("elapsedMs")
        evaluate.require(elapsed is None or type(elapsed) in (int, float) and isfinite(elapsed) and elapsed >= 0,
                         "invalid recorded duration")
        for name in ["input_tokens", "output_tokens"]:
            token = (usage or {}).get(name)
            evaluate.require(token is None or type(token) is int and token >= 0, "invalid token count")
        rows.append({
            "case_id": case["id"], "outcome": outcome,
            "status_match": float(observed["statusMatches"]) if outcome == "success" else None,
            "citation_recall": recall, "failed": float(outcome == "error"), "missing": float(outcome == "missing"),
            "elapsed_ms": record.get("elapsedMs"),
            "input_tokens": (usage or {}).get("input_tokens"), "output_tokens": (usage or {}).get("output_tokens"),
        })
    frame = pd.DataFrame(rows)
    for column in frame.columns.difference(["case_id", "outcome"]):
        frame[column] = frame[column].astype(float)
    RESULT_SCHEMA.validate(frame, lazy=True)
    evaluate.require(frame.case_id.tolist() == summary["selectedCaseIds"], "result coverage differs")
    if summary["completed"]:
        evaluate.require(float(frame.status_match.mean()) == summary["statusAccuracy"], "status aggregate differs")
        recall = frame.citation_recall.mean()
        evaluate.require((pd.isna(recall) and summary["referenceCitationRecall"] is None)
                         or float(recall) == summary["referenceCitationRecall"], "citation aggregate differs")
    capture_hash = sha256(raw).hexdigest()
    run_id = sha256(f"{fixture_hash}:{capture_hash}:{EVALUATOR_VERSION}".encode()).hexdigest()[:32]
    return {"run_id": run_id, "frame": frame, "summary": summary, "capture": capture,
            "capture_sha256": capture_hash, "fixture_sha256": fixture_hash}


def write_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def create_report(current: dict, reference: dict, output: Path) -> dict:
    evaluate.require(current["fixture_sha256"] == reference["fixture_sha256"], "comparison fixtures differ")
    evaluate.require(current["frame"].case_id.tolist() == reference["frame"].case_id.tolist(), "comparison cases differ")
    # 부분 캡처의 성공 행만으로 품질 평균을 내지 않는다. 실패·누락은 선택 사례 전체가 분모다.
    columns = ["failed", "missing"]
    if current["summary"]["completed"] and reference["summary"]["completed"]:
        columns += [name for name in ["status_match", "citation_recall"]
                    if current["frame"][name].notna().any() and reference["frame"][name].notna().any()]
    columns += [name for name in ["elapsed_ms", "input_tokens", "output_tokens"]
                if current["frame"][name].notna().any() and reference["frame"][name].notna().any()]
    metadata = {"evaluation_run_id": current["run_id"], "reference_run_id": reference["run_id"],
                "evaluator_version": EVALUATOR_VERSION, "scope": "fixed-answer-context-only",
                "reference_source": "ai-authored", "semantic_faithfulness": "unmeasured",
                "comparison": "self-replay" if current["run_id"] == reference["run_id"] else "candidate-reference"}
    snapshot = Report([RowCount(), *[MeanValue(column=name) for name in columns]],
                      metadata=metadata, include_tests=False).run(
        current_data=current["frame"][["case_id", "outcome", *columns]],
        reference_data=reference["frame"][["case_id", "outcome", *columns]], name="GovBiz evidence evaluation",
    )
    snapshot.save_html(str(output / "report.html.partial"))
    (output / "report.html.partial").replace(output / "report.html")
    snapshot.save_json(str(output / "evidently.json.partial"))
    (output / "evidently.json.partial").replace(output / "evidently.json")
    artifacts = {name: sha256((output / name).read_bytes()).hexdigest() for name in ["report.html", "evidently.json"]}
    return {**metadata, "artifact_sha256": artifacts, "reported_columns": columns,
            "current": {key: current["summary"][key] for key in [
                "caseCount", "observedCaseCount", "completed", "statusAccuracy", "referenceCitationRecall", "semanticFaithfulness",
            ]}, "reference": {key: reference["summary"][key] for key in [
                "caseCount", "observedCaseCount", "completed", "statusAccuracy", "referenceCitationRecall", "semanticFaithfulness",
            ]}}


def score_payloads(result: dict, settings: LangfuseSettings) -> list[dict]:
    metadata = {"evaluation_run_id": result["run_id"], "capture_sha256": result["capture_sha256"],
                "fixture_sha256": result["fixture_sha256"], "evaluator_version": EVALUATOR_VERSION,
                "prompt_sha256": result["capture"]["promptSha256"], "model": result["capture"]["model"],
                "source_started_at": result["capture"].get("startedAt"), "record_kind": "saved-capture-recalculation",
                "source_completed": result["summary"]["completed"],
                "reference_source": "ai-authored", "scope": "fixed-answer-context-only"}
    payloads = []
    records = {case["caseId"]: case for case in result["capture"]["cases"]}
    for row in result["frame"].to_dict(orient="records"):
        for column, name in [("status_match", "statusMatch"), ("citation_recall", "referenceCitationRecall"),
                             ("failed", "executionFailed"), ("missing", "caseMissing")]:
            if pd.isna(row[column]):
                continue
            item = {"id": sha256(f'{result["run_id"]}:{row["case_id"]}:{name}'.encode()).hexdigest(),
                    "name": name, "value": row[column], "data_type": "NUMERIC", "environment": settings.environment,
                    "metadata": {**metadata, "case_id": row["case_id"]}}
            trace_id = records.get(row["case_id"], {}).get("traceId")
            if trace_id:
                evaluate.require(isinstance(trace_id, str) and len(trace_id) == 32
                                 and all(char in "0123456789abcdef" for char in trace_id), "invalid trace identifier")
                item["trace_id"] = trace_id
            else:
                # 과거 실행에는 새 model trace를 만들지 않는다. 평가 실행 ID를 score session으로 사용한다.
                item["session_id"] = result["run_id"]
            payloads.append(item)
    return payloads


def publish_scores(result: dict, settings: LangfuseSettings) -> list[str]:
    evaluate.require(settings.enabled, "Langfuse must be explicitly enabled for publication")
    payloads = score_payloads(result, settings)
    options = {"max_retries": 0, "timeout_in_seconds": 5}
    # REST 등록에는 추적 SDK의 공용 background worker를 생성·종료하지 않는다.
    with httpx.Client(timeout=5) as transport:
        client = LangfuseAPI(username=settings.public_key, password=settings.secret_key,
                             base_url=settings.base_url, httpx_client=transport, timeout=5)
        for payload in payloads:
            client.scores.create(**payload, request_options=options)
        expected = {payload["id"]: payload for payload in payloads}
        # v4 서버 저장 여부를 확인한다. write 응답이나 SDK flush만으로 완료하지 않는다.
        deadline = time.monotonic() + 45
        while True:
            found = client.scores_v3.get_many_v3(id=",".join(expected), limit=100,
                                                    fields="details,subject", request_options=options)
            actual = {score.id: score for score in found.data}
            if all(identifier in actual and actual[identifier].value == payload["value"]
                   and actual[identifier].name == payload["name"] for identifier, payload in expected.items()):
                return list(expected)
            if time.monotonic() >= deadline:
                raise RuntimeError("Langfuse score persistence verification timed out")
            time.sleep(1)


@task(name="validate-capture-and-results", retries=0, cache_policy=NO_CACHE, persist_result=False)
def prepare(fixture: str, capture: str) -> dict:
    return load_results(Path(fixture), Path(capture))


@task(name="evidently-comparison", retries=1, retry_delay_seconds=1, cache_policy=NO_CACHE, persist_result=False)
def render(current: dict, reference: dict, output: str) -> dict:
    return create_report(current, reference, Path(output))


@task(name="langfuse-scores-and-readback", retries=1, retry_delay_seconds=1, cache_policy=NO_CACHE, persist_result=False)
def publish(current: dict) -> list[str]:
    # 키는 Prefect 인자로 저장하지 않고 실행 프로세스에서 읽는다.
    return publish_scores(current, LangfuseSettings.from_environment())


@flow(name="govbiz-evidence-capture-evaluation", retries=0, timeout_seconds=300, persist_result=False)
def evaluate_capture(fixture: str, capture: str, reference: str, output_dir: str) -> dict:
    lock_dir = ROOT / "work/llmops"
    lock_dir.mkdir(parents=True, exist_ok=True)
    # 수동 실행 프로세스도 같은 checkout에서 겹치지 않는다. 배포 시에도 serve(limit=1)을 적용한다.
    with FileLock(str(lock_dir / "evaluation.lock"), timeout=0):
        output = Path(output_dir)
        output.mkdir(parents=True, exist_ok=False)
        manifest = {"status": "running", "prefect_flow_run_id": str(flow_run.id),
                    "started_at": datetime.now(timezone.utc).isoformat(), "model_api_calls": 0}
        write_json(output / "manifest.json", manifest)
        try:
            current = prepare(fixture, capture)
            baseline = prepare(fixture, reference)
            manifest.update(evaluation_run_id=current["run_id"], reference_run_id=baseline["run_id"],
                            capture_sha256=current["capture_sha256"], reference_capture_sha256=baseline["capture_sha256"],
                            fixture_sha256=current["fixture_sha256"], evaluator_version=EVALUATOR_VERSION)
            current["frame"].to_json(output / "results.json", orient="records", force_ascii=False, indent=2)
            report = render(current, baseline, str(output))
            write_json(output / "comparison.json", report)
            score_ids = publish(current)
            manifest.update(status="completed", score_ids=score_ids, report="report.html",
                            artifact_sha256=report["artifact_sha256"])
            if not current["summary"]["completed"]:
                raise RuntimeError("Source evaluation is incomplete; partial results were preserved")
        except BaseException:
            manifest["status"] = "failed"
            raise
        finally:
            manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
            write_json(output / "manifest.json", manifest)
        return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if not os.environ.get("PREFECT_API_URL"):
        parser.error("PREFECT_API_URL is required; start the local evaluation server first")
    result = evaluate_capture(*(str(path.resolve()) for path in [args.fixture, args.capture, args.reference, args.output_dir]))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
