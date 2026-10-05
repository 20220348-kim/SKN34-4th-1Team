"""Rehearse Git review seed on disposable local Compose; never select existing volumes."""

import argparse
import json
import os
import secrets
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
VERIFY_AND_REVOKE = """
from apps.evaluations.models import EvaluationBaseline, EvaluationCaseReview, EvaluationRun
from apps.evaluations.quality import quality_pass
run = EvaluationRun.objects.get(pk='628ae52a-f417-4b53-b400-d90405e6a7d8')
assert run.execution_mode == 'live' and run.model_api_calls == 6
assert EvaluationRun.objects.count() == 2
assert EvaluationCaseReview.objects.count() == 12 and quality_pass(run)
baseline = EvaluationBaseline.objects.get()
assert baseline.version == 2 and baseline.review.run_id == run.pk
baseline.review = None
baseline.version += 1
baseline.save()
print('Shared human review imported; isolated test baseline revoked.')
"""
VERIFY_PRESERVED = """
from apps.evaluations.models import EvaluationBaseline, EvaluationCaseReview, EvaluationRun
assert EvaluationRun.objects.count() == 2 and EvaluationCaseReview.objects.count() == 12
assert EvaluationBaseline.objects.get().review_id is None
print('Local changes survived restart; no review approval was recreated.')
"""


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ops-image", help="Use an already-built image for a targeted check")
    args = parser.parse_args()
    project = "govbiz-git-seed-test-" + uuid4().hex[:12]
    image = args.ops_image or project + ":ops"
    if not args.ops_image:
        run(["docker", "build", "-t", image, str(ROOT / "backend/ops-service")])
    # Explicit disposable values only; do not load the developer's .env or .env.ops.
    env = {
        **os.environ,
        **dict.fromkeys(
            (
                "POSTGRES_PASSWORD",
                "CLICKHOUSE_PASSWORD",
                "REDIS_PASSWORD",
                "MINIO_PASSWORD",
                "LANGFUSE_SALT",
                "LANGFUSE_ENCRYPTION_KEY",
                "LANGFUSE_NEXTAUTH_SECRET",
                "LANGFUSE_ADMIN_PASSWORD",
                "LANGFUSE_PUBLIC_KEY",
                "LANGFUSE_SECRET_KEY",
                "OPS_DB_PASSWORD",
                "OPS_DB_ROOT_PASSWORD",
                "OPS_DJANGO_SECRET_KEY",
            ),
            secrets.token_hex(32),
        ),
        "LLMOPS_LIVE_ENABLED": "false",
        "LLMOPS_RAG_LIVE_ENABLED": "false",
        "LLMOPS_SCHEDULES_ENABLED": "false",
        "OPENAI_API_KEY": "",
        "LLMOPS_BUDGET_TOKEN": "",
    }
    rendered = json.loads(
        run(
            [
                "docker",
                "compose",
                "--env-file",
                os.devnull,
                "-f",
                str(ROOT / "infrastructure/llmops/compose.yaml"),
                "-f",
                str(ROOT / "infrastructure/llmops/compose.ops.yaml"),
                "--profile",
                "evaluation",
                "config",
                "--format",
                "json",
            ],
            env=env,
            capture_output=True,
        ).stdout
    )
    services = {
        key: rendered["services"][key] for key in ("ops-mysql", "ops-bootstrap", "ops-service")
    }
    for key in ("ops-bootstrap", "ops-service"):
        services[key].pop("build")
        services[key]["image"] = image
    services["ops-mysql"]["environment"]["MYSQL_ROOT_HOST"] = "%"
    services["ops-service"]["ports"] = [{"target": 8000, "host_ip": "127.0.0.1", "published": "0"}]
    config = {
        "name": project,
        "services": services,
        "volumes": {"ops-mysql-data": {}, "ops-results": {}},
        "networks": {"default": {"internal": True}},
    }
    with tempfile.TemporaryDirectory(prefix="govbiz-git-seed-") as directory:
        path = Path(directory) / "compose.json"
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        compose = ["docker", "compose", "-f", str(path)]
        try:
            run(compose + ["up", "-d", "--wait", "--wait-timeout", "180", "ops-service"])
            run(
                compose
                + [
                    "exec",
                    "-T",
                    "-e",
                    "DB_USER=root",
                    "-e",
                    "DB_PASSWORD=" + env["OPS_DB_ROOT_PASSWORD"],
                    "ops-service",
                    "python",
                    "manage.py",
                    "test",
                    "apps.evaluations.test_local_review_seed",
                    "--noinput",
                ]
            )
            run(
                compose
                + [
                    "exec",
                    "-T",
                    "ops-service",
                    "python",
                    "manage.py",
                    "shell",
                    "-c",
                    VERIFY_AND_REVOKE,
                ]
            )
            repeated = run(
                compose + ["run", "--rm", "--no-deps", "ops-bootstrap"], capture_output=True
            )
            if "EXISTING_DATA_PRESERVED" not in repeated.stdout:
                raise RuntimeError("Existing Ops environment was not preserved")
            run(
                compose
                + [
                    "exec",
                    "-T",
                    "ops-service",
                    "python",
                    "manage.py",
                    "shell",
                    "-c",
                    VERIFY_PRESERVED,
                ]
            )
            print(
                "PASS: fresh Compose bootstrap, real MySQL tests and restart preservation; "
                "zero model calls"
            )
        finally:
            # Only this script's random project is eligible for deletion.
            run(compose + ["down", "--volumes", "--remove-orphans"], stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
