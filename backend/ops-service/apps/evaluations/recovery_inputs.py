"""Django와 실행기가 함께 검증하는 후처리 복구 입력. 모델·평가 SDK를 사용하지 않는다."""

import json
from hashlib import sha256
from uuid import UUID

from .catalog import selection, validate_reference_config
from .execution_spec import digest, read_release


def read_recovery_inputs(results_root, evidence_root, source_id):
    """원본 요청·검증 manifest에 고정된 완료 응답만 반환한다. 경로는 서버가 구성한다."""
    try:
        source_id = str(UUID(source_id))
        folder = results_root.resolve() / source_id

        def read(root, name):
            path = (root / name).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError("Recovery input path is invalid")
            return path.read_bytes()

        request_raw = read(folder, "request.json")
        marker = json.loads(request_raw)
        manifest = json.loads(read(folder, "evaluation/manifest.json"))
        evaluator = read_release()["evaluation"]
        spec = marker.get("execution_spec")
        if manifest.get("evaluator_version") != evaluator["version"] or (
            spec
            and (
                spec["evaluation"] != evaluator
                or digest(spec) != marker.get("execution_spec_sha256")
                or manifest.get("execution_spec_sha256") != marker.get("execution_spec_sha256")
            )
        ):
            raise ValueError("Recovery evaluator is incompatible or unverified")
        dataset, candidate, reference = selection(
            marker["dataset_id"], marker["candidate_capture_id"], marker["reference_capture_id"]
        )
        if (
            marker["request_id"] != source_id
            or type(manifest["model_api_calls"]) is not int
            or manifest["model_api_calls"] != 0
            or manifest["fixture_sha256"] != dataset["fixture_sha256"]
        ):
            raise ValueError("Recovery source differs")
        mode = marker.get("execution_mode", "replay")
        if mode not in {"replay", "live", "recovery"}:
            raise ValueError("Invalid source mode")
        reference_config = marker.get("reference_config", {})
        validate_reference_config(dataset["id"], marker["reference_capture_id"], reference_config)
        evidence_root = evidence_root.resolve()
        inputs = {
            "fixture": read(folder, "recovery-fixture.json")
            if mode == "recovery"
            else read(evidence_root, dataset["fixture"]),
            "capture": read(folder, "capture/capture.json")
            if mode in {"live", "recovery"}
            else read(evidence_root, candidate["path"]),
            "reference_capture": read(folder, "reference-capture.json")
            if reference_config or mode == "recovery"
            else read(evidence_root, reference["path"]),
        }
        config = {
            "source_run_id": source_id,
            "source_request_sha256": sha256(request_raw).hexdigest(),
            "evaluator_sha256": evaluator["sha256"],
            "evaluator_version": evaluator["version"],
        }
        for name, raw in inputs.items():
            actual_hash = sha256(raw).hexdigest()
            if actual_hash != manifest[f"{name}_sha256"]:
                raise ValueError("Recovery input changed")
            config[f"{name}_sha256"] = actual_hash
            if name == "fixture":
                continue
            capture = json.loads(raw)
            case_ids = [case["caseId"] for case in capture["cases"]]
            if (
                capture["completed"] is not True
                or capture["fixtureSha256"] != dataset["fixture_sha256"]
                or len(case_ids) != len(set(case_ids))
                or not set(dataset["case_ids"]) <= set(case_ids)
                or capture.get("caseIds", case_ids) != case_ids
                or any(
                    case.get("error") or not isinstance(case.get("response"), dict)
                    for case in capture["cases"]
                )
            ):
                raise ValueError("Recovery requires complete responses")
        if (
            reference_config
            and config["reference_capture_sha256"] != reference_config["capture_sha256"]
        ):
            raise ValueError("Reference snapshot differs")
        if mode == "recovery" and any(
            config[f"{name}_sha256"] != marker["recovery_config"][f"{name}_sha256"]
            for name in inputs
        ):
            raise ValueError("Recovery snapshot differs from dispatch")
        if mode == "live":
            capture = json.loads(inputs["capture"])
            approved = marker["live_config"]
            if (
                capture["model"] != approved["model"]
                or capture["caseIds"] != dataset["case_ids"]
                or capture["fixtureSha256"] != approved["fixture_sha256"]
                or type(capture["modelApiCalls"]) is not int
                or capture["modelApiCalls"] != approved["max_model_calls"]
                or capture["maxModelCalls"] != approved["max_model_calls"]
                or capture["maxOutputTokens"] != approved["max_output_tokens"]
            ):
                raise ValueError("Source generation does not match its approval")
        return marker, config, inputs
    except (OSError, KeyError, TypeError, AttributeError) as exc:
        raise ValueError("Recovery inputs are unavailable") from exc
