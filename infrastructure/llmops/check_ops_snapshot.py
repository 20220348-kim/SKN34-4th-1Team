"""Disposable MySQL 8.4 snapshot rehearsal; never selects an existing environment.

Creates its own source, migrations and synthetic audit rows. No model/API calls.
The source image is built in CI, or supplied explicitly for a targeted local check.
"""

import argparse
import json
import secrets
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import ops_snapshot as snapshot

FIXTURE = r"""
from django.contrib.auth import get_user_model
from django.utils import timezone
from apps.evaluations.models import (
    EvaluationRun, EvaluationReview, EvaluationCaseReview, FixtureReview,
    QualityAssessment, EvaluationBaseline, EvaluationBaselineChange, EvaluationBudget,
)
user = get_user_model().objects.create_user('core:42', email='synthetic-reviewer@example.invalid')
run = EvaluationRun.objects.create(
    id='11111111-1111-4111-8111-111111111111', dataset_id='snapshot-synthetic',
    status='COMPLETED', requested_by=user, review_version=1, finished_at=timezone.now(),
    execution_spec={'synthetic': True, 'inputs': ['한글', None, "quote'\\"]},
)
case = EvaluationCaseReview.objects.create(
    run=run, case_id='E01', version=1, decision='SUITABLE', comment='가상 검토 사유 🧪',
    capture_sha256='a'*64, fixture_sha256='b'*64, rubric_version='test', reviewed_by=user,
)
review = EvaluationReview.objects.create(
    run=run, decision='APPROVED', version=1, comment='가상 승인 의견', reviewed_by=user,
    capture_sha256='a'*64, fixture_sha256='b'*64, rubric_version='test',
)
review.case_reviews.add(case)
FixtureReview.objects.create(
    dataset_id=run.dataset_id, version=1, fixture_sha256='b'*64, case_ids=['E01'],
    decision='APPROVED', comment='가상 기준 자료', reviewed_by=user, rubric_version='test',
)
QualityAssessment.objects.create(
    run=run, policy={'synthetic': True}, policy_sha256='c'*64, input_sha256='d'*64,
    inputs={'case_review_id': case.pk}, status='PASS', assessed_by=user,
)
baseline = EvaluationBaseline.objects.create(
    dataset_id=run.dataset_id, version=1, review=review, selected_by=user,
)
EvaluationBaselineChange.objects.create(
    baseline=baseline, version=1, review=review, changed_by=user,
    reason='가상 기준 지정', fixture_sha256='b'*64,
)
EvaluationBudget.objects.create(id=1, call_limit=8, allocated_calls=8, input_token_limit=40000)
print('fixture-created')
"""

VERIFY = r"""
from pathlib import Path
from django.conf import settings
from apps.evaluations.models import EvaluationBaseline, EvaluationRun, EvaluationBudget
run = EvaluationRun.objects.get(pk='11111111-1111-4111-8111-111111111111')
review = run.reviews.get()
assert review.reviewed_by.username == 'core:42'
assert review.comment == '가상 승인 의견'
assert review.case_reviews.get().comment == '가상 검토 사유 🧪'
assert run.assessments.get().status == 'PASS'
baseline = EvaluationBaseline.objects.get(pk=run.dataset_id)
assert baseline.review_id == review.pk and baseline.changes.count() == 1
assert EvaluationBudget.objects.get(pk=1).allocated_calls == 8
assert Path('/results/evaluation/report.html').read_text() == '가상 보고서 🧪'
assert Path('/evaluation-data/fixture.json').read_text() == '{"synthetic":true}'
assert not settings.LLMOPS_LIVE_ENABLED and not settings.LLMOPS_RAG_LIVE_ENABLED
assert not settings.LLMOPS_SCHEDULES_ENABLED
print('application-verified')
"""

VERIFY_LOCAL = r"""
from unittest.mock import patch
from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import RequestFactory
from apps.evaluations.authentication import CoreSessionAuthentication
from apps.evaluations.models import EvaluationRun
assert len(settings.CORE_ACCOUNT_NAMESPACE) == 32
request = RequestFactory().get('/api/v1/ops/session')
request.COOKIES['govbiz_session'] = 'synthetic-session'
with patch('apps.evaluations.authentication.read_core_admin', return_value={
    'accountId': 42, 'email': 'different-teammate@example.invalid', 'role': 'ADMIN',
}):
    first, _ = CoreSessionAuthentication().authenticate(request)
    second, _ = CoreSessionAuthentication().authenticate(request)
    assert first.pk == second.pk
original = get_user_model().objects.get(username='core:42')
local_name = 'core-local:' + settings.CORE_ACCOUNT_NAMESPACE + ':42'
local = get_user_model().objects.get(username=local_name)
assert original.pk != local.pk and not local.has_usable_password()
assert original.email == 'synthetic-reviewer@example.invalid'
run = EvaluationRun.objects.get(pk='11111111-1111-4111-8111-111111111111')
assert run.reviews.get().reviewed_by_id == original.pk
assert run.case_reviews.get().reviewed_by_id == original.pk
print('local-identity-verified')
"""


def source_project(directory, image, mysql_image):
    project = "govbiz-snapshot-test-" + uuid4().hex[:12]
    password = secrets.token_hex(24)
    for label in ("results", "evidence"):
        (directory / label).mkdir(mode=0o755)
    (directory / "results/evaluation").mkdir(mode=0o755)
    (directory / "results/evaluation/report.html").write_text("가상 보고서 🧪")
    (directory / "evidence/fixture.json").write_text('{"synthetic":true}')
    # Hold only this disposable DB's temporary socket-only server for a deterministic check.
    (directory / "hold-init.sh").write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "touch /tmp/snapshot-init-waiting\n"
        "for i in $(seq 1 120); do\n"
        "  [ ! -f /tmp/snapshot-init-release ] || break\n"
        "  sleep 1\n"
        "done\n"
        "[ -f /tmp/snapshot-init-release ] || exit 1\n"
    )
    (directory / "hold-init.sh").chmod(0o755)
    env = {
        "DJANGO_SECRET_KEY": "snapshot-isolated-fixture-only",
        "DB_HOST": "ops-mysql",
        "DB_PORT": "3306",
        "DB_NAME": "snapshot_test",
        "DB_USER": "govbiz",
        "DB_PASSWORD": password,
        "LLMOPS_RESULTS_DIR": "/results",
        "LLMOPS_EVIDENCE_DIR": "/evaluation-data",
        **dict.fromkeys(snapshot.FLAGS, "false"),
    }
    config = {
        "name": project,
        "services": {
            "ops-mysql": {
                "image": mysql_image,
                "environment": {
                    "MYSQL_ROOT_PASSWORD": password,
                    "MYSQL_DATABASE": "snapshot_test",
                    "MYSQL_USER": "govbiz",
                    "MYSQL_PASSWORD": password,
                },
                "volumes": [
                    "database:/var/lib/mysql",
                    f"{directory / 'hold-init.sh'}:/docker-entrypoint-initdb.d/hold-init.sh:ro",
                ],
            },
            "ops-service": {
                "image": image,
                "environment": env,
                "volumes": [
                    f"{directory / 'results'}:/results:ro",
                    f"{directory / 'evidence'}:/evaluation-data:ro",
                ],
            },
        },
        "networks": {"default": {"internal": True}},
        "volumes": {"database": {}},
    }
    snapshot.exclusive(directory / "compose.json", json.dumps(config).encode())


def reject_initializing_database(mysql):
    deadline = time.monotonic() + 90
    try:
        while True:
            try:
                snapshot.run(["docker", "exec", mysql, "test", "-f", "/tmp/snapshot-init-waiting"])
                break
            except snapshot.SnapshotError:
                if time.monotonic() >= deadline:
                    raise snapshot.SnapshotError(
                        "Disposable MySQL init marker did not appear"
                    ) from None
                time.sleep(1)
        temporary = snapshot.run(
            ["docker", "exec", "-i", mysql, *snapshot.AUTH, "mysql", "-uroot", "-N", "-B"],
            data=b"SELECT @@GLOBAL.skip_networking;",
        )
        assert temporary.strip() == b"1", "Fixture must hold the temporary socket-only server"
        try:
            snapshot.sql(mysql, "snapshot_test", "SELECT 1;")
        except snapshot.SnapshotError:
            pass
        else:
            raise AssertionError("Temporary initialization server was accepted as ready")
    finally:
        snapshot.run(["docker", "exec", mysql, "touch", "/tmp/snapshot-init-release"])


def rehearse(image):
    image = json.loads(snapshot.run(["docker", "image", "inspect", image]))[0]["Id"]
    mysql_image = json.loads(snapshot.run(["docker", "image", "inspect", "mysql:8.4"]))[0]["Id"]
    with tempfile.TemporaryDirectory(prefix="govbiz-snapshot-test-") as temporary:
        root = Path(temporary)
        source, target, local_target = root / "source", root / "target", root / "local-target"
        source.mkdir()
        try:
            source_project(source, image, mysql_image)
            snapshot.compose(source, "up", "-d", "ops-mysql")
            mysql = snapshot.compose(source, "ps", "-q", "ops-mysql").decode().strip()
            reject_initializing_database(mysql)
            deadline = time.monotonic() + 90
            while True:
                try:
                    snapshot.sql(mysql, "snapshot_test", "SELECT 1;")
                    break
                except ValueError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(1)
            base = [
                "run",
                "--rm",
                "--no-deps",
                "-T",
                "--entrypoint",
                "python",
                "ops-service",
            ]
            snapshot.compose(source, *base, "manage.py", "migrate", "--noinput")
            snapshot.compose(source, *base, "manage.py", "shell", "-c", FIXTURE)
            snapshot.compose(source, "create", "ops-service")
            ops = snapshot.compose(source, "ps", "-aq", "ops-service").decode().strip()
            key, archive = root / "key", root / "snapshot.enc"
            snapshot.exclusive(key, secrets.token_hex(32).encode() + b"\n")
            snapshot.compose(source, "start", "ops-service")
            proof = snapshot.backup(ops, mysql, archive, key, stop_writers=True)
            assert snapshot.inspect(ops)["State"]["Running"]
            before = snapshot.dump(mysql, "snapshot_test")
            result = snapshot.restore(archive, key, target)
            assert result["status"] == "RESTORED"
            assert result["sha256"] == proof["sha256"]
            assert snapshot.restore(archive, key, target)["status"] == "ALREADY_RESTORED"
            assert b"application-verified" in snapshot.compose(
                target, *base, "manage.py", "shell", "-c", VERIFY
            )
            # Drift must block replay without undoing the new row or damaging the source.
            state = json.loads((target / "snapshot-state.json").read_text())
            assert (
                snapshot.sql(
                    state["mysql_id"],
                    "snapshot_test",
                    "SELECT @@GLOBAL.event_scheduler;",
                ).strip()
                == b"OFF"
            )
            snapshot.sql(
                state["mysql_id"],
                "snapshot_test",
                "UPDATE evaluations_evaluationbudget SET call_limit=9 WHERE id=1;",
            )
            try:
                snapshot.restore(archive, key, target)
            except ValueError as error:
                assert "differs" in str(error)
            else:
                raise AssertionError("Changed target was overwritten")
            assert (
                snapshot.sql(
                    state["mysql_id"],
                    "snapshot_test",
                    "SELECT call_limit FROM evaluations_evaluationbudget WHERE id=1;",
                ).strip()
                == b"9"
            )
            assert snapshot.dump(mysql, "snapshot_test") == before
            local_result = snapshot.restore(
                archive, key, local_target, local_ops_image=image, core_port=8080
            )
            assert local_result["status"] == "RESTORED"
            assert b"local-identity-verified" in snapshot.compose(
                local_target, *base, "manage.py", "shell", "-c", VERIFY_LOCAL
            )
            assert b"application-verified" in snapshot.compose(
                local_target, *base, "manage.py", "shell", "-c", VERIFY
            )
            # New local account creation cannot alter the source or get erased by restore replay.
            local_state = json.loads((local_target / "snapshot-state.json").read_text())
            local_before = snapshot.dump(local_state["mysql_id"], "snapshot_test")
            try:
                snapshot.restore(archive, key, local_target, local_ops_image=image, core_port=8080)
            except ValueError as error:
                assert "differs" in str(error)
            else:
                raise AssertionError("Local login history was overwritten")
            assert snapshot.dump(local_state["mysql_id"], "snapshot_test") == local_before
            assert snapshot.dump(mysql, "snapshot_test") == before
        finally:
            # Clean up only paths/resources allocated by this invocation.
            for directory in (local_target, target, source):
                if (directory / "compose.json").is_file():
                    subprocess.run(
                        [
                            "docker",
                            "compose",
                            "-f",
                            str(directory / "compose.json"),
                            "down",
                            "--volumes",
                            "--remove-orphans",
                        ],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=True,
                    )
            for restored in (target, local_target):
                marker = restored / "snapshot-state.json"
                if marker.exists():
                    state = json.loads(marker.read_text())
                    for label in ("results", "evidence"):
                        subprocess.run(
                            ["docker", "volume", "rm", state[label]],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            check=False,
                        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ops-image")
    args = parser.parse_args()
    image = args.ops_image or "govbiz-ops-snapshot-test:" + uuid4().hex[:12]
    built = not args.ops_image
    if built:
        snapshot.run(
            [
                "docker",
                "build",
                "-t",
                image,
                str(Path(__file__).resolve().parents[2] / "backend/ops-service"),
            ],
            timeout=600,
        )
    try:
        rehearse(image)
    finally:
        if built:
            # A cached build can share its ID with another test or user's tag.
            # Delete only our unique tag, never the shared image ID or supplied image.
            snapshot.run(["docker", "image", "rm", image])
    print(
        "PASS: encrypted MySQL 8.4 + files + Django review/baseline/budget restore; "
        "replay/drift/source preservation and cleanup; no model calls"
    )


if __name__ == "__main__":
    main()
