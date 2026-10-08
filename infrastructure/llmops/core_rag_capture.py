"""Collect real Core/AI wire records in the owned, synthetic Compose integration run."""

import importlib.util
import json
import time
import uuid
from pathlib import Path

import core_evidence_trace as trace
from core_search_trace import read_observations, require

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "evaluation/support-program-evidence"
spec = importlib.util.spec_from_file_location(
    "core_rag_evaluator", EVIDENCE / "rag_evaluate.py"
)
rag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rag)
SOURCE = (
    ROOT
    / "backend/core-service/src/test/resources/support-program-evidence/rag-synthetic-source.json"
)
CHUNKER = (
    ROOT
    / "backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/service/evidence/SupportProgramEvidenceChunker.kt"
)
SCENARIOS = (
    "ok",
    "hit",
    "miss",
    "citation-miss",
    "insufficient",
    "fail",
    "timeout",
    "invalid-citation",
    "search-fail",
)


def write(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def replace_owned_source(sql, content, previous_hash):
    # sql is supplied only after verify-catalog-separation proves ownership of its fresh project.
    where = "source_code='BIZINFO' AND source_program_id='PBLN_COMPOSE_EXPORT'"
    require(
        sql(
            "mysql",
            "SELECT content_hash FROM support_program_source_document WHERE " + where,
        )
        == previous_hash,
        "Refuse to change an unexpected source snapshot",
    )
    source_hash = rag.digest(content)
    sql(
        "mysql",
        "UPDATE support_program_source_document SET content=CONVERT(0x"
        + content.encode().hex()
        + " USING utf8mb4),content_hash='"
        + source_hash
        + "',fetched_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 9 HOUR) WHERE "
        + where
        + " AND content_hash='"
        + previous_hash
        + "'",
    )
    require(
        sql(
            "mysql",
            "SELECT content_hash FROM support_program_source_document WHERE " + where,
        )
        == source_hash,
        "Synthetic source version did not change",
    )


def observation(
    case_id, trace_id, content, chunks, calls, public_status, public_response
):
    require(
        [call["operation"] for call in calls]
        in (["chunks", "search"], ["chunks", "search", "answers"]),
        "Missing or extra actual AI operations",
    )
    require(
        all(call["traceId"] == trace_id for call in calls), "Disconnected AI wire trace"
    )
    index, search = calls[:2]
    require(
        index["status"] == 200
        and index["request"] == {"chunks": chunks}
        and index["response"] == {"indexedCount": len(chunks)},
        "Actual indexing did not acknowledge the captured chunks",
    )
    result = {
        "caseId": case_id,
        "traceId": trace_id,
        "sourceContentHash": rag.digest(content),
        "chunksSha256": rag.json_digest(chunks),
        "indexedCount": index["response"]["indexedCount"],
        "search": {
            "request": search["request"],
            "response": search["response"] if search["status"] == 200 else None,
        },
        "answer": None,
        "failure": None,
    }
    if search["status"] != 200:
        require(
            len(calls) == 2 and search["status"] == public_status == 503,
            "Answer followed a failed search",
        )
        result["failure"] = {
            "stage": "search",
            "code": search["response"]["detail"]["code"],
        }
        return result
    require(len(calls) == 3, "Answer call missing after successful retrieval")
    answer = calls[2]
    result["answer"] = {
        "request": answer["request"],
        "response": answer["response"] if answer["status"] == 200 else None,
    }
    if answer["status"] != 200:
        require(
            answer["status"] == public_status == 503,
            "Failed answer became public success",
        )
        result["failure"] = {
            "stage": "answer",
            "code": answer["response"]["detail"]["code"],
        }
    else:
        response = answer["response"]
        require(
            public_status == 200
            and all(
                public_response.get(key) == response[key]
                for key in ("answer", "answerStatus")
            ),
            "Core public answer differs from recorded AI answer",
        )
        by_id = {chunk["id"]: chunk for chunk in chunks}
        expected = [
            {
                "excerpt": by_id[chunk_id]["text"],
                "sourceUrl": public_response["citations"][0]["sourceUrl"],
                "sourceLabel": trace.SOURCE_LABEL,
                "chunkOrder": by_id[chunk_id]["order"],
            }
            for chunk_id in response["citationChunkIds"]
        ]
        require(
            public_response.get("citations") == expected,
            "Core citations differ from recorded originals",
        )
    return result


def fixture_for(content, chunks, cases, source_url, version):
    source = json.loads(SOURCE.read_bytes())
    require(
        len(chunks) == 6, "Production chunker must generate exactly six fixture chunks"
    )
    for case in cases:
        quotes = (
            []
            if case["expectedStatus"] == "INSUFFICIENT_EVIDENCE"
            else source["expectedQuotes"][: 1 if case["id"] == "miss" else 2]
        )
        references = []
        for quote in quotes:
            matches = [chunk for chunk in chunks if quote in chunk["text"]]
            require(
                len(matches) == 1,
                "Pinned expected evidence is missing or ambiguous in actual chunks",
            )
            references.append({"chunkId": matches[0]["id"], "quote": quote})
        case["expectedEvidence"] = references
    fixture = {
        "schemaVersion": "support-program-rag-fixture-v1",
        "scope": rag.SCOPE,
        "datasetVersion": "core-generated-" + version,
        "dataType": "synthetic",
        "referenceSource": "ai-authored-not-human-reviewed",
        "documents": [
            {
                "documentId": "BIZINFO:" + trace.PROGRAM_ID,
                "sourceUrl": source_url,
                "content": content,
                "contentHash": rag.digest(content),
                "chunkVersion": "core-sha256:" + rag.digest(CHUNKER.read_bytes()),
                "chunks": chunks,
            }
        ],
        "cases": cases,
    }
    rag.validate_fixture(fixture)
    return fixture


def verify_rag_capture(
    *, core_url, environment, core_logs, read_wire, sql, program, output
):
    require(not output.exists(), "Use a fresh RAG integration output directory")
    require(
        program["id"] == trace.PROGRAM_ID and program["sourceCode"] == "BIZINFO",
        "Unexpected RAG fixture program",
    )
    output.mkdir(parents=True)
    report = {
        "status": "running",
        "paid_model_api_calls": 0,
        "source_transport": "synthetic-database-snapshot",
        "source_fixture_sha256": rag.digest(SOURCE.read_bytes()),
        "versions": [],
    }
    source = json.loads(SOURCE.read_bytes())
    require(
        source["schemaVersion"] == "core-rag-synthetic-source-v1"
        and source["dataType"] == "synthetic",
        "Invalid synthetic source",
    )
    previous = rag.digest(trace.SOURCE_TEXT)
    nonce = uuid.uuid4().hex
    seen_traces = set()
    previous_ids = set()
    try:
        for version, content, scenarios in (
            ("v1", source["content"], SCENARIOS),
            ("v2", source["updatedContent"], ("ok",)),
        ):
            replace_owned_source(sql, content, previous)
            previous = rag.digest(content)
            directory = output / version
            directory.mkdir()
            record = {"version": version, "status": "running", "cases": []}
            report["versions"].append(record)
            cases = [
                {
                    "id": scenario,
                    "documentId": "BIZINFO:" + trace.PROGRAM_ID,
                    "question": f"PRIVATE-RAG-QUERY-{nonce}-{'ok' if scenario == 'hit' else scenario}",
                    "expectedStatus": "INSUFFICIENT_EVIDENCE"
                    if scenario == "insufficient"
                    else "ANSWERED",
                    "expectedEvidence": [],
                }
                for scenario in scenarios
            ]
            observations, chunks = [], None
            for case in cases:
                before = set(trace.TRACE_PATTERN.findall(core_logs()))
                code, body = trace.post_question(core_url, case["question"])
                deadline = time.monotonic() + 10
                while True:
                    current = set(trace.TRACE_PATTERN.findall(core_logs())) - before
                    if current or time.monotonic() >= deadline:
                        break
                    time.sleep(0.2)
                require(len(current) == 1, "Missing or ambiguous actual Core trace")
                trace_id = current.pop()
                require(
                    trace_id not in seen_traces and trace_id != "a" * 32,
                    "Reused or client-controlled Core trace",
                )
                seen_traces.add(trace_id)
                wire = [json.loads(line) for line in read_wire().splitlines() if line]
                execution = wire[0]["execution"]
                calls = [item for item in wire[1:] if item["traceId"] == trace_id]
                record["cases"].append(
                    {
                        "id": case["id"],
                        "traceId": trace_id,
                        "publicStatus": code,
                        "publicResponse": body,
                        "aiCalls": calls,
                    }
                )
                write(directory / "wire.json", record)
                if chunks is None:
                    require(
                        calls and calls[0]["operation"] == "chunks",
                        "No actual Core chunk output",
                    )
                    chunks = calls[0]["request"]["chunks"]
                    require(
                        not ({chunk["id"] for chunk in chunks} & previous_ids),
                        "Source version reused old chunk IDs",
                    )
                    fixture = fixture_for(
                        content, chunks, cases, program["sourceUrl"], version
                    )
                    write(directory / "fixture.json", fixture)
                require(
                    all(
                        citation["sourceUrl"] == program["sourceUrl"]
                        for citation in body.get("citations", [])
                    ),
                    "Wrong public source URL",
                )
                row = observation(
                    case["id"], trace_id, content, chunks, calls, code, body
                )
                observations.append(row)
                # Unstarted cases remain explicit, including if a later assertion stops the run.
                pending = [
                    {
                        "caseId": value["id"],
                        "traceId": None,
                        "sourceContentHash": None,
                        "chunksSha256": None,
                        "indexedCount": None,
                        "search": None,
                        "answer": None,
                        "failure": {
                            "stage": "not_started",
                            "code": "INTEGRATION_NOT_REACHED",
                        },
                    }
                    for value in cases[len(observations) :]
                ]
                write(
                    directory / "capture.json",
                    {
                        "schemaVersion": "support-program-rag-capture-v2",
                        "scope": rag.SCOPE,
                        "fixtureSha256": rag.digest(
                            (directory / "fixture.json").read_bytes()
                        ),
                        "execution": execution,
                        "cases": observations + pending,
                    },
                )
                base_scenario = (
                    case["id"]
                    if case["id"]
                    in {
                        "ok",
                        "hit",
                        "fail",
                        "timeout",
                        "invalid-citation",
                        "search-fail",
                    }
                    else "hit"
                )
                query_cache = "hit" if version == "v2" or case["id"] == "hit" else "miss"
                deadline = time.monotonic() + 90
                while True:
                    spans = read_observations(environment, trace_id)
                    if len(spans) >= trace.observation_count(base_scenario, query_cache) and all(
                        item.get("endTime") for item in spans
                    ):
                        break
                    require(
                        time.monotonic() < deadline,
                        "Actual RAG Langfuse readback timed out",
                    )
                    time.sleep(1)
                record["cases"][-1]["observations"] = trace.verify_observations(
                    spans,
                    trace_id,
                    base_scenario,
                    [
                        case["question"],
                        *source["expectedQuotes"],
                        environment["LANGFUSE_SECRET_KEY"],
                    ],
                    chunk_count=6,
                    query_cache=query_cache,
                )
                write(directory / "wire.json", record)
                write(
                    directory / "report.json",
                    rag.evaluate(
                        directory / "fixture.json", directory / "capture.json"
                    ),
                )
            result = rag.evaluate(
                directory / "fixture.json", directory / "capture.json"
            )
            by_id = {row["caseId"]: row for row in result["cases"]}
            require(
                by_id["ok"]["retrievalRecallAtK"]
                == by_id["ok"]["answerCitationRecall"]
                == 1,
                "Normal integration evidence missing",
            )
            if version == "v1":
                require(
                    by_id["miss"]["retrievalRecallAtK"]
                    == by_id["miss"]["answerCitationRecall"]
                    == 0,
                    "Retrieval omission was not measured",
                )
                require(
                    by_id["citation-miss"]["retrievalRecallAtK"] == 1
                    and by_id["citation-miss"]["answerCitationRecall"] == 0.5,
                    "Citation omission was not separated",
                )
                require(
                    result["coverage"]["failedCaseCount"] == 4
                    and result["coverage"]["answerCaseCount"] == 5,
                    "Missing injected failures",
                )
            require(
                result["measurementKind"] == "integration-stub-replay"
                and not result["baselineEligible"],
                "Stub run became real quality approval",
            )
            previous_ids = {chunk["id"] for chunk in chunks}
            record["status"] = "passed"
            write(directory / "wire.json", record)
            print("PASS: actual Core multichunk RAG capture " + version, flush=True)
        report["status"] = "passed"
        # Only a complete Core run can become a preparation input. Failed cases remain
        # explicit; the plan never grants approval or implies a human-reviewed baseline.
        write(output / "integration.json", report)
        from core_rag_budget import prepare

        for record in report["versions"]:
            prepare(output / record["version"])
    except BaseException:
        report["status"] = "failed"
        for record in report["versions"]:
            if record["status"] == "running":
                record["status"] = "failed"
                write(output / record["version"] / "wire.json", record)
        raise
    finally:
        write(output / "integration.json", report)
