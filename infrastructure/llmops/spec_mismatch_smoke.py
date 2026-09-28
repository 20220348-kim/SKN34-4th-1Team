"""실제 Ops 이미지 명세 A와 프롬프트 파일이 다른 실행기 B의 무료 차단 검증."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = [
    "docker", "compose", "--env-file", "infrastructure/llmops/.env",
    "--env-file", "infrastructure/llmops/.env.ops",
    "-f", "infrastructure/llmops/compose.yaml", "-f", "infrastructure/llmops/compose.ops.yaml",
    "--profile", "evaluation",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # Django 이미지에 포함된 허용 명세를 읽는다. 임의 명세를 API에 접수하지 않는다.
    producer = '''
import json
from uuid import uuid4
from apps.evaluations.catalog import LEGACY_DATASET_ID, LIVE_CAPTURE_ID, live_config
from apps.evaluations.execution_spec import read_release, make_spec, digest
dataset = LEGACY_DATASET_ID
config = live_config(dataset)
spec = make_spec(read_release(), dataset, "live", config, LIVE_CAPTURE_ID, dataset)
print(json.dumps(dict(request_id=str(uuid4()), dataset_id=dataset, execution_mode="live",
    candidate_capture_id=LIVE_CAPTURE_ID, reference_capture_id=dataset, live_config=config,
    execution_spec=spec, execution_spec_sha256=digest(spec))))
'''
    received = subprocess.run(COMPOSE + ["exec", "-T", "ops-service", "python", "-c", producer],
                              cwd=ROOT, check=True, text=True, capture_output=True)
    parameters = json.loads(received.stdout)
    code = '''
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
sys.path.insert(0, "/app/evaluation/support-program-evidence")
import ops_flow
from apps.evaluations.execution_spec import ExecutionSpecMismatch, build_release
os.environ["OPENAI_API_KEY"] = "not-a-real-key-model-function-is-forbidden"
os.environ["LLMOPS_LIVE_ENABLED"] = "true"
os.environ["LLMOPS_RESULTS_DIR"] = "/tmp/spec-mismatch-results"
ops_flow.flow_run = SimpleNamespace(id=str(uuid4()))
def forbidden(*args, **kwargs):
    raise AssertionError("Model and evaluation execution are forbidden in this probe")
ops_flow.evaluate.execute = forbidden
ops_flow.evaluate_capture = forbidden
actual = build_release(ops_flow.ROOT)
assert actual["generation"] != parameters["execution_spec"]["generation"]
assert actual["evaluation"] == parameters["execution_spec"]["evaluation"]
try:
    ops_flow.evaluate_saved_capture.fn(**parameters)
except ExecutionSpecMismatch as error:
    assert str(error) == "EXECUTION_SPEC_MISMATCH"
    assert isinstance(error.__cause__, ExecutionSpecMismatch), "Must fail at actual release comparison"
else:
    raise AssertionError("Mismatched runner was accepted")
folder = Path(os.environ["LLMOPS_RESULTS_DIR"]) / parameters["request_id"]
receipt = json.loads((folder / "preflight.json").read_text())
assert receipt["model_api_calls"] == 0 and receipt["phase"] == "before_model_call"
assert not (folder / "capture").exists()
assert json.loads((folder / "request.json").read_text())["execution_spec"] == parameters["execution_spec"]
print(json.dumps({**receipt, "ops_generation": parameters["execution_spec"]["generation"]["sha256"],
    "runner_generation": actual["generation"]["sha256"], "request_id": parameters["request_id"]}))
'''
    prompt = "backend/ai-service/app/support_program_evidence/prompt.py"
    with tempfile.TemporaryDirectory(prefix="govbiz-spec-smoke-") as temporary:
        directory = Path(temporary)
        directory.chmod(0o755)
        changed = directory / "prompt.py"
        changed.write_text((ROOT / prompt).read_text().replace('"""', '"""검증용 변경.\n', 1))
        changed.chmod(0o644)
        completed = subprocess.run(
            COMPOSE + ["run", "--rm", "--no-deps", "-T", "-e", "OPENAI_API_KEY=",
                       "-v", f"{changed}:/app/{prompt}:ro", "--entrypoint", ".venv/bin/python",
                       "evaluation-runner", "-"],
            cwd=ROOT, input="parameters = " + repr(parameters) + "\n" + code,
            check=True, text=True, capture_output=True,
        )
    result = json.loads(completed.stdout.strip().splitlines()[-1])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print((error.stderr or "Compose probe failed")[-3000:], file=sys.stderr)
        raise SystemExit(error.returncode) from error
