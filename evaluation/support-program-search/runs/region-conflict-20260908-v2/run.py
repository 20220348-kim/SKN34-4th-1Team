"""Run only the five frozen after cases with v1 safeguards and a separate v2 ledger."""

import argparse
import asyncio
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
V1 = ROOT.with_name("region-conflict-20260908-v1")
FIXTURE_SHA256 = "93e56eb6885a4124d6986e58e2ebfc4e90a9cad8ed8eada8add170266adc3b7e"


def load_runner():
    spec = importlib.util.spec_from_file_location("region_conflict_v2_engine", V1 / "run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = ROOT
    module.PHASES = ("after",)
    module.PLANS = {"after": module.PLANS["after"]}
    module.MAX_ATTEMPTS = 5
    module.AFTER_FILE = ROOT / "after_agent.py"
    module.AFTER_PROMPT_FILE = ROOT / "after_prompt.py"
    return module


engine = load_runner()


async def run(execute=False, offline=False, phase="after", key_file=None):
    # Keep all 54 expectations frozen, including the v1 failure; never fit labels to output.
    fixture = json.loads(engine.FIXTURE_FILE.read_text(encoding="utf-8"))
    if engine.sha(fixture) != FIXTURE_SHA256:
        raise engine.GuardRejected("FROZEN_V1_FIXTURE_CHANGED")
    return await engine.run(execute=execute, offline=offline, phase=phase, key_file=key_file)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--phase", choices=("after",), default="after")
    parser.add_argument("--key-file", type=Path)
    args = parser.parse_args()
    try:
        result = asyncio.run(run(**vars(args)))
    except Exception as error:
        print(json.dumps({"status": "failed", "errorType": type(error).__name__,
                          "reasonCode": str(error) if isinstance(error, engine.GuardRejected) else "EXECUTION_FAILED"}))
        result = 2
    raise SystemExit(result)
