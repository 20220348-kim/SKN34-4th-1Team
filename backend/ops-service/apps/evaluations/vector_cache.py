"""평가 전용 청크 벡터의 불변 파일과 접수 시 재사용 계획. 운영 색인은 접근하지 않는다."""

import json
import math
import os
import re
import tempfile
from hashlib import sha256
from pathlib import Path
from uuid import UUID

MAX_BYTES = 32 * 1024 * 1024


def cache_name(key):
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("Invalid evaluation vector key")
    return f"vector-cache/{key}.json"


def results_root():
    configured = os.environ.get("LLMOPS_RESULTS_DIR")
    if configured:
        return Path(configured)
    # 기본 경로는 저장소에서 실행하는 평가 CLI 전용. Ops는 Django 설정을 사용한다.
    return Path(__file__).resolve().parents[4] / "work/llmops-ops"


def validate(raw, key):
    value = json.loads(raw)
    if (
        len(raw) > MAX_BYTES
        or not isinstance(value, dict)
        or set(value) != {"schema_version", "key", "dimensions", "points"}
        or value["schema_version"] != 1
        or value["key"] != key
        or type(value["dimensions"]) is not int
        or not 1 <= value["dimensions"] <= 3072
        or not isinstance(value["points"], list)
        or not value["points"]
    ):
        raise ValueError("Invalid evaluation vectors")
    seen = set()
    for point in value["points"]:
        if (
            not isinstance(point, dict)
            or set(point) != {"id", "vector", "payload"}
            or not isinstance(point["id"], str)
            or str(UUID(point["id"])) != point["id"]
            or point["id"] in seen
            or not isinstance(point["payload"], dict)
            or not isinstance(point["vector"], list)
            or len(point["vector"]) != value["dimensions"]
            or any(type(x) not in {int, float} or not math.isfinite(x) for x in point["vector"])
            or not any(point["vector"])
        ):
            raise ValueError("Invalid evaluation vector point")
        seen.add(point["id"])
    return value


def read(root, key, expected_hash=None):
    from .artifact_files import read_file

    raw = read_file(root, cache_name(key), max_bytes=MAX_BYTES)
    if expected_hash is not None and sha256(raw).hexdigest() != expected_hash:
        raise ValueError("Pinned evaluation vectors changed")
    return validate(raw, key), sha256(raw).hexdigest()


def status(root, key):
    """정상적인 파일 부재만 miss다. 손상·권한·전송 실패는 재임베딩으로 숨기지 않는다."""
    cache_name(key)
    try:
        _, fingerprint = read(root, key)
        return {"key": key, "sha256": fingerprint}
    except FileNotFoundError:
        return {"key": key, "sha256": None}


def discover(key):
    # 평가 CLI에는 Django 초기화가 없다. 웹은 기존 HTTP 결과 저장소도 지원한다.
    try:
        from django.conf import settings
    except ModuleNotFoundError:
        settings = None

    if settings is not None and settings.configured:
        if settings.LLMOPS_ARTIFACT_URL:
            from .artifact_store import remote_read

            value = json.loads(remote_read("/v1/vector-cache/" + key, max_bytes=1024))
        else:
            value = status(settings.LLMOPS_RESULTS_DIR, key)
    else:
        value = status(results_root(), key)
    if (
        not isinstance(value, dict)
        or set(value) != {"key", "sha256"}
        or value["key"] != key
        or (
            value["sha256"] is not None
            and (
                not isinstance(value["sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", value["sha256"])
            )
        )
    ):
        raise ValueError("Invalid evaluation vector status")
    return value["sha256"]


def selection(keys):
    fingerprints = {key: discover(key) for key in dict.fromkeys(keys.values())}
    first = {}
    return {
        case: {
            "key": key,
            "sha256": fingerprints[key],
            "source_case_id": first.setdefault(key, case),
        }
        for case, key in keys.items()
    }


def operations(plan, chosen):
    """조회한 파일 해시를 명세에 고정하고, 재사용·동일 실행 내 중복 문서 호출을 제외한다."""
    keys = plan["document_vector_keys"]
    if not isinstance(chosen, dict) or set(chosen) != set(keys):
        raise ValueError("Evaluation vector selection differs")
    first, hashes, omitted = {}, {}, set()
    for case, key in keys.items():
        item = chosen[case]
        if (
            not isinstance(item, dict)
            or set(item) != {"key", "sha256", "source_case_id"}
            or item["key"] != key
            or item["source_case_id"] != first.setdefault(key, case)
            or (
                item["sha256"] is not None
                and (
                    not isinstance(item["sha256"], str)
                    or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
                )
            )
            or item["sha256"] != hashes.setdefault(key, item["sha256"])
        ):
            raise ValueError("Evaluation vector identity differs")
        if item["sha256"] is not None or item["source_case_id"] != case:
            omitted.add(case)
    return [
        item
        for item in plan["model_operations"]
        if not (
            item["kind"] == "document_embedding"
            and item["id"].rsplit(":", 1)[0].removeprefix("document_embedding:") in omitted
        )
    ]


def apply_plan(plan, chosen):
    selected = operations(plan, chosen)
    return {
        **plan,
        "model_operations": selected,
        "live_config": {
            **plan["live_config"],
            "document_vectors": chosen,
            "max_model_calls": len(selected),
            "max_input_tokens": max(item["max_input_tokens"] for item in selected),
        },
    }


def publish(root, key, dimensions, points):
    """검증·정산된 벡터만 원자적으로 공개한다. 동시 생성 시 먼저 공개한 파일을 보존한다."""
    value = {"schema_version": 1, "key": key, "dimensions": dimensions, "points": points}
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    validate(raw, key)
    target = Path(root) / cache_name(key)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.parent.is_symlink():
        raise ValueError("Evaluation vector directory must not be a link")
    descriptor, temporary = tempfile.mkstemp(prefix=".vectors-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            pass
        return read(root, key)
    finally:
        Path(temporary).unlink(missing_ok=True)
