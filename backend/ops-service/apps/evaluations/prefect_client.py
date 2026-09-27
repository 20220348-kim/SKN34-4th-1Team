"""Django에는 평가 SDK 대신 Prefect의 HTTP 실행·조회 계약만 둔다."""

import json
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID

from django.conf import settings


class PrefectUnavailable(Exception):
    pass


def request_json(path, payload=None):
    request = Request(
        settings.PREFECT_API_URL + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with urlopen(request, timeout=3) as response:
            data = json.load(response)
        if not isinstance(data, dict):
            raise ValueError("Expected an object")
        return data
    except (URLError, OSError, ValueError) as exc:
        raise PrefectUnavailable from exc


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
                "parameters": {
                    "request_id": str(run.id),
                    "dataset_id": run.dataset_id,
                    "candidate_capture_id": run.candidate_capture_id,
                    "reference_capture_id": run.reference_capture_id,
                    "reference_config": run.reference_config,
                    "execution_mode": run.execution_mode,
                    "live_config": run.live_config,
                    **({"recovery_config": run.recovery_config} if run.recovery_config else {}),
                },
                "idempotency_key": f"ops-{run.id}",
                "state": {"type": "SCHEDULED"},
            },
        )
        return UUID(str(result["id"]))
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
