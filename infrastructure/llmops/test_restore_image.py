"""Exercise the CI image handoff in Bash without starting Docker or model services."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "sha256:" + "a" * 64


@pytest.fixture
def image_step(tmp_path):
    workflow = yaml.safe_load((ROOT / ".github/workflows/llmops-ci.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["integration"]["steps"]
        if step.get("name") == "Resolve immutable Ops image for restore checks"
    )
    docker = tmp_path / "docker"
    docker.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "args = sys.argv[1:]\n"
        "with open(os.environ['IMAGE_TEST_CALLS'], 'a') as output:\n"
        "    output.write(json.dumps(args) + '\\n')\n"
        "if args[0] == 'compose':\n"
        "    assert args[-3:] == ['images', '-q', 'ops-service']\n"
        "    print(os.environ['IMAGE_TEST_REFERENCE'])\n"
        "    sys.exit(int(os.environ.get('IMAGE_TEST_COMPOSE_EXIT', '0')))\n"
        "assert args[:4] == ['image', 'inspect', '--format', '{{.Id}}']\n"
        "assert args[4:] == [os.environ['IMAGE_TEST_REFERENCE']]\n"
        "print(os.environ['IMAGE_TEST_CANONICAL'])\n"
        "sys.exit(int(os.environ.get('IMAGE_TEST_INSPECT_EXIT', '0')))\n"
    )
    docker.chmod(0o755)

    def execute(reference, canonical=IMAGE, **overrides):
        output = tmp_path / "github-env"
        calls = tmp_path / "calls.jsonl"
        process = subprocess.run(
            ["bash", "-euo", "pipefail", "-c", step["run"]],
            env={
                **os.environ,
                "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
                "GITHUB_ENV": str(output),
                "IMAGE_TEST_CALLS": str(calls),
                "IMAGE_TEST_REFERENCE": reference,
                "IMAGE_TEST_CANONICAL": canonical,
                **overrides,
            },
            capture_output=True,
            text=True,
            timeout=10,
        )
        return (
            process,
            output.read_text() if output.exists() else "",
            [json.loads(row) for row in calls.read_text().splitlines()],
        )

    return execute


@pytest.mark.parametrize("reference", [IMAGE.removeprefix("sha256:"), IMAGE])
def test_compose_id_is_resolved_to_verified_immutable_image(image_step, reference):
    result, exported, calls = image_step(reference)
    assert result.returncode == 0, result.stderr
    assert exported == f"RESTORE_DOCKER_IMAGE={IMAGE}\n"
    assert len(calls) == 2


@pytest.mark.parametrize("reference, exit_code", [("", "0"), (IMAGE, "1")])
def test_empty_or_failed_compose_query_never_exports_an_image(image_step, reference, exit_code):
    result, exported, calls = image_step(reference, IMAGE_TEST_COMPOSE_EXIT=exit_code)
    assert result.returncode != 0
    assert not exported
    assert len(calls) == 1


def test_failed_inspect_does_not_export_its_stdout_as_success(image_step):
    result, exported, _ = image_step(IMAGE, IMAGE_TEST_INSPECT_EXIT="1")
    assert result.returncode != 0
    assert not exported


@pytest.mark.parametrize("canonical", ["", "a" * 64, "latest", IMAGE + "\n" + IMAGE])
def test_noncanonical_or_multiple_images_are_rejected(image_step, canonical):
    result, exported, _ = image_step(IMAGE, canonical=canonical)
    assert result.returncode != 0
    assert not exported
