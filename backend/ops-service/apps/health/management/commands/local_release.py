"""Pause evaluation admission across an Argo release, then resume only our pause."""

import re
from uuid import NAMESPACE_URL, uuid5

from django.core.management import BaseCommand, CommandError, call_command
from django.db import transaction

from apps.evaluations.admission import change_admission, lock_admission
from apps.evaluations.models import EvaluationAdmissionChange, EvaluationRun

ACTOR = "local-argo-release"
ACTIVE = (
    EvaluationRun.Status.REQUESTED,
    EvaluationRun.Status.QUEUED,
    EvaluationRun.Status.RUNNING,
    EvaluationRun.Status.CANCELLING,
)


def identity(release):
    if not re.fullmatch(r"govbiz-local/v1\.[1-9][0-9]*\.[1-9][0-9]*", release):
        raise CommandError("A verified local release tag is required.")
    return uuid5(NAMESPACE_URL, release + "/pause"), uuid5(NAMESPACE_URL, release + "/resume")


def own_pause(state, pause):
    if state.accepting or state.version != pause.version or pause.actor != ACTOR:
        raise CommandError(
            "Admission changed after this release paused it; inspect before retrying."
        )


def prepare(release):
    pause_id, resume_id = identity(release)
    with transaction.atomic():
        state = lock_admission()
        if EvaluationAdmissionChange.objects.filter(pk=resume_id).exists():
            raise CommandError("This release already resumed admission; publish a new release.")
        pause = EvaluationAdmissionChange.objects.filter(pk=pause_id).first()
        if pause is None:
            latest = EvaluationAdmissionChange.objects.filter(version=state.version).first()
            if (
                not state.accepting
                and latest
                and latest.actor == ACTOR
                and latest.pk == identity(latest.reason)[0]
            ):
                raise CommandError(
                    "Another local release is paused; recover it before a new release."
                )
            change_admission(
                accepting=False,
                expected_version=state.version,
                request_id=pause_id,
                actor=ACTOR,
                reason=release,
            )
        else:
            own_pause(state, pause)
    # Commit the pause before probing runs. New requests use the same admission lock.
    # Existing runs may finish; retries may proceed once every active run has drained.
    if EvaluationRun.objects.filter(status__in=ACTIVE).exists():
        raise CommandError(
            "Active evaluations remain; admission stays paused. Retry after they finish."
        )
    call_command("migrate_deployment")
    with transaction.atomic():
        state = lock_admission()
        own_pause(state, EvaluationAdmissionChange.objects.get(pk=pause_id))


def resume(release):
    pause_id, resume_id = identity(release)
    with transaction.atomic():
        state = lock_admission()
        if EvaluationAdmissionChange.objects.filter(pk=resume_id).exists():
            # An old PostSync replay must never reopen a newer operator pause.
            return
        pause = EvaluationAdmissionChange.objects.filter(pk=pause_id).first()
        if pause is None:
            raise CommandError("No admission pause belongs to this release.")
        own_pause(state, pause)
        # A maintenance pause that predated deployment remains closed.
        change_admission(
            accepting=pause.previous_accepting,
            expected_version=pause.version,
            request_id=resume_id,
            actor=ACTOR,
            reason=release,
        )


class Command(BaseCommand):
    help = "Argo PreSync: pause/drain/migrate; PostSync: restore this release's admission state."

    def add_arguments(self, parser):
        parser.add_argument("phase", choices=("prepare", "resume"))
        parser.add_argument("--release", required=True)

    def handle(self, *args, **options):
        identity(options["release"])
        if options["phase"] == "resume":
            # Read-only checks of new artifacts and Prefect registration. No model calls.
            call_command("check_evaluation_runtime")
        (prepare if options["phase"] == "prepare" else resume)(options["release"])
        self.stdout.write("Local release admission phase completed.")
