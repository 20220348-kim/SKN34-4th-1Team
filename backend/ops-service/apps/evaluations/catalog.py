"""Ops API와 평가 실행기가 공유하는 저장 캡처 허용 목록."""

import json
import os
from pathlib import Path

DATASETS = {
    item["id"]: item
    for item in json.loads(Path(__file__).with_name("capture_catalog.json").read_text())
}
LEGACY_DATASET_ID = "target-coverage-20260907-v1"
LIVE_CAPTURE_ID = "new-model-response"


def live_config(dataset_id):
    dataset = DATASETS[dataset_id]
    return {
        "model": os.environ.get("LLMOPS_LIVE_MODEL", "gpt-6-luna"),
        "fixture_sha256": dataset["fixture_sha256"],
        "max_model_calls": len(dataset["case_ids"]),
        "max_output_tokens": 2000,
    }


def validate_execution(dataset_id, candidate_id, reference_id, execution_mode, config):
    selected = selection(dataset_id, candidate_id, reference_id)
    if execution_mode == "live":
        if (
            candidate_id != LIVE_CAPTURE_ID
            or config != live_config(dataset_id)
            or type(config.get("max_model_calls")) is not int
            or type(config.get("max_output_tokens")) is not int
        ):
            raise ValueError("전송 자료·모델·호출 예산이 변경되었습니다. 새로고침 후 확인하세요.")
    elif execution_mode != "replay" or candidate_id == LIVE_CAPTURE_ID or config:
        raise ValueError("평가 실행 방식과 후보 자료가 일치하지 않습니다.")
    return selected


def selection(dataset_id, candidate_capture_id, reference_capture_id):
    try:
        dataset = DATASETS[dataset_id]
        captures = {item["id"]: item for item in dataset["captures"]}
        candidate = (
            {"id": LIVE_CAPTURE_ID, "label": "새 모델 응답"}
            if candidate_capture_id == LIVE_CAPTURE_ID
            else captures[candidate_capture_id]
        )
        return dataset, candidate, captures[reference_capture_id]
    except KeyError:
        raise ValueError("평가 자료에 등록된 기준·후보 실행을 선택하세요.") from None


def public_datasets():
    return [
        {
            "id": item["id"],
            "label": item["label"],
            "case_ids": item["case_ids"],
            "fixture": item["fixture"],
            "live_config": live_config(item["id"]),
            "captures": [
                {"id": capture["id"], "label": capture["label"]} for capture in item["captures"]
            ],
        }
        for item in DATASETS.values()
    ]
