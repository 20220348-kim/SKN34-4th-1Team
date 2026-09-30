"""접수와 실행이 공유하는 실행 명세. SDK 없이 실제 소스·입력 바이트를 고정한다."""

import argparse
import ast
import json
from hashlib import sha256
from pathlib import Path

AI = "backend/ai-service/"
OPS = "backend/ops-service/apps/evaluations/"
EVIDENCE = "evaluation/support-program-evidence/"
RELEASE_PATH = Path(__file__).with_name("execution_release.json")
EVALUATION_SCOPE = "fixed-answer-context-only"
DEPENDENCIES = (AI + "pyproject.toml", AI + "uv.lock")
EVALUATION_FILES = (
    EVIDENCE + "evaluate.py",
    EVIDENCE + "llmops.py",
    AI + "app/support_program_evidence/models.py",
    AI + "app/support_program_identity.py",
    *DEPENDENCIES,
)
GENERATION_FILES = (
    EVIDENCE + "evaluate.py",
    AI + "app/config.py",
    AI + "app/support_program_evidence/prompt.py",
    AI + "app/support_program_evidence/agent.py",
    AI + "app/support_program_evidence/answer_service.py",
    AI + "app/support_program_evidence/models.py",
    AI + "app/support_program_evidence/errors.py",
    AI + "app/tracing.py",
    AI + "app/support_program_llm.py",
    AI + "app/support_program_identity.py",
    *DEPENDENCIES,
)
PIPELINE_FILES = (
    EVIDENCE + "ops_flow.py",
    EVIDENCE + "budget_client.py",
    OPS + "catalog.py",
    OPS + "recovery_inputs.py",
    OPS + "execution_spec.py",
    OPS + "quality_policy.py",
)


class ExecutionSpecMismatch(ValueError):
    """모델 호출 전 명세 검증 실패. 외부 오류 본문을 담지 않는다."""


def digest(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_digest(path):
    return sha256(path.read_bytes()).hexdigest()


def evaluation_version(root):
    return digest({name: file_digest(Path(root) / name) for name in EVALUATION_FILES})


def generation_settings(root):
    """실제 바인딩의 리터럴을 읽는다. 알 수 없는 표현으로 바뀌면 재검토가 필요하다."""
    config = ast.parse((root / (AI + "app/config.py")).read_text())
    defaults = {
        node.targets[0].id: ast.literal_eval(node.value)
        for node in config.body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id
        in {"DEFAULT_LLM_MODEL_TIMEOUT_SECONDS", "DEFAULT_LLM_RUN_TIMEOUT_SECONDS"}
    }
    agent = ast.parse((root / (AI + "app/support_program_evidence/agent.py")).read_text())
    bindings = [
        node
        for node in ast.walk(agent)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "bind"
    ]
    if len(bindings) != 1:
        raise ValueError("Generation binding needs review")
    bound = {
        item.arg: ast.literal_eval(item.value)
        for item in bindings[0].keywords
        if item.arg in {"max_tokens", "store", "reasoning"}
    }
    timeout = next(item.value for item in bindings[0].keywords if item.arg == "timeout")
    if not isinstance(timeout, ast.Name) or timeout.id != "model_timeout_seconds":
        raise ValueError("Generation timeout binding needs review")
    runner = ast.parse((root / (EVIDENCE + "evaluate.py")).read_text())
    clients = [
        node
        for node in ast.walk(runner)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in {"AsyncOpenAI", "ChatOpenAI"}
    ]
    retries = [
        ast.literal_eval(next(item.value for item in client.keywords if item.arg == "max_retries"))
        for client in clients
    ]
    if len(retries) != 2 or any(value != 0 for value in retries):
        raise ValueError("Generation retry policy needs review")
    input_limit = next(
        ast.literal_eval(node.value)
        for node in runner.body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "MAX_INPUT_TOKENS"
    )
    return {
        "max_input_tokens": input_limit,
        "max_output_tokens": bound["max_tokens"],
        "store": bound["store"],
        "reasoning": bound["reasoning"],
        "model_timeout_seconds": defaults["DEFAULT_LLM_MODEL_TIMEOUT_SECONDS"],
        "run_timeout_seconds": defaults["DEFAULT_LLM_RUN_TIMEOUT_SECONDS"],
        "max_retries": retries[0],
        "response_format": "strict_json_schema",
    }


def build_release(root):
    """저장소 및 실행기에서 동일하게 생성한다. 생성 시각·산출물 자체는 해시에 넣지 않는다."""
    root = Path(root)

    def fingerprint(paths):
        files = {name: file_digest(root / name) for name in paths}
        return {"sha256": digest(files), "files": files}

    prompt = ast.parse((root / (AI + "app/support_program_evidence/prompt.py")).read_text())
    assignment = next(node for node in prompt.body if isinstance(node, ast.Assign))
    # 현재 프롬프트 계약은 리터럴 문자열.strip()이다. 임의 Python을 실행하지 않는다.
    value = assignment.value
    if not (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Attribute)
        and value.func.attr == "strip"
        and not value.args
        and not value.keywords
    ):
        raise ValueError("Prompt expression needs review")
    prompt_text = ast.literal_eval(value.func.value).strip()
    evaluation = fingerprint(EVALUATION_FILES)
    evaluation["version"] = evaluation["sha256"]
    evaluation["scope"] = EVALUATION_SCOPE
    datasets = {}
    catalog = json.loads((root / (OPS + "capture_catalog.json")).read_text())
    for item in catalog:
        fixture_hash = file_digest(root / EVIDENCE / item["fixture"])
        if fixture_hash != item["fixture_sha256"]:
            raise ValueError("Catalog fixture differs")
        datasets[item["id"]] = {
            "fixture_sha256": fixture_hash,
            "case_ids": item["case_ids"],
            "captures": {
                capture["id"]: file_digest(root / EVIDENCE / capture["path"])
                for capture in item["captures"]
            },
        }
    return {
        "schema_version": 1,
        "quality_policy": {
            "definition": ast.literal_eval(
                next(
                    node.value
                    for node in ast.parse((root / (OPS + "quality_policy.py")).read_text()).body
                    if isinstance(node, ast.Assign) and node.targets[0].id == "POLICY"
                )
            ),
            "code_sha256": file_digest(root / (OPS + "quality_policy.py")),
        },
        "evaluation": evaluation,
        "generation": {
            **fingerprint(GENERATION_FILES),
            "prompt_sha256": sha256(prompt_text.encode()).hexdigest(),
            "settings": generation_settings(root),
        },
        "pipeline": fingerprint(PIPELINE_FILES),
        "datasets": datasets,
    }


def read_release():
    return json.loads(RELEASE_PATH.read_text())


def profile(release, dataset_id, mode, config):
    return {
        "schema_version": 2,
        "evaluation_scope": release["evaluation"]["scope"],
        "quality_policy": release["quality_policy"],
        "dataset_id": dataset_id,
        "dataset": release["datasets"][dataset_id],
        "execution_mode": mode,
        "evaluation": release["evaluation"],
        "pipeline": release["pipeline"],
        "generation": release["generation"] if mode == "live" else None,
        "live_config": config if mode == "live" else {},
        "model_operations": [
            {
                "id": f"answer:{case_id}",
                "kind": "answer",
                "case_id": case_id,
                "model": config["model"],
                "max_output_tokens": config["max_output_tokens"],
                **(
                    {"max_input_tokens": config["max_input_tokens"]}
                    if "max_input_tokens" in config
                    else {}
                ),
            }
            for case_id in release["datasets"][dataset_id]["case_ids"]
        ]
        if mode == "live"
        else [],
    }


def make_spec(
    release,
    dataset_id,
    mode,
    config,
    candidate_id,
    reference_id,
    reference_config=None,
    baseline_version=None,
    baseline_review_id=None,
    recovery_config=None,
):
    pinned = profile(release, dataset_id, mode, config)
    captures = pinned["dataset"]["captures"]
    recovery = recovery_config or {}
    reference = reference_config or {}
    return {
        **pinned,
        "profile_sha256": digest(pinned),
        "candidate_capture_id": candidate_id,
        "reference_capture_id": reference_id,
        "candidate_sha256": recovery.get("capture_sha256")
        or (None if mode == "live" else captures[candidate_id]),
        "reference_sha256": recovery.get("reference_capture_sha256")
        or reference.get("capture_sha256")
        or captures[reference_id],
        "reference_config": reference,
        "baseline_version": baseline_version,
        "baseline_review_id": baseline_review_id,
        "recovery_config": recovery,
    }


def verify_spec(spec, spec_hash, actual_release, **selection):
    try:
        if not spec or digest(spec) != spec_hash:
            raise ExecutionSpecMismatch("Execution specification is missing or corrupt")
        actual = make_spec(
            actual_release,
            baseline_version=spec["baseline_version"],
            baseline_review_id=spec["baseline_review_id"],
            **selection,
        )
        if spec != actual:
            raise ExecutionSpecMismatch("Execution environment differs from accepted specification")
    except (KeyError, TypeError) as exc:
        raise ExecutionSpecMismatch("Invalid execution specification") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    release = build_release(args.root)
    if args.write:
        RELEASE_PATH.write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n")
    elif release != read_release():
        raise SystemExit("Execution release is stale; run execution_spec.py --write and review it")
    print("Execution release verified")


if __name__ == "__main__":
    main()
