"""격리된 smoke 실행의 publish 실패 자료를 만들고 실제 복구 결과를 검증한다.

운영 이미지에는 포함하지 않는다. Compose의 일회성 컨테이너에 읽기 전용으로 마운트한다.
"""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from uuid import UUID


def source_hashes(folder):
    return {str(path.relative_to(folder)): sha256(path.read_bytes()).hexdigest()
            for path in sorted(folder.rglob("*"))
            if path.is_file() and path.name != "smoke-source.json"}


def prepare(source_id, root):
    assert not os.environ.get("OPENAI_API_KEY")
    assert os.environ.get("LLMOPS_LIVE_ENABLED", "false") == "false"
    sys.path.insert(0, "/app/evaluation/support-program-evidence")
    import ops_flow
    import llmops

    def forbid_model(*args, **kwargs):
        raise AssertionError("Model calls are forbidden in recovery smoke")

    def fail_publish(*args, **kwargs):
        raise RuntimeError("SMOKE_PUBLISH_FAILURE")

    ops_flow.evaluate.execute = forbid_model
    llmops.publish = fail_publish
    try:
        ops_flow.evaluate_saved_capture(source_id, ops_flow.DATASET_ID)
    except RuntimeError as error:
        if str(error) != "SMOKE_PUBLISH_FAILURE":
            raise
    else:
        raise AssertionError("Injected publication failure did not fail the flow")
    folder = root / source_id
    manifest = json.loads((folder / "evaluation/manifest.json").read_text())
    assert manifest["status"] == "failed" and manifest["stage"] == "publish"
    assert manifest["model_api_calls"] == 0
    (folder / "smoke-source.json").write_text(json.dumps(source_hashes(folder)))
    print(json.dumps({"source_run_id": source_id, "status": "FAILED", "model_api_calls": 0}))


def register(source_id, root, email):
    sys.path.insert(0, "/app")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django
    django.setup()
    from django.contrib.auth import get_user_model
    from apps.evaluations.catalog import LEGACY_DATASET_ID
    from apps.evaluations.models import EvaluationRun

    marker = json.loads((root / source_id / "request.json").read_text())
    assert marker["request_id"] == source_id and marker["dataset_id"] == LEGACY_DATASET_ID
    assert marker["execution_mode"] == "replay"
    owner = get_user_model().objects.get(email=email, is_staff=True)
    # 아직 동기화하지 않은 대기 상태로 등록해 백그라운드 확인을 강제한다.
    EvaluationRun.objects.create(id=source_id, requested_by=owner, dataset_id=LEGACY_DATASET_ID,
                                 prefect_flow_run_id=marker["prefect_flow_run_id"], status="QUEUED")
    print(json.dumps({"source_run_id": source_id, "registered": True}))


def verify(source_id, recovery_id, root):
    sys.path[:0] = ["/app/evaluation/support-program-evidence", "/app/backend/ai-service"]
    import llmops
    import httpx
    from app.config import LangfuseSettings
    from langfuse.api.client import LangfuseAPI

    source = root / source_id
    assert source_hashes(source) == json.loads((source / "smoke-source.json").read_text())
    folder = root / recovery_id
    marker = json.loads((folder / "request.json").read_text())
    assert marker["request_id"] == recovery_id
    assert marker["recovery_config"]["source_run_id"] == source_id
    manifest = json.loads((folder / "evaluation/manifest.json").read_text())
    assert marker["execution_mode"] == "recovery" and marker["live_config"] == {}
    assert manifest["status"] == "completed" and manifest["model_api_calls"] == 0
    result = llmops.load_results(folder / "recovery-fixture.json", folder / "capture/capture.json")
    settings = LangfuseSettings.from_environment()
    expected = {item["id"]: item for item in llmops.score_payloads(result, settings)}
    assert len(expected) == 22 and set(manifest["score_ids"]) == set(expected)
    assert sha256((folder / "evaluation/report.html").read_bytes()).hexdigest() == manifest["artifact_sha256"]["report.html"]
    with httpx.Client(timeout=10) as transport:
        client = LangfuseAPI(username=settings.public_key, password=settings.secret_key,
                             base_url=settings.base_url, httpx_client=transport, timeout=10)
        scores = client.scores_v3.get_many_v3(id=",".join(expected), limit=100, fields="details,subject")
        actual = {score.id: score for score in scores.data}
        assert all(key in actual and actual[key].value == item["value"]
                   and actual[key].name == item["name"] for key, item in expected.items())
        source_marker = json.loads((source / "request.json").read_text())
        for request, state in [(source_marker, "FAILED"), (marker, "COMPLETED")]:
            response = transport.get(os.environ["PREFECT_API_URL"] + "/flow_runs/" + request["prefect_flow_run_id"])
            response.raise_for_status()
            assert response.json()["state_type"] == state
    print(json.dumps({"source_run_id": source_id, "recovery_run_id": marker["request_id"],
                      "source_unchanged": True, "model_api_calls": 0, "verified_score_count": len(actual)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "register", "verify"])
    parser.add_argument("--source-id", type=UUID, required=True)
    parser.add_argument("--operator-email")
    parser.add_argument("--recovery-id", type=UUID)
    args = parser.parse_args()
    root = Path(os.environ["LLMOPS_RESULTS_DIR"]).resolve()
    source_id = str(args.source_id)
    if args.action == "register":
        if not args.operator_email:
            parser.error("register requires --operator-email for the existing smoke operator")
        register(source_id, root, args.operator_email)
    elif args.action == "prepare":
        prepare(source_id, root)
    else:
        if not args.recovery_id:
            parser.error("verify requires the recovery ID returned by the HTTP smoke")
        verify(source_id, str(args.recovery_id), root)


if __name__ == "__main__":
    main()
