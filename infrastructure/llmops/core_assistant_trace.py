"""Verify real Core → AI assistant tracing with offline model responses only."""

import json
import re
import time
import urllib.error
import urllib.request
import uuid

from core_search_trace import LOCAL_HTTP, read_observations, require, tracing_env

TRACE_PATTERN = re.compile(r"assistant_request trace_id=([0-9a-f]{32})")


def span_tree(scenario):
    require(scenario in {"ok", "fail", "timeout"}, "Unknown assistant scenario")
    tree = {
        "assistant.total": None,
        "assistant.core.request": "assistant.total",
        "assistant.agent": "assistant.core.request",
        "assistant.classify": "assistant.agent",
    }
    if scenario == "ok":
        tree["assistant.finalize"] = "assistant.agent"
        tree["assistant.core.validate"] = "assistant.total"
    return tree


def verify_observations(observations, trace_id, scenario, private_values):
    tree = span_tree(scenario)
    require(len(observations) == len(tree), "Missing or unexpected assistant observations")
    require(len({item["id"] for item in observations}) == len(tree), "Duplicate assistant observations")
    matched = {}
    outcome = {"ok": "completed", "fail": "failed", "timeout": "timeout"}[scenario]
    for name, parent in tree.items():
        found = [item for item in observations if item["name"] == name]
        require(len(found) == 1, "Missing/ambiguous assistant observation: " + name)
        item = matched[name] = found[0]
        require(item["traceId"] == trace_id, "Disconnected assistant trace")
        require(
            item.get("parentObservationId") == (matched[parent]["id"] if parent else None), "Wrong assistant parent"
        )
        require(item.get("endTime"), "Unfinished assistant observation")
        require(item["metadata"].get("outcome") == outcome, "Wrong assistant outcome")
        require((item["level"] == "ERROR") == (scenario != "ok"), "Wrong assistant error level")
        require(
            item.get("input") in (None, "", "null") and item.get("output") in (None, "", "null"),
            "Assistant body captured",
        )
    usage = matched["assistant.agent"]["metadata"]
    require(usage.get("model_calls") == 1, "Assistant model was retried or skipped")
    # The HTTP fixture deliberately omits usage; success must not turn unknown into zero either.
    require(
        usage.get("usage_unknown_calls") == 1 and usage.get("usage_complete") is False, "Unknown assistant usage lost"
    )
    require(
        usage.get("usage_input_tokens") is None and usage.get("usage_output_tokens") is None,
        "Unknown usage became a number",
    )
    serialized = json.dumps(observations, ensure_ascii=False)
    require(all(value not in serialized for value in private_values if value), "Private assistant trace data captured")
    return [
        {"id": item["id"], "parent_id": item.get("parentObservationId"), "name": item["name"], "outcome": outcome}
        for item in matched.values()
    ]


def post_question(core_url, message):
    payload = {
        "message": message,
        "history": [],
        "context": {"route": "/app/chat", "programSelected": True},
        "helpEntries": [
            {
                "id": "trace-help",
                "title": "안내",
                "question": "안내가 필요해요",
                "summary": "화면 사용 안내",
                "body": ["도움말"],
                "limitation": None,
                "audience": "public",
                "status": "available",
                "action": None,
            }
        ],
    }
    request = urllib.request.Request(
        core_url + "/api/v1/assistant/messages",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "traceparent": "00-" + "a" * 32 + "-" + "b" * 16 + "-01"},
    )
    try:
        response = LOCAL_HTTP.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.code, json.load(response)


def verify_assistant_traces(*, core_url, stub_url, environment, core_logs, call_json, output):
    tracing_env(environment)
    require(not output.exists(), "Use a new assistant trace evidence output path")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"status": "running", "model_api_calls": 0, "scenarios": []}

    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    save()
    # Core masks digit runs that resemble personal identifiers before the AI call.
    # Keep this synthetic marker hex-compatible but alphabetic so it survives masking.
    nonce = "".join("abcdef"[int(char, 16) % 6] for char in uuid.uuid4().hex)
    try:
        for scenario, expected_status in (("ok", 200), ("fail", 503), ("timeout", 504)):
            record = {"scenario": scenario, "status": "running"}
            report["scenarios"].append(record)
            save()
            message = f"이 공고 PRIVATE-ASSISTANT-TRACE-{nonce}-{scenario}"
            before = set(TRACE_PATTERN.findall(core_logs()))
            code, response = post_question(core_url, message)
            record["http_status"] = code
            require(code == expected_status, "Unexpected Core assistant HTTP status: " + scenario)
            if scenario == "ok":
                require(response.get("intent") == "PROGRAM_QUESTION", "Wrong assistant fixture intent")
            else:
                require(
                    response.get("code")
                    == ("AI_SERVICE_TIMEOUT" if scenario == "timeout" else "AI_SERVICE_UNAVAILABLE"),
                    "Core lost the assistant failure code",
                )
            deadline = time.monotonic() + 10
            while True:
                new = set(TRACE_PATTERN.findall(core_logs())) - before
                if new or time.monotonic() >= deadline:
                    break
                time.sleep(0.2)
            require(len(new) == 1, "Expected one Core assistant trace")
            trace_id = record["trace_id"] = new.pop()
            require(trace_id != "a" * 32, "Public traceparent controlled the Core root")
            deadline = time.monotonic() + 90
            while True:
                observations = read_observations(environment, trace_id)
                if len(observations) >= len(span_tree(scenario)) and all(item.get("endTime") for item in observations):
                    break
                require(time.monotonic() < deadline, "Assistant Langfuse readback timed out")
                time.sleep(1)
            record["observations"] = verify_observations(
                observations,
                trace_id,
                scenario,
                [
                    message,
                    "PRIVATE-ASSISTANT-",
                    "catalog-verification-key-never-sent",
                    environment["LANGFUSE_SECRET_KEY"],
                ],
            )
            status, counts = call_json(stub_url + "/trace-counts")
            require(status == 200 and counts.get(message) == {"assistant": 1}, "Unexpected assistant fixture calls")
            record.update(fixture_calls=counts[message], status="passed")
            save()
            print("PASS: actual Core assistant trace " + scenario, flush=True)
        require(len({item["trace_id"] for item in report["scenarios"]}) == 3, "Assistant requests reused trace IDs")
        report["status"] = "passed"
    except BaseException:
        report["status"] = "failed"
        if report["scenarios"]:
            report["scenarios"][-1]["status"] = "failed"
        raise
    finally:
        save()
