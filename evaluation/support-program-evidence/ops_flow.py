"""Ops 평가 요청. 명시적으로 승인한 live 실행만 새 응답을 생성한다."""

import asyncio
import os
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from prefect import flow
from prefect.runtime import flow_run
import evaluate
from llmops import evaluate_capture, load_results, write_json

sys.path.insert(0, str(ROOT / "backend/ops-service/apps/evaluations"))
from catalog import LEGACY_DATASET_ID, validate_execution

DATASET_ID = LEGACY_DATASET_ID


@flow(name="govbiz-ops-evidence-evaluation", retries=0, persist_result=False)
def evaluate_saved_capture(
    request_id: str, dataset_id: str,
    candidate_capture_id: str = DATASET_ID, reference_capture_id: str = DATASET_ID,
    execution_mode: str = "replay", live_config: dict | None = None,
) -> dict:
    # 요청에서 파일 경로나 실행 코드를 받지 않는다.
    request_id = str(UUID(request_id))
    config = live_config or {}
    dataset, candidate, reference = validate_execution(
        dataset_id, candidate_capture_id, reference_capture_id, execution_mode, config,
    )
    here = Path(__file__).resolve().parent
    if execution_mode == "live":
        evaluate.require(os.environ.get("LLMOPS_LIVE_ENABLED", "false").lower() == "true",
                         "Live evaluations are disabled")
        evaluate.require(bool(os.environ.get("OPENAI_API_KEY", "").strip()), "OpenAI key is required")
        _, prepared, fixture_hash = evaluate.load_fixture(here / dataset["fixture"])
        evaluate.require(fixture_hash == config["fixture_sha256"], "Approved fixture has changed")
        prepared = evaluate.select_cases(prepared, dataset["case_ids"])
        # 유료 호출 전에 비교 기준 전체와 선택 범위를 검증한다.
        baseline = load_results(here / dataset["fixture"], here / reference["path"], dataset["case_ids"])
        evaluate.require(baseline["summary"]["completed"], "Reference must be complete")
    output_root = Path(os.environ.get("LLMOPS_RESULTS_DIR", ROOT / "work/llmops-ops")).resolve()
    output = output_root / request_id
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "request.json", {
        "request_id": request_id, "dataset_id": dataset_id,
        "prefect_flow_run_id": str(flow_run.id),
        "candidate_capture_id": candidate_capture_id, "reference_capture_id": reference_capture_id,
        "execution_mode": execution_mode, "live_config": config,
    })
    if execution_mode == "live":
        # UUID 디렉터리의 배타 생성이 Prefect 수동 재실행에서도 중복 과금을 차단한다.
        capture = asyncio.run(evaluate.execute(
            prepared, fixture_hash, output / "capture", model=config["model"],
            max_model_calls=config["max_model_calls"],
        ))
        candidate_path = output / "capture/capture.json"
        evaluate.require(capture["completed"], "New model evaluation failed; partial capture preserved")
    else:
        candidate_path = here / candidate["path"]
    return evaluate_capture(
        str(here / dataset["fixture"]), str(candidate_path), str(here / reference["path"]),
        str(output / "evaluation"), case_ids=dataset["case_ids"],
    )


if __name__ == "__main__":
    if not os.environ.get("PREFECT_API_URL"):
        raise SystemExit("PREFECT_API_URL is required")
    evaluate_saved_capture.serve(name="saved-capture", limit=1)
