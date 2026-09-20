import importlib.util
import json
from pathlib import Path

import httpx2
import pytest


SUPPORTED_ID = "PBLN_000000000125611"


@pytest.fixture
def probe(tmp_path, monkeypatch):
    path = Path(__file__).with_name("run-search.py")
    spec = importlib.util.spec_from_file_location("search_latency_probe", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    return module


def response_body(programs=None):
    return {"programs": programs if programs is not None else [
        {"sourceCode": "BIZINFO", "id": SUPPORTED_ID, "recommendationScore": 80},
    ]}


def install_transport(monkeypatch, probe, respond):
    requests, configurations = [], []
    real_client = httpx2.Client

    def transport(request):
        requests.append(request)
        # 실행 횟수는 POST 전 디스크에 예약되어야 하며 실패해도 같은 예약을 다시 쓰지 않는다.
        capture = json.loads((probe.ROOT / "search" / "capture.json").read_text())
        assert len(capture["observations"]) == len(requests)
        assert capture["observations"][-1] == {"repetition": len(requests), "status": "started"}
        assert len(requests) <= 2, "The explicit two-probe budget must not be retried"
        return respond(request, len(requests))

    def client(**kwargs):
        configurations.append(kwargs)
        return real_client(transport=httpx2.MockTransport(transport), **kwargs)

    monkeypatch.setattr(httpx2, "Client", client)
    return requests, configurations


def load_capture(probe):
    return json.loads((probe.ROOT / "search" / "capture.json").read_text())


def test_default_plan_never_constructs_client_or_reserves_execution(probe, monkeypatch, capsys):
    def forbidden_client(**kwargs):
        raise AssertionError("A plan must not construct an HTTP client")
    monkeypatch.setattr(httpx2, "Client", forbidden_client)

    assert probe.run() == 0

    assert json.loads(capsys.readouterr().out) == {
        "execute": False, "maximumSearchRequests": 2, "maximumEmbeddingCalls": 2, "maximumRankingCalls": 2,
    }
    assert not (probe.ROOT / "search").exists()


def test_explicit_execution_sends_exactly_two_identical_search_bodies_and_preserves_budget(probe, monkeypatch, capsys):
    requests, configurations = install_transport(
        monkeypatch, probe, lambda request, attempt: httpx2.Response(200, json=response_body()),
    )

    assert probe.run(execute=True) == 0

    assert configurations == [{"trust_env": False, "follow_redirects": False, "timeout": 90}]
    assert len(requests) == 2
    assert all(request.method == "POST" for request in requests)
    assert all(str(request.url) == "http://127.0.0.1:8080/api/v1/support-programs/search" for request in requests)
    bodies = [json.loads(request.content) for request in requests]
    assert bodies == [probe.BODY, probe.BODY]
    assert requests[0].content == requests[1].content
    capture = load_capture(probe)
    assert capture["maximumOpenAiCalls"] == 4
    assert capture["maximumSearchRequests"] == 2
    assert capture["retries"] == 0
    assert capture["request"] == probe.BODY
    assert capture["startedAt"] and capture["finishedAt"]
    assert capture["identicalResponses"] is True
    assert [item["repetition"] for item in capture["observations"]] == [1, 2]
    assert all(item["status"] == "completed" and item["httpStatus"] == 200 for item in capture["observations"])
    assert all(all(item["targetedChecks"].values()) for item in capture["observations"])
    printed = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert len(printed) == 2
    assert all("response" not in item for item in printed)


@pytest.mark.parametrize("first_run_succeeds", [False, True])
def test_existing_capture_blocks_a_second_execution_without_overwrite_or_network(probe, monkeypatch, first_run_succeeds):
    def respond(request, attempt):
        if first_run_succeeds:
            return httpx2.Response(200, json=response_body())
        raise httpx2.ReadTimeout("private upstream failure", request=request)
    requests, configurations = install_transport(monkeypatch, probe, respond)
    assert probe.run(execute=True) == (0 if first_run_succeeds else 2)
    before = (probe.ROOT / "search" / "capture.json").read_bytes()

    with pytest.raises(FileExistsError):
        probe.run(execute=True)

    assert len(requests) == 2
    assert len(configurations) == 1
    assert (probe.ROOT / "search" / "capture.json").read_bytes() == before


def test_existing_reservation_without_capture_also_blocks_execution(probe, monkeypatch):
    (probe.ROOT / "search").mkdir()
    requests, configurations = install_transport(
        monkeypatch, probe, lambda request, attempt: httpx2.Response(200, json=response_body()),
    )

    with pytest.raises(FileExistsError):
        probe.run(execute=True)

    assert not requests and not configurations
    assert not (probe.ROOT / "search" / "capture.json").exists()


@pytest.mark.parametrize("failure", ["timeout", "json-http-error", "html-http-error", "invalid-json", "redirect"])
def test_failures_consume_only_two_planned_attempts_and_do_not_save_or_print_raw_errors(probe, monkeypatch, capsys, failure):
    def respond(request, attempt):
        if failure == "timeout":
            raise httpx2.ReadTimeout("private upstream failure", request=request)
        if failure == "json-http-error":
            return httpx2.Response(503, json={"detail": "private upstream failure"})
        if failure == "html-http-error":
            return httpx2.Response(503, text="<html>private upstream failure</html>")
        if failure == "redirect":
            return httpx2.Response(307, headers={"Location": "https://private.example/retry"}, text="private redirect")
        return httpx2.Response(200, text="private invalid JSON")
    requests, _ = install_transport(monkeypatch, probe, respond)

    assert probe.run(execute=True) == 2

    assert len(requests) == 2
    capture = load_capture(probe)
    assert capture["identicalResponses"] is False
    assert all(item["status"] == "failed" and "errorType" in item for item in capture["observations"])
    assert all("response" not in item for item in capture["observations"])
    if failure != "timeout":
        expected_status = 503 if failure.endswith("http-error") else 307 if failure == "redirect" else 200
        assert [item["httpStatus"] for item in capture["observations"]] == [expected_status, expected_status]
    assert "private" not in json.dumps(capture)
    assert "private" not in capsys.readouterr().out


def test_failed_first_probe_is_not_retried_or_hidden_by_successful_second_probe(probe, monkeypatch):
    requests, _ = install_transport(monkeypatch, probe, lambda request, attempt: (
        httpx2.Response(503, json={"detail": "private upstream failure"}) if attempt == 1
        else httpx2.Response(200, json=response_body())
    ))

    assert probe.run(execute=True) == 2

    assert len(requests) == 2
    capture = load_capture(probe)
    assert [item["status"] for item in capture["observations"]] == ["failed", "completed"]
    assert capture["identicalResponses"] is False


@pytest.mark.parametrize("change", ["score", "metadata", "candidate-order"])
def test_comparison_uses_complete_response_and_detects_score_metadata_or_order_changes(probe, monkeypatch, change):
    def respond(request, attempt):
        payload = response_body([
            {"sourceCode": "BIZINFO", "id": SUPPORTED_ID, "recommendationScore": 80},
            {"sourceCode": "KSTARTUP", "id": "other-program", "recommendationScore": 70},
        ])
        if attempt == 2:
            if change == "score":
                payload["programs"][0]["recommendationScore"] = 81
            elif change == "metadata":
                payload["programs"][0]["title"] = "changed source metadata"
            else:
                payload["programs"].reverse()
        return httpx2.Response(200, json=payload)
    requests, _ = install_transport(monkeypatch, probe, respond)

    assert probe.run(execute=True) == 2

    assert len(requests) == 2
    capture = load_capture(probe)
    assert all(item["status"] == "completed" for item in capture["observations"])
    assert capture["identicalResponses"] is False


@pytest.mark.parametrize("invalid", ["duplicate", "too-many", "boolean", "float", "negative", "over-100", "missing-id", "missing-score"])
def test_invalid_candidate_contract_fails_and_does_not_retain_invalid_response(probe, monkeypatch, invalid):
    def respond(request, attempt):
        programs = response_body()["programs"]
        if invalid == "duplicate":
            programs *= 2
        elif invalid == "too-many":
            programs.extend({"sourceCode": "BIZINFO", "id": f"program-{index}", "recommendationScore": 50} for index in range(5))
        elif invalid == "missing-id":
            programs[0].pop("id")
        elif invalid == "missing-score":
            programs[0].pop("recommendationScore")
        else:
            programs[0]["recommendationScore"] = {"boolean": True, "float": 80.5, "negative": -1, "over-100": 101}[invalid]
        return httpx2.Response(200, json=response_body(programs))
    requests, _ = install_transport(monkeypatch, probe, respond)

    assert probe.run(execute=True) == 2

    assert len(requests) == 2
    capture = load_capture(probe)
    assert capture["identicalResponses"] is False
    assert all(item["status"] == "failed" and "response" not in item for item in capture["observations"])


@pytest.mark.parametrize("invalid", ["supported-missing", "known-conflict"])
def test_identical_valid_responses_still_fail_targeted_quality_checks(probe, monkeypatch, invalid):
    programs = response_body()["programs"] if invalid == "known-conflict" else []
    if invalid == "known-conflict":
        programs.append({"sourceCode": "BIZINFO", "id": "PBLN_000000000125900", "recommendationScore": 80})
    install_transport(monkeypatch, probe, lambda request, attempt: httpx2.Response(200, json=response_body(programs)))

    assert probe.run(execute=True) == 2

    capture = load_capture(probe)
    assert capture["identicalResponses"] is True
    assert all(item["status"] == "completed" for item in capture["observations"])
    field = "knownSupportedProgramRetained" if invalid == "supported-missing" else "knownUnrelatedOrRegionConflictsAbsent"
    assert all(item["targetedChecks"][field] is False for item in capture["observations"])
