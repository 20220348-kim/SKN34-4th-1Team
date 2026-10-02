"""Ops API와 평가 실행기가 공유하는 저장 캡처 허용 목록."""

import json
import os
import re
from pathlib import Path
from uuid import UUID

DATASETS = {
    item["id"]: item
    for item in json.loads(Path(__file__).with_name("capture_catalog.json").read_text())
}
LEGACY_DATASET_ID = "target-coverage-20260907-v1"
LIVE_CAPTURE_ID = "new-model-response"
MAX_INPUT_TOKENS = 32768
RAG_SCOPE = "source-chunks-retrieval-answer"


def evaluation_scope(dataset_id):
    return DATASETS[dataset_id].get("evaluation_scope", "fixed-answer-context-only")


def live_config(dataset_id):
    dataset = DATASETS[dataset_id]
    if evaluation_scope(dataset_id) == RAG_SCOPE:
        from .execution_spec import read_release

        plan = read_release()["datasets"][dataset_id].get("live_plan")
        if plan is None:
            return None
        return {
            **plan["live_config"],
            "model": os.environ.get("LLMOPS_LIVE_MODEL", "gpt-6-luna"),
            "fixture_sha256": dataset["fixture_sha256"],
            "source_mode": "fixed-source-and-chunks",
            "max_total_input_tokens": sum(
                item["max_input_tokens"] for item in plan["model_operations"]
            ),
            "max_total_output_tokens": sum(
                item["max_output_tokens"] for item in plan["model_operations"]
            ),
        }
    return {
        "model": os.environ.get("LLMOPS_LIVE_MODEL", "gpt-6-luna"),
        "fixture_sha256": dataset["fixture_sha256"],
        "max_model_calls": len(dataset["case_ids"]),
        "max_output_tokens": 2000,
        "max_input_tokens": MAX_INPUT_TOKENS,
    }


def validate_execution(dataset_id, candidate_id, reference_id, execution_mode, config):
    selected = selection(dataset_id, candidate_id, reference_id)
    if execution_mode == "live":
        if (
            candidate_id != LIVE_CAPTURE_ID
            or config != live_config(dataset_id)
            or type(config.get("max_model_calls")) is not int
            or type(config.get("max_output_tokens")) is not int
            or type(config.get("max_input_tokens")) is not int
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
        reference = (
            {
                "id": reference_capture_id,
                "label": f"검토 기준 · {reference_run_id(reference_capture_id)[:8]}",
            }
            if reference_capture_id.startswith("run:")
            else captures[reference_capture_id]
        )
        return dataset, candidate, reference
    except KeyError:
        raise ValueError("평가 자료에 등록된 기준·후보 실행을 선택하세요.") from None


def reference_run_id(capture_id):
    value = capture_id.removeprefix("run:")
    if not capture_id.startswith("run:") or str(UUID(value)) != value:
        raise ValueError("올바른 기준 실행 ID가 필요합니다.")
    return value


def validate_reference_config(dataset_id, capture_id, config):
    if not capture_id.startswith("run:"):
        if config:
            raise ValueError("저장 기준에는 실행 명세를 지정할 수 없습니다.")
        return
    keys = {"run_id", "capture_sha256", "fixture_sha256"}
    rag = evaluation_scope(dataset_id) == RAG_SCOPE
    if rag:
        keys |= {"assessment_id", "assessment_input_sha256"}
    if (
        not isinstance(config, dict)
        or set(config) != keys
        or config["run_id"] != reference_run_id(capture_id)
        or config["fixture_sha256"] != DATASETS[dataset_id]["fixture_sha256"]
        or not isinstance(config["capture_sha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", config["capture_sha256"])
    ):
        raise ValueError("기준 실행의 자료·응답 명세가 일치하지 않습니다.")
    if rag and (
        type(config["assessment_id"]) is not int
        or config["assessment_id"] < 1
        or not isinstance(config["assessment_input_sha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", config["assessment_input_sha256"])
    ):
        raise ValueError("RAG 기준의 합격 판정 근거가 필요합니다.")


def public_datasets():
    from .execution_spec import digest, profile, read_release

    release = read_release()
    return [
        {
            "id": item["id"],
            "label": item["label"],
            "evaluation_scope": evaluation_scope(item["id"]),
            "case_ids": item["case_ids"],
            "fixture": item["fixture"],
            "live_config": live_config(item["id"]),
            "execution_profiles": {
                mode: (
                    digest(
                        profile(
                            release,
                            item["id"],
                            mode,
                            live_config(item["id"]) if mode == "live" else {},
                        )
                    )
                    if mode != "live" or live_config(item["id"])
                    else None
                )
                for mode in ("replay", "live")
            },
            "captures": [
                {"id": capture["id"], "label": capture["label"]} for capture in item["captures"]
            ],
        }
        for item in DATASETS.values()
    ]
