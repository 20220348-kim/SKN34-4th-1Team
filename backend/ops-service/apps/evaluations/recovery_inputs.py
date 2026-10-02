"""Django와 실행기가 함께 검증하는 후처리 복구 입력. 모델·평가 SDK를 사용하지 않는다."""

import json
from hashlib import sha256
from uuid import UUID

from .catalog import RAG_SCOPE, evaluation_scope, selection, validate_reference_config
from .execution_spec import digest, read_release


def read_recovery_inputs(
    results_root, evidence_root, source_id, *, artifact_reader=None, evidence_reader=None
):
    """원본 요청·검증 manifest에 고정된 완료 응답만 반환한다. 경로는 서버가 구성한다."""
    try:
        source_id = str(UUID(source_id))
        folder = results_root.resolve() / source_id

        def read(root, name):
            path = (root / name).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError("Recovery input path is invalid")
            return path.read_bytes()

        # Ops can read through authenticated HTTP; the Compose runner keeps local reads.
        result_bytes = artifact_reader or (lambda name: read(folder, name))
        evidence_bytes = evidence_reader or (lambda name: read(evidence_root.resolve(), name))
        request_raw = result_bytes("request.json")
        marker = json.loads(request_raw)
        manifest = json.loads(result_bytes("evaluation/manifest.json"))
        rag = evaluation_scope(marker["dataset_id"]) == RAG_SCOPE
        evaluator = read_release()["rag_evaluation" if rag else "evaluation"]
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
        if rag and (
            not spec
            or spec["evaluation_scope"] != RAG_SCOPE
            or (mode != "live" and marker.get("live_config"))
            or manifest.get("scope") != RAG_SCOPE
            or manifest.get("stage") not in {"report", "publish", "completed"}
        ):
            raise ValueError("RAG recovery requires validated replay inputs")
        reference_config = marker.get("reference_config", {})
        validate_reference_config(dataset["id"], marker["reference_capture_id"], reference_config)
        inputs = {
            "fixture": result_bytes("recovery-fixture.json")
            if mode == "recovery"
            else evidence_bytes(dataset["fixture"]),
            "capture": result_bytes("capture/capture.json")
            if mode in {"live", "recovery"}
            else evidence_bytes(candidate["path"]),
            "reference_capture": result_bytes("reference-capture.json")
            if reference_config or mode == "recovery"
            else evidence_bytes(reference["path"]),
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
            if rag:
                if (
                    capture.get("scope") != RAG_SCOPE
                    or capture.get("schemaVersion")
                    not in {"support-program-rag-capture-v1", "support-program-rag-capture-v2"}
                    or capture["fixtureSha256"] != dataset["fixture_sha256"]
                    or case_ids != dataset["case_ids"]
                ):
                    raise ValueError("RAG replay recovery source differs")
                continue
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
        if rag and mode == "live":
            from .rag_replay import validate_live_capture

            capture = json.loads(inputs["capture"])
            validated = validate_live_capture(
                capture,
                json.loads(result_bytes("capture/usage-summary.json")),
                spec,
                marker["execution_spec_sha256"],
            )
            if not validated["completed"]:
                raise ValueError("RAG recovery requires complete responses")
            config["recorded_execution"] = capture["execution"]
        elif rag and mode == "recovery" and marker["recovery_config"].get("recorded_execution"):
            config["recorded_execution"] = marker["recovery_config"]["recorded_execution"]
            if json.loads(inputs["capture"])["execution"] != config["recorded_execution"]:
                raise ValueError("Recovered RAG generation changed")
        if mode == "live" and not rag:
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
