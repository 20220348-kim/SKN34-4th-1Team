"""Ops 평가 요청. 명시적으로 승인한 live 실행만 새 응답을 생성한다."""

import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from prefect import flow
from prefect.runtime import flow_run
import evaluate
from budget_client import BudgetClient, BudgetUnavailable
from llmops import evaluate_capture, load_results, write_json

sys.path.insert(0, str(ROOT / "backend/ops-service"))
from apps.evaluations.catalog import LEGACY_DATASET_ID, selection, validate_execution, validate_reference_config
from apps.evaluations.recovery_inputs import read_recovery_inputs
from apps.evaluations.execution_spec import (
    ExecutionSpecMismatch, build_release, file_digest, verify_spec,
)
from apps.evaluations.catalog import RAG_SCOPE, evaluation_scope
from rag_replay_flow import evaluate_rag_capture

DATASET_ID = LEGACY_DATASET_ID


def reviewed_reference(dataset_id, config, here, output_root):
    """요청 접수 때 고정한 기준 응답만 읽는다. 파일 경로는 서버에서 구성한다."""
    folder = output_root / str(UUID(config["run_id"]))
    def read(name):
        path = (folder / name).resolve()
        evaluate.require(path.is_relative_to(folder), "Reference path escapes run directory")
        return path.read_bytes()
    marker = json.loads(read("request.json"))
    manifest = json.loads(read("evaluation/manifest.json"))
    evaluate.require(marker["request_id"] == config["run_id"] and marker["dataset_id"] == dataset_id,
                     "Reference dataset differs")
    evaluate.require(manifest["status"] == "completed" and
                     manifest["capture_sha256"] == config["capture_sha256"] and
                     manifest["fixture_sha256"] == config["fixture_sha256"], "Reference result differs")
    if marker.get("execution_mode", "replay") in {"live", "recovery"}:
        raw = read("capture/capture.json")
    else:
        _, candidate, _ = selection(dataset_id, marker.get("candidate_capture_id", DATASET_ID),
                                     marker.get("reference_capture_id", DATASET_ID))
        path = (here / candidate["path"]).resolve()
        evaluate.require(path.is_relative_to(here), "Reference path escapes catalog")
        raw = path.read_bytes()
    evaluate.require(sha256(raw).hexdigest() == config["capture_sha256"], "Reference capture changed")
    return raw


def prepare_recovery(output, dataset_id, candidate_id, reference_id, reference_config, config):
    """완료 응답의 고정 바이트만 복사한다. 모델 실행 경로를 호출하지 않는다."""
    here = Path(__file__).resolve().parent
    marker, expected, inputs = read_recovery_inputs(output.parent, here, config["source_run_id"])
    evaluate.require(config == expected, "Recovery inputs changed after dispatch")
    evaluate.require(
        marker["dataset_id"] == dataset_id and marker["candidate_capture_id"] == candidate_id
        and marker["reference_capture_id"] == reference_id
        and marker.get("reference_config", {}) == reference_config,
        "Recovery selection differs from source",
    )
    (output / "capture").mkdir()
    paths = (output / "recovery-fixture.json", output / "capture/capture.json",
             output / "reference-capture.json")
    for path, name in zip(paths, ("fixture", "capture", "reference_capture")):
        path.write_bytes(inputs[name])
    return paths


@flow(name="govbiz-ops-evidence-evaluation", retries=0, persist_result=False)
def evaluate_saved_capture(
    request_id: str, dataset_id: str,
    candidate_capture_id: str = DATASET_ID, reference_capture_id: str = DATASET_ID,
    execution_mode: str = "replay", live_config: dict | None = None,
    reference_config: dict | None = None,
    recovery_config: dict | None = None,
    execution_spec: dict | None = None, execution_spec_sha256: str | None = None,
) -> dict:
    request_id = str(UUID(request_id))
    config = live_config or {}
    reference_config = reference_config or {}
    here = Path(__file__).resolve().parent
    output_root = Path(os.environ.get("LLMOPS_RESULTS_DIR", ROOT / "work/llmops-ops")).resolve()
    output = output_root / request_id
    # UUID 디렉터리의 배타 생성은 실패 기록도 보존하며 수동 재실행의 중복 호출을 차단한다.
    output.mkdir(parents=True, exist_ok=False)
    marker = {
        "request_id": request_id, "dataset_id": dataset_id,
        "prefect_flow_run_id": str(flow_run.id),
        "candidate_capture_id": candidate_capture_id, "reference_capture_id": reference_capture_id,
        "execution_mode": execution_mode, "live_config": config,
        "reference_config": reference_config,
    }
    if recovery_config:
        marker["recovery_config"] = recovery_config
    if execution_spec:
        marker.update(execution_spec=execution_spec, execution_spec_sha256=execution_spec_sha256)
    write_json(output / "request.json", marker)
    try:
        if execution_spec:
            # 전달받은 식별자를 신뢰하지 않고 실행 중인 이미지의 실제 소스·입력을 다시 읽는다.
            verify_spec(execution_spec, execution_spec_sha256, build_release(ROOT),
                        dataset_id=dataset_id, mode=execution_mode, config=config,
                        candidate_id=candidate_capture_id, reference_id=reference_capture_id,
                        reference_config=reference_config, recovery_config=recovery_config)
        elif execution_mode == "live" or execution_spec_sha256 or evaluation_scope(dataset_id) == RAG_SCOPE:
            raise ExecutionSpecMismatch("Live execution requires a pinned specification")
        if execution_mode == "recovery":
            evaluate.require(not config and bool(recovery_config), "Recovery must not generate responses")
            dataset, _, _ = selection(dataset_id, candidate_capture_id, reference_capture_id)
            fixture_path, capture_path, reference_path = prepare_recovery(
                output, dataset_id, candidate_capture_id, reference_capture_id,
                reference_config, recovery_config,
            )
        else:
            evaluate.require(not recovery_config, "Unexpected recovery configuration")
            dataset, candidate, reference = validate_execution(
                dataset_id, candidate_capture_id, reference_capture_id, execution_mode, config,
            )
            validate_reference_config(dataset_id, reference_capture_id, reference_config)
            fixture_path = here / dataset["fixture"]
            capture_path = output / "capture/capture.json" if execution_mode == "live" else here / candidate["path"]
            if reference_config:
                reference_path = output / "reference-capture.json"
                reference_path.write_bytes(reviewed_reference(dataset_id, reference_config, here, output_root))
            else:
                reference_path = here / reference["path"]
        if execution_spec:
            for path, expected in (
                (fixture_path, execution_spec["dataset"]["fixture_sha256"]),
                (reference_path, execution_spec["reference_sha256"]),
                *(([(capture_path, execution_spec["candidate_sha256"])]) if execution_mode != "live" else []),
            ):
                evaluate.require(file_digest(path) == expected, "Pinned input has changed")
        if execution_mode == "live":
            evaluate.require(os.environ.get("LLMOPS_LIVE_ENABLED", "false").lower() == "true",
                             "Live evaluations are disabled")
            evaluate.require(bool(os.environ.get("OPENAI_API_KEY", "").strip()), "OpenAI key is required")
            if evaluation_scope(dataset_id) == RAG_SCOPE:
                import rag_live
                import rag_evaluate
                evaluate.require(os.environ.get("LLMOPS_RAG_LIVE_ENABLED", "false").lower() == "true",
                                 "RAG live evaluations are disabled")
                _, fixture_hash, prepared = rag_live.prepare(fixture_path, model=config["model"])
                evaluate.require(fixture_hash == config["fixture_sha256"] and
                                 prepared["model_operations"] == execution_spec["model_operations"],
                                 "Approved RAG inputs differ")
                rag_evaluate.evaluate(fixture_path, reference_path)
            else:
                _, prepared, fixture_hash = evaluate.load_fixture(fixture_path)
                evaluate.require(fixture_hash == config["fixture_sha256"], "Approved fixture has changed")
                prepared = evaluate.select_cases(prepared, dataset["case_ids"])
                baseline = load_results(fixture_path, reference_path, dataset["case_ids"])
                evaluate.require(baseline["summary"]["completed"], "Reference must be complete")
                settings = execution_spec["generation"]["settings"]
                evaluate.require(settings["max_input_tokens"] == config["max_input_tokens"] == evaluate.MAX_INPUT_TOKENS
                                 and settings["max_output_tokens"] == config["max_output_tokens"]
                                 and settings["model_timeout_seconds"] == evaluate.DEFAULT_LLM_MODEL_TIMEOUT_SECONDS
                                 and settings["run_timeout_seconds"] == evaluate.DEFAULT_LLM_RUN_TIMEOUT_SECONDS
                                 and settings["max_retries"] == 0, "Generation settings differ")
                evaluate.require(evaluate.digest(evaluate.SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS.encode())
                                 == execution_spec["generation"]["prompt_sha256"], "Loaded prompt differs")
    except (ValueError, OSError, KeyError, TypeError, BudgetUnavailable) as error:
        code = "EXECUTION_SPEC_REQUIRED" if execution_mode == "live" and not execution_spec else "EXECUTION_SPEC_MISMATCH"
        # 이 기록은 execute() 이전에만 쓴다. 전송 후 실패나 응답 유실을 0회로 추정하지 않는다.
        write_json(output / "preflight.json", {
            "error_code": code, "phase": "before_model_call", "model_api_calls": 0,
            "execution_spec_sha256": execution_spec_sha256 or "",
        })
        raise ExecutionSpecMismatch(code) from error
    if execution_mode == "live":
        budget = BudgetClient(request_id, str(flow_run.id), execution_spec_sha256)
        budget.claim()
        try:
            if evaluation_scope(dataset_id) == RAG_SCOPE:
                _, capture = asyncio.run(rag_live.execute(
                    fixture_path, output / "capture", budget=budget, execution_spec=execution_spec,
                ))
            else:
                capture = asyncio.run(evaluate.execute(
                    prepared, fixture_hash, output / "capture", model=config["model"],
                    max_model_calls=config["max_model_calls"], budget=budget,
                ))
        finally:
            # 모델 전송이 끝난 뒤에만 미전송 몫을 반환한다. 미확인 전송은 예약을 유지한다.
            budget.close()
        evaluate.require(capture["completed"], "Live capture incomplete; partial capture preserved")
    if evaluation_scope(dataset_id) == RAG_SCOPE:
        return evaluate_rag_capture(str(fixture_path), str(capture_path), str(reference_path),
                                    str(output / "evaluation"), execution_spec=execution_spec,
                                    execution_spec_sha256=execution_spec_sha256)
    return evaluate_capture(str(fixture_path), str(capture_path), str(reference_path),
                            str(output / "evaluation"), case_ids=dataset["case_ids"],
                            **({"execution_spec_sha256": execution_spec_sha256} if execution_spec else {}))


if __name__ == "__main__":
    evaluate_saved_capture.serve(name="saved-capture", limit=1)
