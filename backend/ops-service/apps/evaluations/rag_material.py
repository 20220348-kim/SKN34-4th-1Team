"""완료 RAG 재평가의 고정 원문·검색 근거·답변을 관리자 조회 자료로 구성한다."""

import json
from hashlib import sha256

from .catalog import RAG_SCOPE, selection
from .execution_spec import digest
from .rag_replay import require


def observation(case, document, saved, measured):
    chunks = {chunk["id"]: chunk for chunk in document["chunks"]}
    require(saved["caseId"] == measured["caseId"] == case["id"])
    require(saved["traceId"] == measured["traceId"] and saved["failure"] == measured["failure"])
    stages = ("not_started", "source", "chunk", "index", "search", "answer")
    stage = stages.index(saved["failure"]["stage"]) if saved["failure"] else len(stages)
    require(saved["sourceContentHash"] == (document["contentHash"] if stage > 1 else None))
    # RAG 캡처의 canonical JSON은 한글을 UTF-8로 보존한다.
    chunk_hash = sha256(
        json.dumps(
            document["chunks"],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()
    require(saved["chunksSha256"] == (chunk_hash if stage > 2 else None))
    search, answer = saved["search"], saved["answer"]
    require((search is not None) == (stage >= 4))
    require((answer is not None) == (stage >= 5))
    retrieved = None
    if search is not None:
        require(search["request"]["question"] == case["question"])
        require((search["response"] is not None) == (stage > 4))
        if search["response"] is not None:
            require(search["response"]["question"] == case["question"])
            retrieved = []
            for match in search["response"]["matches"]:
                original = chunks[match["id"]]
                require(
                    all(
                        match[key] == original[key]
                        for key in ("documentId", "order", "contentHash")
                    )
                )
                retrieved.append(match["id"])
            require(len(retrieved) == len(set(retrieved)))
    require(retrieved == measured["retrievedChunkIds"])
    require(measured["retrievalMeasured"] is (retrieved is not None))
    response, context = None, None
    if answer is not None:
        require(answer["request"]["question"] == case["question"])
        context = []
        for chunk in answer["request"]["chunks"]:
            require(
                chunk
                == {key: chunks[chunk["id"]][key] for key in ("id", "documentId", "order", "text")}
            )
            context.append(chunk["id"])
        require(context == retrieved)
        response = answer["response"]
        require((response is not None) == (stage > 5))
    cited = response["citationChunkIds"] if response is not None else None
    require(cited == measured["citedChunkIds"])
    require(measured["answerMeasured"] is (response is not None))
    require(response is None or (saved["failure"] is None and set(cited) <= set(context)))
    return {
        "answer": response["answer"] if response is not None else None,
        "answer_status": response["answerStatus"] if response is not None else None,
        "retrieved_chunk_ids": retrieved,
        "context_chunk_ids": context,
        "cited_chunk_ids": cited,
        "failure": saved["failure"],
        "trace_id": saved["traceId"],
    }


def material_from_sources(fixture, candidate, reference, comparison):
    require(
        fixture["schemaVersion"]
        in {"support-program-rag-fixture-v1", "support-program-rag-fixture-v2"}
    )
    official = fixture["schemaVersion"] == "support-program-rag-fixture-v2"
    require(fixture["dataType"] == ("official-html-snapshot" if official else "synthetic"))
    require(fixture["scope"] == comparison["scope"] == RAG_SCOPE)
    require(fixture["referenceSource"] == "ai-authored-not-human-reviewed")
    case_ids = comparison["case_ids"]
    cases = fixture["cases"]
    require([case["id"] for case in cases] == case_ids and len(set(case_ids)) == len(case_ids))
    documents = {doc["documentId"]: doc for doc in fixture["documents"]}
    require(len(documents) == len(fixture["documents"]))
    for document in documents.values():
        require(sha256(document["content"].encode()).hexdigest() == document["contentHash"])
        chunks = document["chunks"]
        require(len({c["id"] for c in chunks}) == len(chunks))
        for chunk in chunks:
            require(chunk["documentId"] == document["documentId"])
            require(sha256(chunk["text"].encode()).hexdigest() == chunk["contentHash"])
    for capture, report in (
        (candidate, comparison["current"]),
        (reference, comparison["reference"]),
    ):
        require(capture["scope"] == RAG_SCOPE)
        require(
            capture["schemaVersion"]
            == (
                "support-program-rag-capture-v2"
                if capture["execution"]["kind"] == "integration-stub"
                else "support-program-rag-capture-v1"
            )
        )
        require(capture["fixtureSha256"] == report["fixtureSha256"])
        require(capture["execution"] == report["execution"])
        require([c["caseId"] for c in capture["cases"]] == case_ids)
        require([c["caseId"] for c in report["cases"]] == case_ids)
    values = []
    for index, case in enumerate(cases):
        document = documents[case["documentId"]]
        chunks = {chunk["id"]: chunk for chunk in document["chunks"]}
        for expected in case["expectedEvidence"]:
            require(expected["quote"] in chunks[expected["chunkId"]]["text"])
        values.append(
            {
                "case_id": case["id"],
                "question": case["question"],
                "document_id": document["documentId"],
                "source_url": document["sourceUrl"],
                "content": document["content"],
                "content_sha256": document["contentHash"],
                "chunk_version": document["chunkVersion"],
                **({"source_collected_at": document["source"]["collectedAt"]} if official else {}),
                "chunks": [
                    {key: chunk[key] for key in ("id", "order", "text")}
                    for chunk in document["chunks"]
                ],
                "expected_status": case["expectedStatus"],
                "expected_evidence": [
                    {"chunk_id": e["chunkId"], "quote": e["quote"]}
                    for e in case["expectedEvidence"]
                ],
                **{
                    name: observation(
                        case, document, capture["cases"][index], comparison[report]["cases"][index]
                    )
                    for name, capture, report in (
                        ("candidate", candidate, "current"),
                        ("reference", reference, "reference"),
                    )
                },
            }
        )
    return {
        "schema_version": 1,
        **({"data_type": fixture["dataType"]} if official else {}),
        "evaluation_scope": RAG_SCOPE,
        "reference_source": fixture["referenceSource"],
        "baseline_eligible": False,
        "fixture_sha256": comparison["current"]["fixtureSha256"],
        "candidate_capture_sha256": comparison["current"]["captureSha256"],
        "reference_capture_sha256": comparison["reference"]["captureSha256"],
        "candidate_measurement_kind": comparison["current"]["measurementKind"],
        "reference_measurement_kind": comparison["reference"]["measurementKind"],
        "cases": values,
    }


def read_material(run):
    from .artifact_store import read_artifact, read_evidence
    from .services import ResultsUnavailable, read_result

    try:
        require(run.status == "COMPLETED" and run.execution_mode in {"replay", "recovery", "live"})
        require(run.execution_spec["evaluation_scope"] == RAG_SCOPE)
        require(run.execution_spec["execution_mode"] == run.execution_mode)
        _, _, _, comparison = read_result(run)
        dataset, candidate, reference = selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )
        require(dataset["evaluation_scope"] == RAG_SCOPE)
        values = []
        for path, recovery_path, expected in (
            (
                dataset["fixture"],
                "recovery-fixture.json",
                run.execution_spec["dataset"]["fixture_sha256"],
            ),
            (candidate.get("path"), "capture/capture.json", comparison["current"]["captureSha256"]),
            (
                reference.get("path"),
                "reference-capture.json",
                run.execution_spec["reference_sha256"],
            ),
        ):
            raw = (
                read_artifact(run.pk, recovery_path)
                if run.execution_mode == "recovery" or path is None
                else read_evidence(path)
            )
            require(sha256(raw).hexdigest() == expected)
            values.append(json.loads(raw))
        material = material_from_sources(*values, comparison)
        return {**material, "material_sha256": digest(material)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise ResultsUnavailable from exc
