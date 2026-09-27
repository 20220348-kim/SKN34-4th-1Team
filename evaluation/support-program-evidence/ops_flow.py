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
from llmops import evaluate_capture, load_results, write_json

sys.path.insert(0, str(ROOT / "backend/ops-service/apps/evaluations"))
from catalog import LEGACY_DATASET_ID, selection, validate_execution, validate_reference_config

sys.path.insert(0, str(ROOT / "backend/ops-service"))
from apps.evaluations.recovery_inputs import read_recovery_inputs

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


def recover_saved_capture(request_id, dataset_id, candidate_id, reference_id, reference_config, config):
    """허용된 원본의 완료 응답만 복사한다. 모델 실행 경로를 호출하지 않는다."""
    here = Path(__file__).resolve().parent
    output_root = Path(os.environ.get("LLMOPS_RESULTS_DIR", ROOT / "work/llmops-ops")).resolve()
    marker, expected, inputs = read_recovery_inputs(output_root, here, config["source_run_id"])
    evaluate.require(config == expected, "Recovery inputs changed after dispatch")
    evaluate.require(
        marker["dataset_id"] == dataset_id and marker["candidate_capture_id"] == candidate_id
        and marker["reference_capture_id"] == reference_id
        and marker.get("reference_config", {}) == reference_config,
        "Recovery selection differs from source",
    )
    dataset, _, _ = selection(dataset_id, candidate_id, reference_id)
    output = output_root / request_id
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "request.json", {
        "request_id": request_id, "dataset_id": dataset_id,
        "prefect_flow_run_id": str(flow_run.id),
        "candidate_capture_id": candidate_id, "reference_capture_id": reference_id,
        "execution_mode": "recovery", "live_config": {}, "reference_config": reference_config,
        "recovery_config": config,
    })
    (output / "capture").mkdir()
    fixture = output / "recovery-fixture.json"
    capture = output / "capture/capture.json"
    reference = output / "reference-capture.json"
    for path, name in [(fixture, "fixture"), (capture, "capture"), (reference, "reference_capture")]:
        path.write_bytes(inputs[name])
    # SDK 입력 검증은 기존 파이프라인에서 다시 수행한다. 원본 모델 설정이 바뀌어도 재생성하지 않는다.
    return evaluate_capture(str(fixture), str(capture), str(reference), str(output / "evaluation"),
                            case_ids=dataset["case_ids"])


@flow(name="govbiz-ops-evidence-evaluation", retries=0, persist_result=False)
def evaluate_saved_capture(
    request_id: str, dataset_id: str,
    candidate_capture_id: str = DATASET_ID, reference_capture_id: str = DATASET_ID,
    execution_mode: str = "replay", live_config: dict | None = None,
    reference_config: dict | None = None,
    recovery_config: dict | None = None,
) -> dict:
    # 요청에서 파일 경로나 실행 코드를 받지 않는다.
    request_id = str(UUID(request_id))
    config = live_config or {}
    if execution_mode == "recovery":
        evaluate.require(not config and bool(recovery_config), "Recovery must not generate responses")
        return recover_saved_capture(request_id, dataset_id, candidate_capture_id,
                                     reference_capture_id, reference_config or {}, recovery_config)
    evaluate.require(not recovery_config, "Unexpected recovery configuration")
    dataset, candidate, reference = validate_execution(
        dataset_id, candidate_capture_id, reference_capture_id, execution_mode, config,
    )
    here = Path(__file__).resolve().parent
    reference_config = reference_config or {}
    validate_reference_config(dataset_id, reference_capture_id, reference_config)
    output_root = Path(os.environ.get("LLMOPS_RESULTS_DIR", ROOT / "work/llmops-ops")).resolve()
    reference_raw = reviewed_reference(dataset_id, reference_config, here, output_root) if reference_config else None
    reference_path = here / reference["path"] if reference_raw is None else None
    if execution_mode == "live":
        evaluate.require(os.environ.get("LLMOPS_LIVE_ENABLED", "false").lower() == "true",
                         "Live evaluations are disabled")
        evaluate.require(bool(os.environ.get("OPENAI_API_KEY", "").strip()), "OpenAI key is required")
        _, prepared, fixture_hash = evaluate.load_fixture(here / dataset["fixture"])
        evaluate.require(fixture_hash == config["fixture_sha256"], "Approved fixture has changed")
        prepared = evaluate.select_cases(prepared, dataset["case_ids"])
        # 유료 호출 전에 비교 기준 전체와 선택 범위를 검증한다.
        if reference_path is not None:
            baseline = load_results(here / dataset["fixture"], reference_path, dataset["case_ids"])
            evaluate.require(baseline["summary"]["completed"], "Reference must be complete")
    output = output_root / request_id
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "request.json", {
        "request_id": request_id, "dataset_id": dataset_id,
        "prefect_flow_run_id": str(flow_run.id),
        "candidate_capture_id": candidate_capture_id, "reference_capture_id": reference_capture_id,
        "execution_mode": execution_mode, "live_config": config,
        "reference_config": reference_config,
    })
    if reference_raw is not None:
        reference_path = output / "reference-capture.json"
        reference_path.write_bytes(reference_raw)
        baseline = load_results(here / dataset["fixture"], reference_path, dataset["case_ids"])
        evaluate.require(baseline["summary"]["completed"], "Reference must be complete")
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
        str(here / dataset["fixture"]), str(candidate_path), str(reference_path),
        str(output / "evaluation"), case_ids=dataset["case_ids"],
    )


if __name__ == "__main__":
    if not os.environ.get("PREFECT_API_URL"):
        raise SystemExit("PREFECT_API_URL is required")
    evaluate_saved_capture.serve(name="saved-capture", limit=1)
