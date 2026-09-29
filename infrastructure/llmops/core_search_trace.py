"""Real Core search → AI → local Langfuse assertions for the disposable Catalog check.

Only synthetic queries and the existing OpenAI HTTP fixture are used. This module
does not provision servers, approve evaluations, or measure model/search quality.
"""

import base64
import json
import re
import time
import urllib.parse
import urllib.request
import uuid

NETWORK = "govbiz-llmops_default"
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TRACE_PATTERN = re.compile(r"support_program_search trace_id=([0-9a-f]{32})")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def tracing_env(environment):
    url = urllib.parse.urlsplit(environment.get("LANGFUSE_BASE_URL", ""))
    require(
        url.scheme == "http"
        and url.hostname in {"localhost", "127.0.0.1"}
        and not url.username
        and not url.password
        and url.path in {"", "/"}
        and not url.query
        and not url.fragment,
        "Core trace verification requires an explicit loopback Langfuse URL",
    )
    values = {
        key: environment.get(key, "")
        for key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")
    }
    for value in values.values():
        require(
            re.fullmatch(r"[A-Za-z0-9_-]+", value),
            "Explicit local Langfuse keys required",
        )
    return values | {
        "LANGFUSE_ENABLED": "true",
        "LANGFUSE_BASE_URL": "http://langfuse-web:3000",
        "LANGFUSE_ENVIRONMENT": "core-search-smoke",
        "LLM_RANKING_MODEL_TIMEOUT_SECONDS": "2",
        "LLM_RANKING_RUN_TIMEOUT_SECONDS": "3",
        "AI_RANKING_READ_TIMEOUT": "10s",
    }


def span_tree(scenario):
    # Keys distinguish Core and Python's identically named search.ranking spans.
    tree = {
        "total": ("search.total", None),
        "database": ("search.database_fetch", "total"),
        "eligibility": ("search.eligibility_prepare", "total"),
        "retrieval": ("search.retrieval", "total"),
        "documents": ("search.document_prepare", "retrieval"),
        "keyword": ("search.keyword_search", "retrieval"),
        "semantic_http": ("search.semantic_search", "retrieval"),
        "merge": ("search.candidate_merge", "retrieval"),
        "ranking_http": ("search.ranking", "total"),
        "semantic_request": ("search.semantic.request", "semantic_http"),
        "semantic": ("search.semantic", "semantic_request"),
        "embedding": ("search.embedding", "semantic"),
        "vector": ("search.vector", "semantic"),
        "ranking_request": ("search.ranking.request", "ranking_http"),
        "ranking": ("search.ranking", "ranking_request"),
        "model": ("search.ranking.model", "ranking"),
        "selection": ("search.selection", "ranking"),
    }
    if scenario == "hit":
        for key in ("embedding", "model", "selection"):
            del tree[key]
    elif scenario in {"fail", "timeout"}:
        del tree["selection"]
    else:
        require(scenario == "ok", "Unknown trace scenario")
    return tree


def verify_observations(observations, trace_id, scenario, private_values):
    tree = span_tree(scenario)
    require(len(observations) == len(tree), "Missing or unexpected search observations")
    require(
        len({item["id"] for item in observations}) == len(tree),
        "Duplicate observation IDs",
    )
    matched = {}
    errors = {"total", "ranking_http", "ranking_request", "ranking", "model"}
    for key, (name, parent) in tree.items():
        parent_id = matched[parent]["id"] if parent else None
        candidates = [
            item
            for item in observations
            if item["name"] == name and item.get("parentObservationId") == parent_id
        ]
        require(len(candidates) == 1, "Missing/ambiguous parent linkage: " + key)
        item = matched[key] = candidates[0]
        require(item["traceId"] == trace_id, "Observation belongs to a different trace")
        require(item.get("endTime"), "Unfinished search observation: " + key)
        failed = scenario in {"fail", "timeout"} and key in errors
        outcome = (
            ("timeout" if scenario == "timeout" else "failed")
            if failed
            else "completed"
        )
        require(item["metadata"].get("outcome") == outcome, "Wrong outcome: " + key)
        require((item["level"] == "ERROR") == failed, "Wrong error level: " + key)
        require(
            item.get("input") in (None, "", "null")
            and item.get("output") in (None, "", "null"),
            "Search input/output was captured: " + key,
        )
    cache = "hit" if scenario == "hit" else "miss"
    require(
        matched["ranking"]["metadata"].get("cache_state") == cache,
        "Wrong ranking cache state",
    )
    require(
        matched["semantic"]["metadata"].get("embedding_cache_state") == cache,
        "Wrong embedding cache state",
    )
    serialized = json.dumps(observations, ensure_ascii=False)
    require(
        all(value not in serialized for value in private_values if value),
        "Private value leaked into trace",
    )
    # Keep evidence allowlisted: never write raw Langfuse records or exception bodies.
    return [
        {
            "id": item["id"],
            "parent_id": item.get("parentObservationId"),
            "name": item["name"],
            "outcome": item["metadata"]["outcome"],
        }
        for item in matched.values()
    ]


def read_observations(environment, trace_id):
    query = urllib.parse.urlencode(
        {"traceId": trace_id, "fields": "basic,io,metadata,model,usage", "limit": 100}
    )
    auth = base64.b64encode(
        (
            environment["LANGFUSE_PUBLIC_KEY"]
            + ":"
            + environment["LANGFUSE_SECRET_KEY"]
        ).encode()
    ).decode()
    request = urllib.request.Request(
        environment["LANGFUSE_BASE_URL"].rstrip("/")
        + "/api/public/v2/observations?"
        + query,
        headers={"Authorization": "Basic " + auth},
    )
    with LOCAL_HTTP.open(request, timeout=10) as response:
        return json.load(response)["data"]


def verify_search_traces(
    *, core_url, stub_url, environment, core_logs, call_json, output
):
    tracing_env(
        environment
    )  # Reject external endpoints even when called without the Compose driver.
    report = {"status": "running", "model_api_calls": 0, "scenarios": []}
    output.parent.mkdir(parents=True, exist_ok=True)
    require(not output.exists(), "Use a new search trace evidence output path")

    def save():
        output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    save()
    nonce = uuid.uuid4().hex
    try:
        for scenario, status in (
            ("ok", 200),
            ("hit", 200),
            ("fail", 503),
            ("timeout", 504),
        ):
            record = {"scenario": scenario, "status": "running"}
            report["scenarios"].append(record)
            save()
            query = f"서울 AI PRIVATE-CORE-TRACE-{nonce}-{'ok' if scenario == 'hit' else scenario}"
            before = set(TRACE_PATTERN.findall(core_logs()))
            code, response = call_json(
                core_url
                + "/api/v1/support-programs/search?"
                + urllib.parse.urlencode(
                    {
                        "query": query,
                        "acceptingOnly": "true",
                    }
                )
            )
            record["http_status"] = code
            require(code == status, "Unexpected Core search HTTP status: " + scenario)
            if code == 200:
                require(
                    response.get("totalCount", 0) >= 2,
                    "Core returned no fixture search results",
                )
            else:
                expected = (
                    "AI_SERVICE_TIMEOUT"
                    if scenario == "timeout"
                    else "AI_SERVICE_UNAVAILABLE"
                )
                require(
                    response.get("code") == expected, "Core lost the AI failure code"
                )
            deadline = time.monotonic() + 10
            while True:
                new = set(TRACE_PATTERN.findall(core_logs())) - before
                if new or time.monotonic() >= deadline:
                    break
                time.sleep(0.2)
            require(len(new) == 1, "Expected one actual Core-generated trace ID")
            trace_id = record["trace_id"] = new.pop()
            deadline = time.monotonic() + 90
            while True:
                observations = read_observations(environment, trace_id)
                if len(observations) >= len(span_tree(scenario)) and all(
                    item.get("endTime") for item in observations
                ):
                    break
                require(
                    time.monotonic() < deadline,
                    "Langfuse readback timed out: " + scenario,
                )
                time.sleep(1)
            record["observations"] = verify_observations(
                observations,
                trace_id,
                scenario,
                [
                    query,
                    "PRIVATE-CORE-",
                    "catalog-verification-key-never-sent",
                    environment["LANGFUSE_SECRET_KEY"],
                ],
            )
            counts_code, counts = call_json(stub_url + "/trace-counts")
            require(counts_code == 200, "Cannot read the offline model call counters")
            # Same query on hit must not call either model again. Failures/timeouts get one attempt.
            require(
                counts.get(query) == {"embedding": 1, "ranking": 1},
                "Unexpected offline model calls: " + scenario,
            )
            record["fixture_calls"] = counts[query]
            record["status"] = "passed"
            save()
            print("PASS: actual Core search trace " + scenario, flush=True)
        require(
            len({record["trace_id"] for record in report["scenarios"]}) == 4,
            "Search requests reused trace IDs",
        )
        report["status"] = "passed"
    except BaseException:
        report["status"] = "failed"
        if report["scenarios"]:
            report["scenarios"][-1]["status"] = "failed"
        raise
    finally:
        save()
