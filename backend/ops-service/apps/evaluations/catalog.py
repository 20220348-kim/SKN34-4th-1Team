"""Ops API와 평가 실행기가 공유하는 저장 캡처 허용 목록."""

import json
from pathlib import Path

DATASETS = {
    item["id"]: item
    for item in json.loads(Path(__file__).with_name("capture_catalog.json").read_text())
}
LEGACY_DATASET_ID = "target-coverage-20260907-v1"


def selection(dataset_id, candidate_capture_id, reference_capture_id):
    try:
        dataset = DATASETS[dataset_id]
        captures = {item["id"]: item for item in dataset["captures"]}
        return dataset, captures[candidate_capture_id], captures[reference_capture_id]
    except KeyError:
        raise ValueError("평가 자료에 등록된 기준·후보 실행을 선택하세요.") from None


def public_datasets():
    return [
        {
            "id": item["id"],
            "label": item["label"],
            "case_ids": item["case_ids"],
            "captures": [
                {"id": capture["id"], "label": capture["label"]} for capture in item["captures"]
            ],
        }
        for item in DATASETS.values()
    ]
