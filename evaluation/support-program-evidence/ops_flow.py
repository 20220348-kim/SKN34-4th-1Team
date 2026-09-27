"""Ops 요청을 받는 저장 캡처 전용 deployment. 유료 모델 호출은 없다."""

import os
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from prefect import flow
from prefect.runtime import flow_run
from llmops import evaluate_capture, write_json

sys.path.insert(0, str(ROOT / "backend/ops-service/apps/evaluations"))
from catalog import LEGACY_DATASET_ID, selection

DATASET_ID = LEGACY_DATASET_ID


@flow(name="govbiz-ops-evidence-evaluation", retries=0, persist_result=False)
def evaluate_saved_capture(
    request_id: str, dataset_id: str,
    candidate_capture_id: str = DATASET_ID, reference_capture_id: str = DATASET_ID,
) -> dict:
    # 요청에서 파일 경로나 실행 코드를 받지 않는다.
    request_id = str(UUID(request_id))
    dataset, candidate, reference = selection(dataset_id, candidate_capture_id, reference_capture_id)
    output_root = Path(os.environ.get("LLMOPS_RESULTS_DIR", ROOT / "work/llmops-ops")).resolve()
    output = output_root / request_id
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "request.json", {
        "request_id": request_id, "dataset_id": dataset_id,
        "prefect_flow_run_id": str(flow_run.id),
        "candidate_capture_id": candidate_capture_id, "reference_capture_id": reference_capture_id,
    })
    here = Path(__file__).resolve().parent
    return evaluate_capture(
        str(here / dataset["fixture"]), str(here / candidate["path"]), str(here / reference["path"]),
        str(output / "evaluation"), case_ids=dataset["case_ids"],
    )


if __name__ == "__main__":
    if not os.environ.get("PREFECT_API_URL"):
        raise SystemExit("PREFECT_API_URL is required")
    evaluate_saved_capture.serve(name="saved-capture", limit=1)
