"""새 로컬 DB에 Git으로 공유한 사람 검토 이력을 한 번만 적재한다."""

import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
from uuid import UUID

from django.apps import apps
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import serializers
from django.core.management import BaseCommand, CommandError, call_command
from django.db import connection, transaction

from apps.evaluations.models import EvaluationBaseline, EvaluationRun
from apps.evaluations.quality import quality_pass
from apps.evaluations.review_eligibility import current_approval
from apps.evaluations.services import read_result
from apps.health.schema import schema_is_ready

SEED_DIR = Path(__file__).resolve().parents[2] / "seed" / "official-v3"
MODELS = {
    "evaluations.evaluationrun",
    "evaluations.evaluationcasereview",
    "evaluations.evaluationreview",
    "evaluations.fixturereview",
    "evaluations.qualityassessment",
    "evaluations.evaluationbaseline",
    "evaluations.evaluationbaselinechange",
}
ACTORS = {
    "requested_by",
    "cancel_requested_by",
    "reviewed_by",
    "assessed_by",
    "selected_by",
    "changed_by",
}
ARTIFACTS = {
    "request.json",
    "evaluation/report.html",
    "evaluation/evidently.json",
    "evaluation/manifest.json",
    "evaluation/comparison.json",
    "evaluation/results.json",
}


def load_seed(directory=SEED_DIR):
    seed = json.loads((directory / "seed.json").read_text())
    if seed["schema_version"] != 1 or str(UUID(seed["source_run_id"])) != seed["source_run_id"]:
        raise CommandError("Unsupported local review seed")
    if not seed["reviewer"].startswith("공유 검토 기록 · "):
        raise CommandError("Shared reviewer provenance is required")
    for record in seed["records"]:
        if record["model"] not in MODELS:
            raise CommandError("Seed may contain review records only, not accounts or budgets")
        for field in ACTORS & record["fields"].keys():
            if record["fields"][field] not in (None, [seed["reviewer"]]):
                raise CommandError("Seed must not reassign history to a local account")
    runs = [record for record in seed["records"] if record["model"] == "evaluations.evaluationrun"]
    if (
        len(runs) != 1
        or runs[0]["pk"] != seed["source_run_id"]
        or runs[0]["fields"]["status"] != "COMPLETED"
        or runs[0]["fields"]["execution_mode"] != "replay"
        or runs[0]["fields"]["model_api_calls"] != 0
    ):
        raise CommandError("Shared seed must contain one completed historical replay")
    if {item["path"] for item in seed["artifacts"]} != ARTIFACTS:
        raise CommandError("Missing or unexpected review artifacts")
    files = {}
    for item in seed["artifacts"]:
        expected_file = item["path"] + (".gz" if item["path"].endswith(".html") else "")
        if item["file"] != expected_file:
            raise CommandError("Invalid seed artifact path")
        path = directory / item["file"]
        opener = gzip.open if path.suffix == ".gz" else open
        with opener(path, "rb") as source:
            raw = source.read(8 * 1024 * 1024 + 1)
        if (
            len(raw) > 8 * 1024 * 1024
            or len(raw) != item["size"]
            or hashlib.sha256(raw).hexdigest() != item["sha256"]
        ):
            raise CommandError("Local review artifact integrity check failed")
        files[item["path"]] = raw
    return seed, files


def copy_artifacts(seed, files):
    root = settings.LLMOPS_RESULTS_DIR
    for name, raw in files.items():
        target = root / seed["source_run_id"] / PurePosixPath(name)
        if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):
            raise CommandError("Invalid local review artifact destination")
        target.parent.mkdir(parents=True, exist_ok=True)
        # A failed initial import may leave identical files. Never overwrite a different file.
        try:
            with target.open("xb") as output:
                output.write(raw)
        except FileExistsError:
            if not target.is_file() or target.read_bytes() != raw:
                raise CommandError(
                    "Existing result file differs; nothing was overwritten"
                ) from None


def import_seed():
    # Presence of any Ops history/configuration makes this an existing environment.
    # In particular, never reinstate a baseline that a teammate has revoked.
    if any(
        model.objects.exists()
        for model in apps.get_app_config("evaluations").get_models()
        if model._meta.model_name != "evaluationadmission"
    ):
        return "EXISTING_DATA_PRESERVED"
    seed, files = load_seed()
    if settings.LLMOPS_ARTIFACT_URL:
        raise CommandError("Local seed requires local results storage")
    with transaction.atomic():
        if get_user_model().objects.filter(username=seed["reviewer"]).exists():
            raise CommandError("Shared reviewer identity already exists without its history")
        # An attribution record, not a login account. Teammates authenticate with their own Core.
        get_user_model().objects.create_user(
            username=seed["reviewer"],
            password=None,
            is_active=False,
            is_staff=False,
        )
        copy_artifacts(seed, files)
        for item in serializers.deserialize("json", json.dumps(seed["records"])):
            item.save()
        run = EvaluationRun.objects.get(pk=seed["source_run_id"])
        baseline = EvaluationBaseline.objects.select_related("review").get(
            dataset_id=run.dataset_id
        )
        read_result(run)
        if not current_approval(baseline.review, run) or not quality_pass(run):
            raise CommandError("Shared approval is incompatible with current evidence or policy")
    return "SHARED_REVIEWS_IMPORTED"


class Command(BaseCommand):
    help = "Initialize an empty local Ops DB from Git; preserve every existing environment."
    requires_system_checks = []

    def handle(self, *args, **options):
        if not settings.LLMOPS_LOCAL_SEED_ENABLED:
            raise CommandError("Local review bootstrap must be explicitly enabled in local Compose")
        if connection.vendor != "mysql":
            raise CommandError("Local review bootstrap requires MySQL")
        name = str(connection.settings_dict["NAME"])
        lock = "govbiz-ops-local-seed:" + hashlib.sha256(name.encode()).hexdigest()[:32]
        with connection.cursor() as cursor:
            cursor.execute("SELECT GET_LOCK(%s, 0)", [lock])
            if cursor.fetchone() != (1,):
                raise CommandError("Another local Ops bootstrap is running")
        try:
            if not connection.introspection.table_names():
                call_command(
                    "migrate_deployment", stdout=self.stdout, verbosity=options["verbosity"]
                )
            elif not schema_is_ready():
                raise CommandError("Existing Ops schema needs migrate_deployment before startup")
            result = import_seed()
        finally:
            with connection.cursor() as cursor:
                cursor.execute("SELECT RELEASE_LOCK(%s)", [lock])
                if cursor.fetchone() != (1,):
                    raise CommandError("Local Ops bootstrap lock release was not confirmed")
        self.stdout.write(self.style.SUCCESS(result))
