"""Run forward migrations once at a time on the configured Ops MySQL database."""

import hashlib
import json

from django.core.management import BaseCommand, CommandError, call_command
from django.db import DatabaseError, connection

from apps.evaluations.admission import (
    AdmissionUnavailable,
    change_admission,
    status,
    validate_change,
)
from apps.evaluations.models import EvaluationAdmission, EvaluationAdmissionChange
from apps.health.schema import schema_is_ready


def require_initial_pause(change):
    """Accept uninitialized admission or the exact unchanged first-pause replay."""
    expected = {EvaluationAdmission._meta.db_table, EvaluationAdmissionChange._meta.db_table}
    present = expected.intersection(connection.introspection.table_names())
    if not present:
        return
    if present != expected:
        raise CommandError("Incomplete admission schema; inspect before migration.")
    current = status()
    if current["accepting"] and current["version"] == 0:
        if not EvaluationAdmissionChange.objects.exists():
            return
    previous = (
        EvaluationAdmissionChange.objects.filter(pk=change["request_id"])
        .values("accepting", "version", "actor", "reason")
        .first()
    )
    if (
        current["accepting"] is False
        and current["version"] == 1
        and previous
        == {
            "accepting": False,
            "version": 1,
            "actor": change["actor"],
            "reason": change["reason"],
        }
        and EvaluationAdmissionChange.objects.count() == 1
    ):
        return
    raise CommandError("Admission changed; the initial deployment pause cannot be reused.")


class Command(BaseCommand):
    help = "Apply forward migrations under a MySQL advisory lock and verify the resulting schema."

    def add_arguments(self, parser):
        parser.add_argument(
            "--pause-request-id",
            help="UUID for the first deployment pause; writers must already be stopped",
        )
        parser.add_argument("--pause-actor", help="Operator label, not an authenticated identity")
        parser.add_argument("--pause-reason")

    def handle(self, *args, **options):
        pause = None
        if any(
            options[key] is not None for key in ("pause_request_id", "pause_actor", "pause_reason")
        ):
            try:
                pause = validate_change(
                    accepting=False,
                    expected_version=0,
                    request_id=options["pause_request_id"],
                    actor=options["pause_actor"],
                    reason=options["pause_reason"],
                )
            except ValueError as error:
                raise CommandError(str(error)) from None
        if connection.vendor != "mysql":
            raise CommandError("Deployment migration requires MySQL.")
        name = str(connection.settings_dict["NAME"])
        lock = "govbiz-ops-migrate:" + hashlib.sha256(name.encode()).hexdigest()[:40]
        with connection.cursor() as cursor:
            cursor.execute("SELECT GET_LOCK(%s, 0)", [lock])
            if cursor.fetchone() != (1,):
                raise CommandError("Another Ops migration is running or its lock is unavailable.")
        try:
            if pause:
                require_initial_pause(pause)
            call_command(
                "migrate", interactive=False, stdout=self.stdout, verbosity=options["verbosity"]
            )
            if not schema_is_ready():
                raise CommandError("Migration finished without a ready Ops schema.")
            if pause:
                result = change_admission(**pause)
                if (
                    result["accepting"] is not False
                    or result["version"] != 1
                    or result["change"]
                    != {
                        "request_id": str(pause["request_id"]),
                        "version": 1,
                        "accepting": False,
                    }
                ):
                    raise CommandError("Admission pause was not confirmed; keep writers stopped.")
        except (DatabaseError, AdmissionUnavailable, ValueError):
            raise CommandError(
                "Deployment migration or admission check failed; "
                "inspect DB and keep writers stopped."
            ) from None
        finally:
            # GET_LOCK is connection-scoped and survives MySQL DDL commits.
            with connection.cursor() as cursor:
                cursor.execute("SELECT RELEASE_LOCK(%s)", [lock])
                if cursor.fetchone() != (1,):
                    raise CommandError("Ops migration lock release was not confirmed.")
        if pause:
            self.stdout.write(json.dumps(result, ensure_ascii=False))
        else:
            self.stdout.write(self.style.SUCCESS("Ops migrations and schema verified."))
