"""실제 MySQL·Ops·Prefect·평가 프로세스의 취소/예산을 무료 HTTP 모델 대역으로 검증한다."""

import argparse
import json
import os
import secrets
import subprocess
import tempfile
import time
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import uuid4

from cancellation_probe import TOKEN, NoRedirect

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "CRASHED", "RESULT_ERROR"}
SCENARIOS = (
    "queued",
    "before_authorize",
    "after_settle",
    "ack_while_alive",
    "model_response_lost",
    "completion_wins",
    "response_loss_restart",
    "authorize_response_lost",
    "settle_error",
    "close_error",
    "duplicate_worker",
)


def wait_for(read, accept, *, label, timeout=180):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if accept(value):
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(label)
        time.sleep(0.2)  # 상태 관찰 간격. 경합 순서는 명시적인 barrier로 제어한다.


def request(url, data=None, *, client=None, headers=None):
    raw = json.dumps(data).encode() if data is not None else None
    try:
        response = (client or build_opener(NoRedirect())).open(
            Request(
                url,
                data=raw,
                headers={"Content-Type": "application/json", **(headers or {})},
            ),
            timeout=20,
        )
    except HTTPError as error:
        response = error
    with response:
        body = response.read()
        return response.status, json.loads(body) if body else None


def verify_budget(before, after, *, calls, output, closed, sent, events):
    delta = [b - a for a, b in zip(before["allocated"], after["allocated"], strict=True)]
    assert delta == [calls, output], f"Unexpected retained budget: {delta}"
    assert after["closed"] is closed
    assert len({c["sequence"] for c in after["calls"]}) == len(after["calls"])
    assert sum(e["stage"] == "model_sent" for e in events) == sent
    assert not any(e["stage"] == "barrier_timeout" for e in events)

    def accepted(stage):
        return sum(e["stage"] == stage and e.get("status") == 200 for e in events)

    assert accepted("authorize") == len(after["calls"])
    assert accepted("settle") == sum(c["output_tokens"] is not None for c in after["calls"])
    return {
        "retained_delta": delta,
        "model_sends": sent,
        "authorizations": accepted("authorize"),
        "settlements": accepted("settle"),
    }


class Smoke:
    def __init__(self, compose):
        self.compose = compose
        self.cookies = CookieJar()
        self.client = build_opener(NoRedirect(), HTTPCookieProcessor(self.cookies))
        self.csrf = None
        self.records = []
        self.active = None

    def dc(self, *args):
        result = self.compose(*args, capture=True)
        return result.stdout.strip()

    def url(self, service, port):
        address = self.dc("port", service, str(port)).splitlines()[0]
        assert address.startswith("127.0.0.1:"), "Test ports must bind loopback only"
        return "http://" + address

    def ready(self):
        self.probe = self.url("cancellation-probe", 8099)
        self.ops = self.url("ops-service", 8000)
        self.prefect = self.url("prefect", 4200) + "/api"

        def langfuse():
            try:
                return request(self.probe + "/langfuse-health")
            except (URLError, OSError, ValueError):
                return 0, {}

        wait_for(langfuse, lambda r: r[0] == 200, label="Langfuse readiness", timeout=300)

        def session():
            try:
                return self.api("/api/v1/ops/session")
            except (URLError, OSError):
                return 0, {}

        _, body = wait_for(session, lambda r: r[0] == 200, label="Ops readiness")
        assert body["live_enabled"] and body["user"]
        self.csrf = body["csrf_token"]
        self.dataset = next(d for d in body["datasets"] if d["id"] == "target-coverage-20260907-v1")

        def deployment():
            try:
                return request(
                    self.prefect + "/deployments/name/govbiz-ops-evidence-evaluation/saved-capture"
                )
            except (URLError, OSError):
                return 0, {}

        wait_for(
            deployment,
            lambda r: r[0] == 200,
            label="Real serve deployment registration",
        )

    def api(self, path, data=None):
        cookies = ["govbiz_session=offline-admin-session"]
        cookies.extend(f"{cookie.name}={cookie.value}" for cookie in self.cookies)
        headers = {"Cookie": "; ".join(cookies), "Origin": self.ops}
        if self.csrf:
            headers["X-CSRFToken"] = self.csrf
        return request(self.ops + path, data, client=self.client, headers=headers)

    def control(self, action, data=None):
        status, body = request(f"{self.probe}/control/{self.active['request_id']}/{action}", data)
        assert status == 200, f"Probe {action}: HTTP {status}"
        return body

    def db(self, run_id=None):
        args = (run_id,) if run_id else ()
        return json.loads(
            self.dc(
                "exec",
                "-T",
                "ops-service",
                "python",
                "/test/cancellation_probe.py",
                "snapshot",
                *args,
            )
        )

    def runner(self, *args):
        return self.dc(
            "exec",
            "-T",
            "evaluation-runner",
            ".venv/bin/python",
            "/test/cancellation_runner.py",
            *args,
        )

    def process(self):
        return json.loads(self.runner("alive", self.active["request_id"]))

    def pause(self):
        self.runner("signal-parent", "STOP")

    def resume(self):
        self.runner("signal-parent", "CONT")

    def start(self, name, **config):
        self.active = {
            "scenario": name,
            "request_id": str(uuid4()),
            "before": self.db(),
            "states": [],
        }
        self.control("configure", config)
        payload = {
            "request_id": self.active["request_id"],
            "dataset_id": self.dataset["id"],
            "candidate_capture_id": "new-model-response",
            "reference_capture_id": self.dataset["captures"][0]["id"],
            "execution_mode": "live",
            "confirm_paid_run": True,
            "live_config": self.dataset["live_config"],
            "execution_profile": self.dataset["execution_profiles"]["live"],
        }
        self.active["payload"] = payload
        status, run = self.api("/api/v1/ops/evaluations", payload)
        expected = 503 if config.get("fault") == "create_lost" else 202
        assert status == expected, f"{name} dispatch: HTTP {status}"
        self.observe(run)
        return run

    def observe(self, run):
        self.active["states"].append({"status": run["status"], "error_code": run["error_code"]})
        if run["prefect_flow_run_id"]:
            self.active["flow_id"] = run["prefect_flow_run_id"]
        return run

    def read(self):
        status, run = self.api(f"/api/v1/ops/evaluations/{self.active['request_id']}")
        assert status == 200
        return self.observe(run)

    def cancel(self):
        status, run = self.api(f"/api/v1/ops/evaluations/{self.active['request_id']}/cancel", {})
        assert status in (200, 202), f"Cancel: HTTP {status}"
        return self.observe(run)

    def stage(self, stage):
        wait_for(
            lambda: self.control("state"),
            lambda state: any(e["stage"] == stage for e in state["events"]),
            label=f"{self.active['scenario']}: {stage}",
        )

    def terminal(self, expected):
        run = wait_for(
            self.read,
            lambda r: r["status"] in TERMINAL,
            label=f"{self.active['scenario']}: terminal state",
            timeout=360,
        )
        assert run["status"] == expected, (
            f"{self.active['scenario']}: {run['status']} / {run['error_code']}"
        )
        return run

    def finish(self, *, calls, output, sent, closed=True):
        stopped = wait_for(self.process, lambda p: not p["alive"], label="Child process exit")
        before = self.active["before"]
        after = self.db(self.active["request_id"])
        events = self.control("state")["events"]
        counters = verify_budget(
            before,
            after,
            calls=calls,
            output=output,
            closed=closed,
            sent=sent,
            events=events,
        )
        # 반복 조회/취소 확인으로도 중복 환급이 없어야 한다.
        self.read()
        assert self.db(self.active["request_id"])["allocated"] == after["allocated"]
        status, flows = request(
            self.prefect + "/flow_runs/filter",
            {"flow_runs": {"idempotency_key": {"any_": ["ops-" + self.active["request_id"]]}}},
        )
        assert status == 200 and len(flows) == 1
        assert flows[0]["id"] == self.active["flow_id"]
        self.records.append(
            {key: value for key, value in self.active.items() if key != "payload"}
            | {
                "after": after,
                "events": events,
                "process": stopped,
                "counts": counters,
                "prefect_state": flows[0]["state_type"],
                "passed": True,
            }
        )
        self.active = None

    def run(self):
        self.pause()
        try:
            self.start("queued")
            self.cancel()
            self.terminal("CANCELLED")
            assert not self.process()["started"]
            self.finish(calls=0, output=0, sent=0)
        finally:
            self.resume()

        for name, stage, calls, output in (
            ("before_authorize", "before_authorize_0", 0, 0),
            ("after_settle", "after_settle_0", 1, 50),
            ("ack_while_alive", "model_sent", 1, 2000),
        ):
            self.start(name, hold=stage)
            self.stage(stage)
            self.pause()
            try:
                process = self.process()
                assert process["started"] and process["alive"]
                self.active["process_before_cancel"] = process
                run = self.cancel()
                assert run["status"] == "CANCELLING" and not run["error_code"]
                assert self.process()["alive"], (
                    "ACK must be observed while the child is still alive"
                )
                assert not self.db(self.active["request_id"])["closed"]
            finally:
                self.resume()
            self.terminal("CANCELLED")
            self.control("release", {})
            self.finish(calls=calls, output=output, sent=calls)

        self.start("model_response_lost", fault="model_lost")
        self.terminal("FAILED")
        self.finish(calls=1, output=2000, sent=1)

        self.start("completion_wins")
        # 상세 조회를 하지 않아 Ops는 아직 QUEUED다. 실제 Prefect 완료를 먼저 확인한다.
        wait_for(
            lambda: request(self.prefect + "/flow_runs/" + self.active["flow_id"])[1],
            lambda flow: flow["state_type"] in TERMINAL,
            label="Completion winner",
            timeout=360,
        )
        run = self.cancel()
        assert run["status"] == "COMPLETED"
        self.terminal("COMPLETED")
        self.finish(calls=6, output=300, sent=6)

        self.pause()
        try:
            self.start("response_loss_restart", fault="create_lost")
            self.compose("restart", "ops-service")
            self.ready()
            run = self.read()
            assert run["prefect_flow_run_id"] and run["status"] == "QUEUED"
            self.control("fault", {"fault": "cancel_lost"})
            run = self.cancel()
            assert (
                run["status"] == "CANCELLING" and run["error_code"] == "PREFECT_CANCEL_UNCONFIRMED"
            )
            self.compose("restart", "ops-service")
            self.ready()
            self.terminal("CANCELLED")
            status, replay = self.api("/api/v1/ops/evaluations", self.active["payload"])
            assert status == 200 and replay["prefect_flow_run_id"] == self.active["flow_id"]
            self.finish(calls=0, output=0, sent=0)
        finally:
            self.resume()

        for name, fault, calls, output, sent, closed in (
            ("authorize_response_lost", "authorize_lost", 1, 2000, 0, True),
            ("settle_error", "settle_error", 1, 2000, 1, True),
            ("close_error", "close_error", 6, 12000, 6, False),
        ):
            self.start(name, fault=fault)
            self.terminal("FAILED")
            self.finish(calls=calls, output=output, sent=sent, closed=closed)

        self.start("duplicate_worker", hold="model_sent")
        self.stage("model_sent")
        record = self.db(self.active["request_id"])
        rejected = json.loads(
            self.runner(
                "duplicate",
                self.active["request_id"],
                record["flow_id"],
                record["spec_hash"],
            )
        )
        assert rejected == {"duplicate_claim_rejected": True}
        # 같은 owner/sequence의 승인 응답도 재발급하지 않는다.
        status, _ = request(
            self.ops + f"/internal/llmops/evaluations/{self.active['request_id']}/budget/authorize",
            {
                "worker_id": record["worker_id"],
                "flow_id": record["flow_id"],
                "spec_hash": record["spec_hash"],
                "sequence": 0,
                "model": self.dataset["live_config"]["model"],
                "max_output_tokens": 2000,
            },
            headers={"Authorization": "Bearer " + TOKEN},
        )
        assert status == 409
        self.active["duplicate_claim_rejected"] = True
        self.active["duplicate_authorize_status"] = status
        self.control("release", {})
        self.terminal("COMPLETED")
        self.finish(calls=6, output=300, sent=6)
        assert [r["scenario"] for r in self.records] == list(SCENARIOS)


def isolated_environment():
    names = (
        "POSTGRES_PASSWORD",
        "CLICKHOUSE_PASSWORD",
        "REDIS_PASSWORD",
        "MINIO_PASSWORD",
        "LANGFUSE_SALT",
        "LANGFUSE_ENCRYPTION_KEY",
        "LANGFUSE_NEXTAUTH_SECRET",
        "LANGFUSE_ADMIN_PASSWORD",
        "OPS_DB_PASSWORD",
        "OPS_DB_ROOT_PASSWORD",
        "OPS_DJANGO_SECRET_KEY",
        "OPS_ADMIN_PASSWORD",
    )
    values = {name: secrets.token_hex(32) for name in names}
    values.update(
        LANGFUSE_PUBLIC_KEY="pk-lf-" + secrets.token_hex(16),
        LANGFUSE_SECRET_KEY="sk-lf-" + secrets.token_hex(32),
        LLMOPS_LIVE_ENABLED="true",
        LLMOPS_LIVE_MODEL="gpt-6-luna",
        LLMOPS_BUDGET_TOKEN=TOKEN,
        OPENAI_API_KEY="offline-model-double-key",
    )
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "work/llmops-ci/cancellation.json")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    project = "govbiz-cancel-test-" + uuid4().hex[:12]
    values = isolated_environment()
    # Ambient credentials must not override the disposable env-file through Compose interpolation.
    environment = {k: v for k, v in os.environ.items() if k not in values}
    environment.update(values)
    smoke = None
    failure = None
    with tempfile.TemporaryDirectory(prefix="cancellation-", dir=args.output.parent) as temporary:
        env_file = Path(temporary) / "isolated.env"
        env_file.write_text("".join(f"{k}={v}\n" for k, v in values.items()), encoding="utf-8")
        command = [
            "docker",
            "compose",
            "--project-name",
            project,
            "--env-file",
            str(env_file.resolve()),
        ]
        for name in ("compose.yaml", "compose.ops.yaml", "compose.cancel-test.yaml"):
            command.extend(["-f", str(HERE / name)])
        command.extend(["--profile", "evaluation"])

        def compose(*parts, capture=False):
            return subprocess.run(
                command + list(parts),
                cwd=ROOT,
                env=environment,
                check=True,
                text=True,
                encoding="utf-8",
                capture_output=capture,
                timeout=900 if parts[0] == "up" else 120,
            )

        try:
            compose("config", "--quiet")
            # No ops-sync: race tests explicitly control the timing of the real detail/cancel API.
            compose(
                "up",
                "-d",
                "--build",
                "langfuse-web",
                "langfuse-worker",
                "prefect",
                "ops-service",
                "cancellation-probe",
                "evaluation-runner",
            )
            compose(
                "exec",
                "-T",
                "ops-service",
                "python",
                "manage.py",
                "migrate",
                "--noinput",
            )
            compose(
                "exec",
                "-T",
                "ops-service",
                "python",
                "manage.py",
                "set_evaluation_budget",
                "--calls",
                "200",
                "--output-tokens",
                "400000",
            )
            smoke = Smoke(compose)
            smoke.ready()
            smoke.run()
        except Exception as error:
            failure = type(error).__name__  # HTTP bodies and credentials must not enter artifacts.
            raise
        finally:
            report = {
                "schema": "llmops-cancellation-smoke-v1",
                "project": project,
                "passed": failure is None
                and smoke is not None
                and len(smoke.records) == len(SCENARIOS),
                "failure": failure,
                "scenarios": smoke.records if smoke else [],
            }
            if smoke and smoke.active:
                unfinished = {k: v for k, v in smoke.active.items() if k != "payload"}
                for name, read in (
                    ("probe", lambda: smoke.control("state")),
                    ("after", lambda: smoke.db(smoke.active["request_id"])),
                    ("process", smoke.process),
                ):
                    try:
                        unfinished[name] = read()
                    except Exception as error:
                        unfinished[name] = {"unavailable": type(error).__name__}
                report["unfinished"] = unfinished
            args.output.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            # Remove only this invocation's random project, including its disposable volumes.
            try:
                compose("down", "--volumes", "--remove-orphans", "--timeout", "5")
            except Exception as error:
                report["passed"] = False
                report["cleanup_failure"] = type(error).__name__
                args.output.write_text(
                    json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                if failure is None:
                    raise
    print(f"Passed {len(SCENARIOS)} cancellation/budget scenarios. Evidence: {args.output}")


if __name__ == "__main__":
    main()
