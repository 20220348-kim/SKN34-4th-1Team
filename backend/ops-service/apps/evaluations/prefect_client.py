"""Django에는 평가 SDK 대신 Prefect의 HTTP 실행·조회 계약만 둔다."""

import json
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID

from django.conf import settings


class PrefectUnavailable(Exception):
    pass


def request_json(path, payload=None, *, expected_type=dict):
    request = Request(
        settings.PREFECT_API_URL + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with urlopen(request, timeout=3) as response:
            data = json.load(response)
        if not isinstance(data, expected_type):
            raise ValueError("Unexpected response type")
        return data
    except (URLError, OSError, ValueError) as exc:
        raise PrefectUnavailable from exc


def run_parameters(run):
    return {
        "request_id": str(run.id),
        "dataset_id": run.dataset_id,
        "candidate_capture_id": run.candidate_capture_id,
        "reference_capture_id": run.reference_capture_id,
        "reference_config": run.reference_config,
        "execution_mode": run.execution_mode,
        "live_config": run.live_config,
        **({"recovery_config": run.recovery_config} if run.recovery_config else {}),
        **(
            {
                "execution_spec": run.execution_spec,
                "execution_spec_sha256": run.execution_spec_sha256,
            }
            if run.execution_spec
            else {}
        ),
    }


def create_run(run):
    try:
        deployment = request_json(
            "/deployments/name/" + quote(settings.PREFECT_DEPLOYMENT_NAME, safe="/")
        )
        deployment_id = UUID(str(deployment["id"]))
        result = request_json(
            f"/deployments/{deployment_id}/create_flow_run",
            {
                "name": f"ops-{run.id}",
                "parameters": run_parameters(run),
                "idempotency_key": f"ops-{run.id}",
                "state": {"type": "SCHEDULED"},
            },
        )
        return UUID(str(result["id"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise PrefectUnavailable from exc


def find_run(run):
    """접수 응답 유실 시 기존 실행만 찾는다. 실행 생성·재시작 요청은 보내지 않는다."""
    key = f"ops-{run.id}"
    rows = request_json(
        "/flow_runs/filter",
        {"flow_runs": {"idempotency_key": {"any_": [key]}}, "limit": 2},
        expected_type=list,
    )
    if not rows:
        return None
    try:
        if len(rows) != 1 or rows[0]["idempotency_key"] != key:
            raise ValueError("Ambiguous dispatch")
        parameters = dict(rows[0]["parameters"])
        # Prefect는 deployment 기본값인 빈 recovery_config를 응답에 포함할 수 있다.
        for name in ("recovery_config", "execution_spec", "execution_spec_sha256"):
            if parameters.get(name) in (None, {}, ""):
                parameters.pop(name, None)
        if parameters != run_parameters(run):
            raise ValueError("Dispatch parameters differ")
        return UUID(str(rows[0]["id"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise PrefectUnavailable from exc


def read_run(flow_run_id):
    data = request_json(f"/flow_runs/{flow_run_id}")
    try:
        if UUID(str(data["id"])) != flow_run_id or not isinstance(data["state_type"], str):
            raise ValueError("Invalid run response")
    except (KeyError, TypeError, ValueError) as exc:
        raise PrefectUnavailable from exc
    return data


def cancel_run(flow_run_id):
    """강제 완료 없이 취소를 제안한다. 실제 종료는 별도 read_run으로 확인한다."""
    result = request_json(
        f"/flow_runs/{flow_run_id}/set_state",
        {"state": {"type": "CANCELLING"}, "force": False},
    )
    state = result.get("state")
    if (
        result.get("status") not in ("ACCEPT", "REJECT")
        or not isinstance(state, dict)
        or state.get("type") not in ("CANCELLING", "CANCELLED", "COMPLETED", "FAILED", "CRASHED")
    ):
        raise PrefectUnavailable
