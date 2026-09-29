"""Inspect an Ops deployment without creating a flow run or changing data."""

import json
from uuid import UUID

from django.core.management import BaseCommand, CommandError

from apps.evaluations.runtime_checks import inspect_runtime


class Command(BaseCommand):
    help = (
        "Check mounted evaluation inputs, results access and Prefect registration (no evaluation)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--run-id", type=UUID, help="Verify artifacts of an existing completed run"
        )

    def handle(self, *args, **options):
        result = inspect_runtime(options["run_id"])
        self.stdout.write(json.dumps(result, ensure_ascii=False, sort_keys=True))
        if result["status"] != "PASS":
            raise CommandError("Ops evaluation deployment checks failed.")
