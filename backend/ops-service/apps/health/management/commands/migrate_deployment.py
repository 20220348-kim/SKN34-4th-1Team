"""Run forward migrations once at a time on the configured Ops MySQL database."""

import hashlib

from django.core.management import BaseCommand, CommandError, call_command
from django.db import connection

from apps.health.schema import schema_is_ready


class Command(BaseCommand):
    help = "Apply forward migrations under a MySQL advisory lock and verify the resulting schema."

    def handle(self, *args, **options):
        if connection.vendor != "mysql":
            raise CommandError("Deployment migration requires MySQL.")
        name = str(connection.settings_dict["NAME"])
        lock = "govbiz-ops-migrate:" + hashlib.sha256(name.encode()).hexdigest()[:40]
        with connection.cursor() as cursor:
            cursor.execute("SELECT GET_LOCK(%s, 0)", [lock])
            if cursor.fetchone() != (1,):
                raise CommandError("Another Ops migration is running or its lock is unavailable.")
        try:
            call_command(
                "migrate", interactive=False, stdout=self.stdout, verbosity=options["verbosity"]
            )
            if not schema_is_ready():
                raise CommandError("Migration finished without a ready Ops schema.")
        finally:
            # GET_LOCK is connection-scoped and survives MySQL DDL commits.
            with connection.cursor() as cursor:
                cursor.execute("SELECT RELEASE_LOCK(%s)", [lock])
                if cursor.fetchone() != (1,):
                    raise CommandError("Ops migration lock release was not confirmed.")
        self.stdout.write(self.style.SUCCESS("Ops migrations and schema verified."))
