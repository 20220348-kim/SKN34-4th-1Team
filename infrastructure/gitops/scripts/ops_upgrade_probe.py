"""Read-only probe sent to the existing Ops container before an upgrade.

It uses the installed Django models and Prefect HTTP client, so the old image
does not need a new management command. No migrations or writes run here.
"""

import json
import os
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import UUID

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "CRASHED"}
PREFECT_ACTIVE = {"SCHEDULED", "PENDING", "RUNNING", "PAUSED", "CANCELLING"}
PAGE_SIZE = 100
MAX_PAGES = 20


def database_snapshot():
    from apps.evaluations import models
    from apps.evaluations.models import EvaluationBudgetReservation, EvaluationRun
    from django.db.models import Count

    states = dict(
        EvaluationRun.objects.order_by()
        .values("status")
        .annotate(total=Count("id"))
        .values_list("status", "total")
    )
    admission_model = getattr(models, "EvaluationAdmission", None)
    admission = None
    if admission_model is not None:
        admission = (
            admission_model.objects.filter(pk=1).values("accepting", "version").first()
        )
        if admission is None:
            admission = {"accepting": True, "version": 0}
    return {
        "states": states,
        "admission": admission,
        "open_reservations": EvaluationBudgetReservation.objects.filter(
            closed_at__isnull=True
        ).count(),
    }


def deployment_snapshot(request, name):
    data = request("/deployments/name/" + quote(name, safe="/"))
    identity = str(UUID(data["id"]))
    flow = str(UUID(data["flow_id"]))
    schedules = data["schedules"]
    if (
        data["name"] != name.rsplit("/", 1)[1]
        or type(data["paused"]) is not bool
        or not isinstance(schedules, list)
    ):
        raise ValueError("Invalid deployment")
    seen = set()
    for schedule in schedules:
        schedule_id = str(UUID(schedule["id"]))
        if schedule_id in seen or type(schedule["active"]) is not bool:
            raise ValueError("Invalid schedule")
        seen.add(schedule_id)
    return {
        "id": identity,
        "flow_id": flow,
        "paused": data["paused"],
        "schedules": {row["id"]: row["active"] for row in schedules},
    }


def prefect_snapshot(request, name):
    deployment = deployment_snapshot(request, name)
    # Scan the flow, including runs from older deployments of that same flow.
    # Filtering out terminal states in SQL would miss NULL/unknown states.
    selection = {"flows": {"id": {"any_": [deployment["flow_id"]]}}}
    total = request("/flow_runs/count", selection, expected_type=int)
    if type(total) is not int or total < 0 or total >= PAGE_SIZE * MAX_PAGES:
        raise ValueError("Incomplete flow history")
    seen = set()
    active = 0
    for offset in range(0, total + 1, PAGE_SIZE):
        rows = request(
            "/flow_runs/filter",
            {**selection, "limit": PAGE_SIZE, "offset": offset, "sort": "ID_DESC"},
            expected_type=list,
        )
        if not isinstance(rows, list) or len(rows) != min(PAGE_SIZE, total - offset):
            raise ValueError("Flow history changed or is incomplete")
        for row in rows:
            identity = str(UUID(row["id"]))
            state = row["state_type"]
            if (
                identity in seen
                or row["flow_id"] != deployment["flow_id"]
                or state not in TERMINAL | PREFECT_ACTIVE
            ):
                raise ValueError("Invalid flow evidence")
            seen.add(identity)
            active += state in PREFECT_ACTIVE
    after = request("/flow_runs/count", selection, expected_type=int)
    if (
        type(after) is not int
        or after != total
        or len(seen) != total
        or deployment_snapshot(request, name) != deployment
    ):
        raise ValueError("Prefect changed during inspection")
    return {
        "unfinished_flows": active,
        "inspected_flows": total,
        # Even paused deployments must have their schedules explicitly disabled.
        "active_schedules": sum(deployment["schedules"].values()),
    }


def inspect_upgrade(request, deployment_name):
    report = {
        "schemaVersion": 3,
        "scope": "ops_upgrade_preflight",
        "status": "UNKNOWN",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "checks": {},
        "admission_blocked": False,
        "admission_supported": False,
        "backup_verified": False,
        "evaluation_executed": False,
    }
    try:
        before = database_snapshot()
        admission = before.get("admission")
        if admission is not None:
            if (
                type(admission["accepting"]) is not bool
                or type(admission["version"]) is not int
                or admission["version"] < 0
                or (not admission["accepting"] and admission["version"] == 0)
            ):
                raise ValueError("Invalid admission evidence")
            report["admission_supported"] = True
            report["admission_blocked"] = not admission["accepting"]
            report["admission_version"] = admission["version"]
        report["checks"].update(
            # An old image without admission control cannot attest a closed gate.
            open_admission=None if admission is None else int(admission["accepting"]),
            unsettled_evaluations=sum(
                count
                for state, count in before["states"].items()
                if state not in TERMINAL
            ),
            open_reservations=before["open_reservations"],
        )
        report["checks"].update(prefect_snapshot(request, deployment_name))
        if database_snapshot() != before:
            raise ValueError("Ops changed during inspection")
        if admission is None:
            report["status"] = "BLOCKED"
            report["reason"] = "admission_control_unsupported"
        elif admission["accepting"]:
            report["status"] = "BLOCKED"
            report["reason"] = "admission_open"
        else:
            report["status"] = (
                "BLOCKED"
                if any(
                    value
                    for key, value in report["checks"].items()
                    if key != "inspected_flows"
                )
                else "PASS"
            )
    except Exception:  # noqa: BLE001 -- process boundary returns UNKNOWN, never success or raw errors
        # Includes old/incompatible DB schema and remote failures. Never expose
        # SQL, environment values, remote payloads or exception text.
        report["reason"] = "incomplete_or_changing_evidence"
    report["checked_at"] = datetime.now(timezone.utc).isoformat()
    return report


if __name__ == "__main__":
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django

    django.setup()
    from apps.evaluations.prefect_client import request_json
    from django.conf import settings

    print(json.dumps(inspect_upgrade(request_json, settings.PREFECT_DEPLOYMENT_NAME)))
