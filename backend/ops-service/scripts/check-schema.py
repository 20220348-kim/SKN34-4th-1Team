"""CI-only proof on a fresh MySQL service; never resets or deletes a database."""

import hashlib
import os
import sys
from pathlib import Path

import django

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")


def main():
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("OPS_SCHEMA_TEST_ONLY") != "true"
    ):
        raise RuntimeError("Run only against the dedicated empty CI MySQL service")
    django.setup()
    from django.contrib.auth import get_user_model
    from django.core.management import CommandError, call_command
    from django.db import connection
    from django.test import RequestFactory

    from apps.health.views import health, readiness

    if connection.vendor != "mysql" or connection.introspection.table_names():
        raise RuntimeError(
            "Expected an empty MySQL test database; no existing tables may be changed"
        )
    request = RequestFactory().get("/api/v1/health/ready")
    if health(request).status_code != 200:
        raise AssertionError("Liveness must work on an empty schema")
    response = readiness(request)
    if response.status_code != 503 or response.data["checks"] != {
        "database": "UP",
        "schema": "DOWN",
    }:
        raise AssertionError("An empty connected database must not be ready")
    call_command("migrate_deployment")
    if readiness(request).status_code != 200:
        raise AssertionError("Migrated schema must be ready")
    user = get_user_model().objects.create_user(username="ci-schema-preservation")
    call_command("migrate_deployment")
    if not get_user_model().objects.filter(pk=user.pk).exists():
        raise AssertionError("Repeated migration lost existing data")

    # A separate real MySQL session must exclude a concurrent migration command.
    lock = (
        "govbiz-ops-migrate:"
        + hashlib.sha256(str(connection.settings_dict["NAME"]).encode()).hexdigest()[:40]
    )
    contender = connection.copy(alias="migration-contender")
    try:
        with contender.cursor() as cursor:
            cursor.execute("SELECT GET_LOCK(%s, 0)", [lock])
            if cursor.fetchone() != (1,):
                raise AssertionError("Could not acquire fixture lock")
        try:
            call_command("migrate_deployment")
        except CommandError as error:
            if "Another Ops migration" not in str(error):
                raise
        else:
            raise AssertionError("Concurrent migration was not rejected")
    finally:
        # Socket close can return before MySQL releases this session's lock.
        # Confirm release before testing a fresh migration's immediate GET_LOCK.
        try:
            with contender.cursor() as cursor:
                cursor.execute("SELECT RELEASE_LOCK(%s)", [lock])
                if cursor.fetchone() != (1,):
                    raise AssertionError("Could not release fixture lock")
        finally:
            contender.close()
    call_command("migrate_deployment")
    # Applied migration history alone cannot conceal a physically missing column.
    table = connection.ops.quote_name(user._meta.db_table)
    with connection.cursor() as cursor:
        cursor.execute(f"ALTER TABLE {table} RENAME COLUMN first_name TO ci_hidden_first_name")
    try:
        if readiness(request).status_code != 503:
            raise AssertionError("Missing model column must block readiness")
    finally:
        with connection.cursor() as cursor:
            cursor.execute(f"ALTER TABLE {table} RENAME COLUMN ci_hidden_first_name TO first_name")
    if (
        readiness(request).status_code != 200
        or not get_user_model().objects.filter(pk=user.pk).exists()
    ):
        raise AssertionError("Restored schema or preserved data failed verification")
    print(
        "PASS: empty schema blocked; forward/repeated migration; "
        "lock exclusion; missing column blocked"
    )


if __name__ == "__main__":
    main()
