"""Django에는 평가 SDK 대신 Prefect의 HTTP 실행·조회 계약만 둔다."""

import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID

from django.conf import settings
from django.utils.dateparse import parse_datetime
from django.utils.timezone import is_aware

LOG_PAGE_SIZE = 100


class PrefectUnavailable(Exception):
    pass


def request_json(path, payload=None, *, expected_type=dict, max_bytes=None):
    request = Request(
        settings.PREFECT_API_URL + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with urlopen(request, timeout=3) as response:
            if max_bytes is None:
                data = json.load(response)
            else:
                raw = response.read(max_bytes + 1)
                if len(raw) > max_bytes:
                    raise ValueError("Response too large")
                data = json.loads(raw)
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
        payload = {
            "name": f"ops-{run.id}",
            "parameters": run_parameters(run),
            "idempotency_key": f"ops-{run.id}",
            "state": {"type": "SCHEDULED"},
        }
        for attempt in range(3):
            try:
                result = request_json(f"/deployments/{deployment_id}/create_flow_run", payload)
                break
            except PrefectUnavailable as error:
                # Prefect can return a temporary 503 (including database contention).
                # Keep the same deployment, parameters and idempotency key. Never
                # retry a lost response, malformed result, or a worker/model action.
                cause = error.__cause__
                if not isinstance(cause, HTTPError) or cause.code != 503 or attempt == 2:
                    raise
                time.sleep(0.5 * (attempt + 1))
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


def read_logs(flow_run_id, offset=0):
    """Read only this flow's logs; an unavailable/missing flow is not an empty log."""
    read_run(flow_run_id)
    rows = request_json(
        "/logs/filter",
        {
            "logs": {"flow_run_id": {"any_": [str(flow_run_id)]}},
            "sort": "TIMESTAMP_DESC",
            "offset": offset,
            "limit": LOG_PAGE_SIZE + 1,
        },
        expected_type=list,
        max_bytes=4 * 1024 * 1024,
    )
    try:
        if len(rows) > LOG_PAGE_SIZE + 1:
            raise ValueError("Unexpected log count")
        results = []
        for row in rows:
            if UUID(str(row["flow_run_id"])) != flow_run_id:
                raise ValueError("Unexpected flow log")
            timestamp = parse_datetime(row["timestamp"])
            if (
                timestamp is None
                or not is_aware(timestamp)
                or type(row["level"]) is not int
                or not isinstance(row["message"], str)
                or not isinstance(row["name"], str)
            ):
                raise ValueError("Invalid log response")
            results.append(
                {
                    "id": str(UUID(str(row["id"]))),
                    "timestamp": timestamp.isoformat(),
                    "level": row["level"],
                    "name": row["name"],
                    "message": row["message"],
                }
            )
        return {
            "offset": offset,
            "next_offset": offset + LOG_PAGE_SIZE if len(results) > LOG_PAGE_SIZE else None,
            "results": results[:LOG_PAGE_SIZE],
        }
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise PrefectUnavailable from exc


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
