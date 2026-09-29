#!/usr/bin/env python3
"""고정 원문·청크와 RAG 캡처를 오프라인 검증한다. 서버·모델 호출 기능은 없다."""

import argparse
import json
import re
import sys
from hashlib import sha256
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "backend/ai-service"))

from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerResponse,
    SupportProgramEvidenceBatchRequest,
    SupportProgramEvidenceSearchRequest,
    SupportProgramEvidenceSearchResponse,
)

SCOPE = "source-chunks-retrieval-answer"
STAGES = ("not_started", "source", "chunk", "index", "search", "answer")
HASH = re.compile(r"[0-9a-f]{64}\Z")
TRACE = re.compile(r"[0-9a-f]{32}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return sha256(
        value.encode("utf-8") if isinstance(value, str) else value
    ).hexdigest()


def json_digest(value):
    return digest(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    )


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result

    def invalid(_):
        raise ValueError("non-finite JSON number")

    raw = Path(path).read_bytes()
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid), digest(
        raw
    )


def fields(value, names):
    require(
        isinstance(value, dict) and set(value) == set(names.split()),
        f"expected fields: {names}",
    )


def text(value):
    return isinstance(value, str) and bool(value.strip()) and value == value.strip()


def hash_value(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def model_contract(model, value):
    # Do not silently normalize recorded questions, aliases or response text.
    parsed = model.model_validate_json(
        json.dumps(value, ensure_ascii=False, allow_nan=False), strict=True
    )
    require(
        parsed.model_dump(mode="json", by_alias=True) == value,
        "non-canonical recorded API payload",
    )


def validate_fixture(fixture):
    fields(
        fixture,
        "schemaVersion scope datasetVersion dataType referenceSource documents cases",
    )
    require(
        fixture["schemaVersion"] == "support-program-rag-fixture-v1"
        and fixture["scope"] == SCOPE,
        "unsupported RAG fixture or scope",
    )
    require(text(fixture["datasetVersion"]), "dataset version required")
    require(
        fixture["dataType"] == "synthetic"
        and fixture["referenceSource"] == "ai-authored-not-human-reviewed",
        "v1 requires explicitly synthetic, unreviewed references",
    )
    require(
        isinstance(fixture["documents"], list) and 1 <= len(fixture["documents"]) <= 50,
        "invalid documents",
    )
    documents = {}
    for document in fixture["documents"]:
        fields(document, "documentId sourceUrl content contentHash chunkVersion chunks")
        require(
            text(document["documentId"]) and document["documentId"] not in documents,
            "duplicate document",
        )
        require(
            text(document["sourceUrl"])
            and document["sourceUrl"].startswith("https://"),
            "source URL required",
        )
        require(
            text(document["content"])
            and digest(document["content"]) == document["contentHash"],
            "source hash mismatch",
        )
        require(text(document["chunkVersion"]), "chunk version required")
        chunks = document["chunks"]
        model_contract(SupportProgramEvidenceBatchRequest, {"chunks": chunks})
        for order, chunk in enumerate(chunks):
            require(
                chunk["documentId"] == document["documentId"]
                and chunk["order"] == order,
                "chunk document or order mismatch",
            )
            expected_id = digest(
                f"{document['documentId']}\0{document['contentHash']}\0{order}"
            )
            require(
                chunk["id"] == expected_id,
                "chunk ID must bind source version and order",
            )
        # The current Core chunker partitions text without overlap and normalizes whitespace.
        # This checks preservation, not whether Core actually performed the chunking.
        require(
            "".join(document["content"].split())
            == "".join("".join(c["text"].split()) for c in chunks),
            "chunks do not preserve the source text in order",
        )
        documents[document["documentId"]] = document

    require(
        isinstance(fixture["cases"], list) and 1 <= len(fixture["cases"]) <= 100,
        "invalid cases",
    )
    cases = {}
    for case in fixture["cases"]:
        fields(case, "id documentId question expectedStatus expectedEvidence")
        require(text(case["id"]) and case["id"] not in cases, "duplicate case")
        require(
            text(case["documentId"]) and case["documentId"] in documents,
            "unknown case document",
        )
        document = documents[case["documentId"]]
        model_contract(
            SupportProgramEvidenceSearchRequest, search_request(case, document)
        )
        require(
            case["expectedStatus"] in ("ANSWERED", "INSUFFICIENT_EVIDENCE"),
            "invalid expected status",
        )
        evidence = case["expectedEvidence"]
        require(isinstance(evidence, list), "invalid expected evidence")
        chunks = {chunk["id"]: chunk for chunk in document["chunks"]}
        seen = set()
        for item in evidence:
            fields(item, "chunkId quote")
            require(
                text(item["chunkId"])
                and item["chunkId"] in chunks
                and item["chunkId"] not in seen,
                "unknown or duplicate reference chunk",
            )
            require(
                text(item["quote"])
                and item["quote"] in chunks[item["chunkId"]]["text"],
                "reference quote mismatch",
            )
            seen.add(item["chunkId"])
        require(
            bool(evidence) == (case["expectedStatus"] == "ANSWERED"),
            "expected status and evidence disagree",
        )
        cases[case["id"]] = case
    return documents, cases


def search_request(case, document):
    return {
        "question": case["question"],
        "eligibleChunks": [
            {key: value for key, value in chunk.items() if key != "text"}
            for chunk in document["chunks"]
        ],
        "limit": min(5, len(document["chunks"])),
    }


def validate_observation(observation, case, document, kind):
    fields(
        observation,
        "caseId traceId sourceContentHash chunksSha256 indexedCount search answer failure",
    )
    trace_id = observation["traceId"]
    require(
        trace_id is None
        or (
            isinstance(trace_id, str)
            and TRACE.fullmatch(trace_id)
            and trace_id != "0" * 32
        ),
        "invalid trace ID",
    )
    require(
        kind != "synthetic" or trace_id is None,
        "synthetic observations cannot claim real traces",
    )
    failure = observation["failure"]
    if failure is None:
        stage = len(STAGES)
    else:
        fields(failure, "stage code")
        require(
            failure["stage"] in STAGES and text(failure["code"]),
            "invalid failure stage or code",
        )
        stage = STAGES.index(failure["stage"])

    require(
        observation["sourceContentHash"]
        == (document["contentHash"] if stage > 1 else None),
        "observed source version mismatch",
    )
    require(
        observation["chunksSha256"]
        == (json_digest(document["chunks"]) if stage > 2 else None),
        "observed chunk version mismatch",
    )
    count = observation["indexedCount"]
    require(
        (type(count) is int and count == len(document["chunks"]))
        if stage > 3
        else count is None,
        "invalid index acknowledgement or unexpected downstream execution",
    )
    search, answer = observation["search"], observation["answer"]
    if stage < 4:
        require(
            search is None and answer is None,
            "downstream result after upstream failure",
        )
        return None, None
    fields(search, "request response")
    model_contract(SupportProgramEvidenceSearchRequest, search["request"])
    require(
        search["request"] == search_request(case, document),
        "search request differs from pinned input",
    )
    if stage == 4:
        require(
            search["response"] is None and answer is None,
            "failed search cannot publish validated results",
        )
        return None, None
    response = search["response"]
    model_contract(SupportProgramEvidenceSearchResponse, response)
    require(response["question"] == case["question"], "search question mismatch")
    matches = response["matches"]
    require(len(matches) == search["request"]["limit"], "incomplete search result")
    chunks = {chunk["id"]: chunk for chunk in document["chunks"]}
    retrieved = []
    for match in matches:
        chunk = chunks.get(match["id"])
        require(
            chunk is not None and match["id"] not in retrieved,
            "foreign or duplicate search match",
        )
        require(
            {k: v for k, v in match.items() if k != "score"}
            == {k: v for k, v in chunk.items() if k != "text"},
            "search match version mismatch",
        )
        require(type(match["score"]) in (int, float), "invalid search score")
        retrieved.append(match["id"])
    require(
        matches == sorted(matches, key=lambda match: (-match["score"], match["id"])),
        "search ranking order mismatch",
    )

    fields(answer, "request response")
    model_contract(SupportProgramEvidenceAnswerRequest, answer["request"])
    expected_request = {
        "question": case["question"],
        "chunks": [
            {k: v for k, v in chunks[chunk_id].items() if k != "contentHash"}
            for chunk_id in retrieved
        ],
    }
    require(
        answer["request"] == expected_request,
        "answer must use exactly the retrieved original chunks in rank order",
    )
    if stage == 5:
        require(
            answer["response"] is None,
            "failed answer cannot publish a validated response",
        )
        return retrieved, None
    model_contract(SupportProgramEvidenceAnswerResponse, answer["response"])
    require(
        set(answer["response"]["citationChunkIds"]) <= set(retrieved),
        "citation outside retrieved evidence",
    )
    return retrieved, answer["response"]


def metric(values, eligible_count):
    measured = [value for value in values if value is not None]
    return {
        "value": sum(measured) / len(measured) if measured else None,
        "measuredCaseCount": len(measured),
        "eligibleCaseCount": eligible_count,
    }


def evaluate(fixture_path, capture_path=None):
    fixture, fixture_hash = read_json(fixture_path)
    documents, cases = validate_fixture(fixture)
    report = {
        "schemaVersion": "support-program-rag-report-v1",
        "scope": SCOPE,
        "datasetVersion": fixture["datasetVersion"],
        "fixtureSha256": fixture_hash,
        "referenceSource": fixture["referenceSource"],
        "caseCount": len(cases),
        "evaluatorSha256": digest(Path(__file__).read_bytes()),
        "apiContractSha256": json_digest(
            {
                path: digest(
                    (HERE.parents[1] / "backend/ai-service/app" / path).read_bytes()
                )
                for path in (
                    "support_program_evidence/models.py",
                    "support_program_identity.py",
                )
            }
        ),
        "captureSha256": None,
        "execution": None,
        "captureValidated": False,
        "liveExecutionPerformed": False,
        "measurementKind": "fixture-validation-only",
        "semanticFaithfulness": None,
        "semanticReviewRequired": True,
        "baselineEligible": False,
        "completed": False,
        "versions": [
            {
                "documentId": document["documentId"],
                "sourceContentHash": document["contentHash"],
                "chunkVersion": document["chunkVersion"],
                "chunksSha256": json_digest(document["chunks"]),
            }
            for document in documents.values()
        ],
        "cases": [],
    }
    observations = {}
    if capture_path is not None:
        capture, capture_hash = read_json(capture_path)
        fields(capture, "schemaVersion scope fixtureSha256 execution cases")
        require(
            capture["schemaVersion"] == "support-program-rag-capture-v1"
            and capture["scope"] == SCOPE,
            "unsupported RAG capture or scope",
        )
        require(
            capture["fixtureSha256"] == fixture_hash, "capture fixture hash mismatch"
        )
        execution = capture["execution"]
        fields(execution, "kind model embeddingModel promptSha256 recorderSha256")
        require(
            execution["kind"] in ("synthetic", "recorded"), "invalid execution kind"
        )
        if execution["kind"] == "synthetic":
            require(
                all(
                    execution[key] is None
                    for key in (
                        "model",
                        "embeddingModel",
                        "promptSha256",
                        "recorderSha256",
                    )
                ),
                "synthetic capture cannot claim model execution",
            )
        else:
            require(
                text(execution["model"])
                and text(execution["embeddingModel"])
                and hash_value(execution["promptSha256"])
                and hash_value(execution["recorderSha256"]),
                "recorded execution versions required",
            )
        require(
            isinstance(capture["cases"], list) and len(capture["cases"]) == len(cases),
            "capture must account for every fixture case",
        )
        for observation in capture["cases"]:
            require(
                isinstance(observation, dict) and text(observation.get("caseId")),
                "invalid observation",
            )
            case_id = observation["caseId"]
            require(
                case_id in cases and case_id not in observations,
                "unknown or duplicate captured case",
            )
            observations[case_id] = observation
        report.update(
            captureSha256=capture_hash,
            execution=execution,
            captureValidated=True,
            measurementKind="synthetic-contract-check"
            if execution["kind"] == "synthetic"
            else "recorded-capture-replay",
        )

    for case_id, case in cases.items():
        document = documents[case["documentId"]]
        observation = observations.get(case_id)
        retrieved, answer = (
            (None, None)
            if observation is None
            else validate_observation(
                observation, case, document, report["execution"]["kind"]
            )
        )
        expected = {item["chunkId"] for item in case["expectedEvidence"]}
        citations = set(answer["citationChunkIds"]) if answer else set()
        report["cases"].append(
            {
                "caseId": case_id,
                "traceId": observation["traceId"] if observation else None,
                "failure": observation["failure"] if observation else None,
                "retrievalRecallAtK": len(expected & set(retrieved)) / len(expected)
                if expected and retrieved is not None
                else None,
                "answerCitationRecall": len(expected & citations) / len(expected)
                if expected and answer
                else None,
                "answerStatusMatches": answer["answerStatus"] == case["expectedStatus"]
                if answer
                else None,
                "retrievalMeasured": retrieved is not None,
                "answerMeasured": answer is not None,
                "retrievalResultSha256": json_digest(observation["search"]["response"])
                if retrieved is not None
                else None,
                "answerResultSha256": json_digest(answer)
                if answer is not None
                else None,
                "retrievedChunkIds": retrieved,
                "citedChunkIds": answer["citationChunkIds"] if answer else None,
                "k": min(5, len(document["chunks"])),
            }
        )
    rows = report["cases"]
    eligible = sum(bool(case["expectedEvidence"]) for case in cases.values())
    report["metrics"] = {
        "retrievalRecallAtK": metric(
            [row["retrievalRecallAtK"] for row in rows], eligible
        ),
        "answerCitationRecall": metric(
            [row["answerCitationRecall"] for row in rows], eligible
        ),
        "answerStatusAccuracy": metric(
            [row["answerStatusMatches"] for row in rows], len(cases)
        ),
    }
    report["coverage"] = {
        "retrievalCaseCount": sum(row["retrievalMeasured"] for row in rows),
        "answerCaseCount": sum(row["answerMeasured"] for row in rows),
        "traceCaseCount": sum(row["traceId"] is not None for row in rows),
        "failedCaseCount": sum(row["failure"] is not None for row in rows),
    }
    report["completed"] = all(row["answerMeasured"] for row in rows)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--capture", type=Path)
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.fixture, args.capture)
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(f"RAG capture validation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
