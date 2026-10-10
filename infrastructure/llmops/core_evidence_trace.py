"""Verify disposable Core/MySQL → AI/Qdrant → Langfuse with a synthetic source snapshot."""

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from core_search_trace import LOCAL_HTTP, read_observations, require, tracing_env

TRACE_PATTERN = re.compile(r"support_program_evidence trace_id=([0-9a-f]{32})")
PROGRAM_ID = "PBLN_COMPOSE_EXPORT"
SOURCE_TEXT = "PRIVATE-EVIDENCE-SOURCE 접수 기간은 합성 자료에만 해당합니다. 실제 지원사업 안내나 품질 정답이 아닌 통합 검증용 원문입니다. 신청 조건은 담당 기관의 공고에서 확인해야 합니다."
SCENARIOS = ("ok", "hit", "fail", "timeout", "invalid-citation", "search-fail")
# Core가 기업마당 공고 인용에 붙이는 원문 이름입니다(SupportProgramEvidenceService.EVIDENCE_SOURCE_LABELS).
SOURCE_LABEL = "기업마당 상세 본문"


def span_tree(scenario):
    require(scenario in SCENARIOS, "Unknown evidence scenario")
    tree = {"evidence.total": None}
    for stage in ("detail", "source", "chunk", "index", "search"):
        tree["evidence.core." + stage] = "evidence.total"
    tree["evidence.index"] = "evidence.core.index"
    tree["evidence.index.readiness"] = "evidence.index"
    if scenario == "ok":
        for stage in ("embedding", "upsert"):
            tree["evidence.index." + stage] = "evidence.index"
    tree["evidence.search"] = "evidence.core.search"
    for stage in ("readiness", "embedding"):
        tree["evidence.search." + stage] = "evidence.search"
    if scenario == "search-fail":
        return tree
    for stage in ("vector", "validate"):
        tree["evidence.search." + stage] = "evidence.search"
    tree["evidence.core.answer"] = "evidence.total"
    tree["evidence.answer"] = "evidence.core.answer"
    tree["evidence.model"] = "evidence.answer"
    if scenario not in {"fail", "timeout"}:
        tree["evidence.validate_selection"] = "evidence.answer"
    if scenario in {"ok", "hit"}:
        tree["evidence.validate_response"] = "evidence.answer"
        tree["evidence.core.validate"] = "evidence.total"
    return tree


def embedding_parents(scenario, query_cache=None):
    # These fixture traces use one document batch and at most one uncached question.
    parents = ["evidence.index.embedding"] if scenario == "ok" else []
    if (query_cache or ("hit" if scenario == "hit" else "miss")) != "hit":
        parents.append("evidence.search.embedding")
    return parents


def observation_count(scenario, query_cache=None):
    return len(span_tree(scenario)) + len(embedding_parents(scenario, query_cache))


def verify_observations(observations, trace_id, scenario, private_values, *, chunk_count=1, query_cache=None):
    tree = span_tree(scenario)
    expected_count = observation_count(scenario, query_cache)
    require(len(observations) == expected_count, "Missing or unexpected evidence observations")
    require(len({item["id"] for item in observations}) == expected_count, "Duplicate evidence observations")
    embedding_requests = [item for item in observations if item["name"] == "evidence.embedding.request"]
    by_name = {item["name"]: item for item in observations if item["name"] != "evidence.embedding.request"}
    require(set(by_name) == set(tree), "Unexpected evidence stages")
    failures = set()
    if scenario == "search-fail":
        failures = {"evidence.total", "evidence.core.search", "evidence.search", "evidence.search.embedding"}
    elif scenario not in {"ok", "hit"}:
        failures = {"evidence.total", "evidence.core.answer", "evidence.answer"}
        failures.add("evidence.validate_selection" if scenario == "invalid-citation" else "evidence.model")
    for name, parent in tree.items():
        item = by_name[name]
        require(item["traceId"] == trace_id, "Disconnected evidence trace")
        require(item.get("parentObservationId") == (by_name[parent]["id"] if parent else None), "Wrong evidence parent")
        require(item.get("endTime"), "Unfinished evidence observation")
        # Evidence HTTP keeps its existing 503 contract; AI timeout remains visible in its spans.
        outcome = "failed" if name in failures else "completed"
        if scenario == "timeout" and name in {"evidence.answer", "evidence.model"}:
            outcome = "timeout"
        require(item["metadata"].get("outcome") == outcome, "Wrong evidence outcome")
        require((item["level"] == "ERROR") == (name in failures), "Wrong evidence error level")
        require(
            item.get("input") in (None, "", "null") and item.get("output") in (None, "", "null"),
            "Evidence body captured",
        )
    require(
        by_name["evidence.core.source"]["metadata"].get("cache_state") == "hit",
        "Synthetic source snapshot was not reused",
    )
    chunk = by_name["evidence.core.chunk"]["metadata"]
    require(
        chunk.get("chunk_count") == chunk_count and chunk.get("cache_state") == ("miss" if scenario == "ok" else "hit"),
        "Wrong Core chunk cache",
    )
    require(
        by_name["evidence.index"]["metadata"].get("missing_count") == (chunk_count if scenario == "ok" else 0),
        "Unexpected repeated indexing",
    )
    if scenario != "search-fail":
        cache = query_cache or ("hit" if scenario == "hit" else "miss")
        require(
            by_name["evidence.search"]["metadata"].get("embedding_cache_state") == cache, "Wrong query embedding cache"
        )
        require(
            by_name["evidence.model"]["metadata"].get("usage_reported") is False,
            "Unknown fixture usage became confirmed",
        )
    expected_parents = {by_name[name]["id"] for name in embedding_parents(scenario, query_cache)}
    require(
        len(embedding_requests) == len(expected_parents)
        and {item.get("parentObservationId") for item in embedding_requests} == expected_parents,
        "Wrong embedding request parents or cache calls",
    )
    for item in embedding_requests:
        failed = scenario == "search-fail"
        metadata = item["metadata"]
        require(item["traceId"] == trace_id and item.get("endTime"), "Disconnected embedding request")
        require((item["level"] == "ERROR") == failed, "Wrong embedding request error level")
        require(metadata.get("outcome") == ("failed" if failed else "completed"), "Wrong embedding request outcome")
        require(metadata.get("batch_sequence") == 0, "Wrong embedding batch sequence")
        size, estimate, limit = (metadata.get(key) for key in ("batch_size", "estimated_tokens", "request_token_limit"))
        require(type(size) is int and 1 <= size <= 32, "Wrong embedding batch size")
        require(type(estimate) is int and type(limit) is int and 0 < estimate <= limit <= 262112,
                "Invalid embedding request token bound")
        require(metadata.get("usage_reported") is (not failed), "Wrong embedding usage status")
        require(metadata.get("usage_state") == ("unknown" if failed else "reported"), "Wrong embedding usage state")
        usage = item.get("usageDetails") or {}
        if failed:
            require(not usage, "Unknown embedding usage became confirmed")
        else:
            require(type(usage.get("input")) is int and 0 <= usage["input"] <= limit
                    and usage.get("output") == 0 and usage.get("total") == usage["input"],
                    "Missing or invalid embedding usage")
        require(item.get("input") in (None, "", "null") and item.get("output") in (None, "", "null"),
                "Embedding body captured")
    serialized = json.dumps(observations, ensure_ascii=False)
    require(all(value not in serialized for value in private_values if value), "Private evidence trace data captured")
    return [
        {
            "id": item["id"],
            "parent_id": item.get("parentObservationId"),
            "name": item["name"],
            "outcome": item["metadata"]["outcome"],
        }
        for item in observations
    ]


def seed_source_document(sql, program):
    """Only the Compose driver's newly owned database may be passed as sql."""
    require(program.get("id") == PROGRAM_ID and program.get("sourceCode") == "BIZINFO", "Unexpected fixture program")
    source_url = program["sourceUrl"]
    parsed = urllib.parse.urlsplit(source_url)
    require(
        parsed.scheme == "https"
        and parsed.hostname == "www.bizinfo.go.kr"
        and urllib.parse.parse_qs(parsed.query).get("pblancId") == [PROGRAM_ID],
        "Unexpected fixture source URL",
    )
    where = "source_code='BIZINFO' AND source_program_id='PBLN_COMPOSE_EXPORT'"
    require(
        sql("mysql", "SELECT COUNT(*) FROM support_program_source_document WHERE " + where) == "0",
        "Source fixture already exists",
    )
    # Hex literals preserve UTF-8 without interpolating quote-sensitive source strings.
    values = [
        "CONVERT(0x" + value.encode().hex() + " USING utf8mb4)"
        for value in (
            "BIZINFO",
            PROGRAM_ID,
            source_url,
            SOURCE_TEXT,
            hashlib.sha256(SOURCE_TEXT.encode()).hexdigest(),
        )
    ]
    sql(
        "mysql",
        "INSERT INTO support_program_source_document "
        "(source_code,source_program_id,source_url,content,content_hash,fetched_at) VALUES ("
        + ",".join(values)
        + ",DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 9 HOUR))",
    )
    return source_url


def post_question(core_url, question, *, session_token):
    request = urllib.request.Request(
        core_url + "/api/v1/support-programs/detail/answers",
        data=json.dumps({"sourceCode": "BIZINFO", "sourceProgramId": PROGRAM_ID, "question": question}).encode(),
        # 공고 원문 질문은 회원 전용입니다. 쿠키 없는 Bearer 세션이라 Origin 검사 대상이 아닙니다.
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + session_token,
            "traceparent": "00-" + "a" * 32 + "-" + "b" * 16 + "-01",
        },
    )
    try:
        response = LOCAL_HTTP.open(request, timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.code, json.load(response)


def verify_evidence_traces(*, core_url, session_token, stub_url, environment, core_logs, call_json, sql, program, output):
    tracing_env(environment)
    for url in (core_url, stub_url):
        parsed = urllib.parse.urlsplit(url)
        require(
            parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1"}
            and not parsed.username
            and not parsed.password
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment,
            "Evidence smoke requires loopback fixture endpoints",
        )
    require(not output.exists(), "Use a new evidence trace output path")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "status": "running",
        "model_api_calls": 0,
        "source_transport": "synthetic-database-snapshot",
        "scenarios": [],
    }

    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    save()
    nonce = uuid.uuid4().hex
    try:
        source_url = seed_source_document(sql, program)
        for scenario in SCENARIOS:
            record = {"scenario": scenario, "status": "running"}
            report["scenarios"].append(record)
            save()
            question = f"접수 PRIVATE-EVIDENCE-TRACE-{nonce}-{'ok' if scenario == 'hit' else scenario}"
            before = set(TRACE_PATTERN.findall(core_logs()))
            code, response = post_question(core_url, question, session_token=session_token)
            record["http_status"] = code
            require(code == (200 if scenario in {"ok", "hit"} else 503), "Unexpected Core evidence HTTP status")
            if code == 200:
                require(
                    response.get("answerStatus") == "ANSWERED" and response.get("answer") == "PRIVATE-EVIDENCE-ANSWER",
                    "Wrong evidence response",
                )
                require(
                    response.get("citations")
                    == [{"excerpt": SOURCE_TEXT, "sourceUrl": source_url, "sourceLabel": SOURCE_LABEL, "chunkOrder": 0}],
                    "Wrong Core evidence citation",
                )
            else:
                require(response.get("code") == "AI_SERVICE_UNAVAILABLE", "Core lost the evidence failure code")
            deadline = time.monotonic() + 10
            while True:
                new = set(TRACE_PATTERN.findall(core_logs())) - before
                if new or time.monotonic() >= deadline:
                    break
                time.sleep(0.2)
            require(len(new) == 1, "Expected one Core evidence trace")
            trace_id = record["trace_id"] = new.pop()
            require(trace_id != "a" * 32, "Public traceparent controlled the evidence root")
            deadline = time.monotonic() + 90
            while True:
                observations = read_observations(environment, trace_id)
                if len(observations) >= observation_count(scenario) and all(item.get("endTime") for item in observations):
                    break
                require(time.monotonic() < deadline, "Evidence Langfuse readback timed out")
                time.sleep(1)
            record["observations"] = verify_observations(
                observations,
                trace_id,
                scenario,
                [
                    "PRIVATE-EVIDENCE-",
                    question,
                    SOURCE_TEXT,
                    "catalog-verification-key-never-sent",
                    environment["LANGFUSE_SECRET_KEY"],
                ],
            )
            status, counts = call_json(stub_url + "/trace-counts")
            expected = {"embedding": 1, "answer": 0 if scenario == "search-fail" else 2 if scenario == "hit" else 1}
            require(status == 200 and counts.get(question) == expected, "Unexpected evidence model/query calls")
            require(counts.get(SOURCE_TEXT) == {"source_embedding": 1}, "Source embedding was skipped or repeated")
            record.update(fixture_calls=expected, status="passed")
            save()
            print("PASS: actual Core evidence trace " + scenario, flush=True)
        require(
            len({row["trace_id"] for row in report["scenarios"]}) == len(SCENARIOS),
            "Evidence requests reused trace IDs",
        )
        report["status"] = "passed"
    except BaseException:
        report["status"] = "failed"
        if report["scenarios"]:
            report["scenarios"][-1]["status"] = "failed"
        raise
    finally:
        save()
