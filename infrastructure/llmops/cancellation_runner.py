"""실제 Prefect serve/평가 함수를 감싸는 테스트 진입점. 원본 소스·명세는 바꾸지 않는다."""

import asyncio
import json
import os
import signal
import sys
from hashlib import sha256
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import UUID

PROBE = "http://cancellation-probe:8099"
RESULTS = Path("/results")
PARENT = RESULTS / ".cancellation-parent.json"
sys.path.insert(0, "/app/evaluation/support-program-evidence")


def process_info(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "birth": fields[19], "alive": fields[0] != "Z"}
    except (FileNotFoundError, ProcessLookupError):
        # /proc 파일을 연 뒤 프로세스가 종료되면 read()가 ESRCH를 반환할 수도 있다.
        # 권한·I/O 오류는 종료 증거가 아니므로 그대로 실패시킨다.
        return {"pid": pid, "birth": None, "alive": False}


def marker_path(run_id):
    return RESULTS / f".cancellation-{UUID(run_id)}.json"


def alive(marker):
    if not marker.exists():
        return {"started": False, "alive": False}
    saved = json.loads(marker.read_text())
    current = process_info(saved["pid"])
    return {
        "started": True,
        "pid": saved["pid"],
        "alive": current["alive"] and current["birth"] == saved["birth"],
    }


def barrier(run_id, stage):
    with urlopen(
        Request(
            f"{PROBE}/barrier/{run_id}/{stage}",
            data=b"{}",
            headers={"Content-Type": "application/json"},
        ),
        timeout=185,
    ) as response:
        if response.status != 200 or json.load(response) != {"accepted": True}:
            raise RuntimeError("Test barrier failed")


def install_http_double(run_id):
    import httpx2
    from budget_client import BudgetClient

    class OfflineTransport(httpx2.AsyncBaseTransport):
        def __init__(self):
            self.local = httpx2.AsyncHTTPTransport(retries=0)

        async def handle_async_request(self, request):
            if str(request.url) == "https://api.openai.com/v1/responses/input_tokens":
                return httpx2.Response(
                    200, json={"object": "response.input_tokens", "input_tokens": 100}
                )
            endpoint = {
                "https://api.openai.com/v1/responses": "model",
                "https://api.openai.com/v1/embeddings": "embedding",
            }.get(str(request.url))
            if request.method != "POST" or endpoint is None:
                raise RuntimeError("Test transport refused a non-allowlisted model URL")
            # 원본 request hook의 명세 검증·실제 예산 승인이 끝난 뒤 HTTP 대역으로 전송한다.
            forwarded = httpx2.Request(
                "POST",
                f"{PROBE}/{endpoint}/{run_id}",
                content=request.content,
                headers={"Content-Type": "application/json"},
                extensions=request.extensions,
            )
            return await self.local.handle_async_request(forwarded)

        async def aclose(self):
            await self.local.aclose()

    original_client = httpx2.AsyncClient

    class OfflineAsyncClient(original_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = OfflineTransport()
            kwargs["trust_env"] = False
            super().__init__(*args, **kwargs)

    httpx2.AsyncClient = OfflineAsyncClient
    original_authorize = BudgetClient.authorize
    original_settle = BudgetClient.settle

    async def authorize(
        self,
        sequence,
        model,
        max_output_tokens,
        *,
        operation_id,
        input_token_count,
        input_sha256=None,
        dimensions=None,
    ):
        await asyncio.to_thread(barrier, run_id, f"before_authorize_{sequence}")
        await original_authorize(
            self,
            sequence,
            model,
            max_output_tokens,
            operation_id=operation_id,
            input_token_count=input_token_count,
            input_sha256=input_sha256,
            dimensions=dimensions,
        )

    async def settle(self, sequence, usage, *, operation_id):
        await original_settle(self, sequence, usage, operation_id=operation_id)
        await asyncio.to_thread(barrier, run_id, f"after_settle_{sequence}")

    BudgetClient.authorize = authorize
    BudgetClient.settle = settle


def install_publish_gate(run_id):
    import rag_replay_flow

    original = rag_replay_flow.publish_payloads

    def publish(payloads, settings):
        # 실제 보고서·manifest 작성이 끝난 점수 등록 경계에서만 장애를 주입한다.
        barrier(run_id, "before_rag_publish")
        return original(payloads, settings)

    rag_replay_flow.publish_payloads = publish


def artifact_fingerprints(run_id):
    folder = RESULTS / str(UUID(run_id))
    paths = [
        "request.json",
        "capture/capture.json",
        "recovery-fixture.json",
        "reference-capture.json",
        "evaluation/manifest.json",
        "evaluation/comparison.json",
        "evaluation/report.html",
    ]
    paths += [
        path.relative_to(folder).as_posix() for path in (folder / "capture").glob("usage-*.json")
    ]
    return {
        name: sha256((folder / name).read_bytes()).hexdigest()
        for name in sorted(paths)
        if (folder / name).is_file()
    }


def process_command():
    if sys.argv[1] == "alive":
        print(json.dumps(alive(marker_path(sys.argv[2]))))
    elif sys.argv[1] == "artifacts":
        print(json.dumps(artifact_fingerprints(sys.argv[2])))
    elif sys.argv[1] == "signal-parent":
        if not alive(PARENT)["alive"]:
            raise RuntimeError("Runner parent identity changed")
        pid = json.loads(PARENT.read_text())["pid"]
        os.kill(pid, {"STOP": signal.SIGSTOP, "CONT": signal.SIGCONT}[sys.argv[2]])
    elif sys.argv[1] == "duplicate":
        from budget_client import BudgetClient, BudgetUnavailable

        run_id, flow_id, spec_hash = sys.argv[2:]
        client = BudgetClient(run_id, flow_id, spec_hash)
        try:
            client.claim()
        except BudgetUnavailable:
            print(json.dumps({"duplicate_claim_rejected": True}))
        else:
            raise RuntimeError("Second process acquired the same reservation")
    else:
        raise ValueError("Unknown fixture command")


if __name__ == "__main__" and len(sys.argv) > 1:
    process_command()
    raise SystemExit(0)

from prefect import flow  # noqa: E402 - PID controls must work without SDK startup.


@flow(name="govbiz-ops-evidence-evaluation", retries=0, persist_result=False)
def cancellation_evaluation(
    request_id: str,
    dataset_id: str,
    candidate_capture_id: str = "target-coverage-20260907-v1",
    reference_capture_id: str = "target-coverage-20260907-v1",
    execution_mode: str = "replay",
    live_config: dict | None = None,
    reference_config: dict | None = None,
    recovery_config: dict | None = None,
    execution_spec: dict | None = None,
    execution_spec_sha256: str | None = None,
):
    from ops_flow import evaluate_saved_capture

    marker_path(request_id).write_text(json.dumps(process_info(os.getpid())))
    install_http_double(request_id)
    install_publish_gate(request_id)
    return evaluate_saved_capture.fn(
        request_id,
        dataset_id,
        candidate_capture_id,
        reference_capture_id,
        execution_mode,
        live_config,
        reference_config,
        recovery_config,
        execution_spec,
        execution_spec_sha256,
    )


if __name__ == "__main__":
    PARENT.write_text(json.dumps(process_info(os.getpid())))
    cancellation_evaluation.serve(name="saved-capture", limit=1)
