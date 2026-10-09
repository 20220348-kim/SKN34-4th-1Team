"""Core HTTP 실행 기록을 검증해 Ops RAG 재평가 목록에 등록한다. 네트워크 호출 없음."""

import argparse
import json
import shutil
import sys
from pathlib import Path

import rag_evaluate as rag
import verify_flow

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = Path("evaluation/support-program-evidence")
OPS = Path("backend/ops-service/apps/evaluations")
sys.path.insert(0, str(ROOT / "backend/ops-service"))


def encode(value):
    return (
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    ).encode()


# Core가 기업마당 공고 인용에 붙이는 원문 이름입니다(SupportProgramEvidenceService.EVIDENCE_SOURCE_LABELS).
BIZINFO_SOURCE_LABEL = "기업마당 상세 본문"


def _expected_public_citations(public_response, citations):
    """Core가 인용에 sourceLabel을 붙이기 전 캡처는 그 키 없이, 붙인 뒤 캡처는 기업마당 원문 이름까지 정확히 비교합니다."""
    observed = public_response.get("citations") if isinstance(public_response, dict) else None
    if observed and all(isinstance(value, dict) and "sourceLabel" in value for value in observed):
        return [{**value, "sourceLabel": BIZINFO_SOURCE_LABEL} for value in citations]
    return citations


def convert(core_raw, api_raw=None, *, fixture_path=verify_flow.DEFAULT_FIXTURE):
    """실제 wire와 공개 응답을 대조한다. 기록에 없는 trace·사용량·사람 승인을 만들지 않는다."""
    core = verify_flow._json(core_raw)
    fixture_raw = Path(fixture_path).read_bytes()
    original = verify_flow._json(fixture_raw)
    stub = core.get("aiTransport") == "http-fixture"
    rag.require(
        core.get("schemaVersion") == "official-evidence-flow-capture-v1"
        and core.get("scope") == "core-http-mysql-frozen-html-ai-evidence-flow"
        and core.get("officialSourceTransport") == "frozen-official-html-fragments"
        and core.get("aiTransport") in {"http-fixture", "explicit-local-ai-http"}
        and (api_raw is None) == stub,
        "Core HTTP capture and API transport evidence must agree",
    )
    rag.require(
        core.get("completed") is True
        and "failureType" not in core
        and core.get("fixtureSha256") == rag.digest(fixture_raw)
        and core.get("fixture") == original,
        "Incomplete or changed Core capture; retain the original failure record",
    )
    api = None if stub else verify_flow._json(api_raw)
    # The original verifier checks model outputs and recorded usage as well as Core wire.
    verified = None if stub else verify_flow.verify(core, api, fixture_path)
    references = [(doc, case) for doc in original["documents"] for case in doc["cases"]]
    rag.require(
        original["schemaVersion"] == "official-evidence-flow-fixture-v1"
        and len(original["documents"]) == 2
        and len(references) == 6
        and type(core.get("expectedCaseCount")) is int
        and core["expectedCaseCount"] == 6
        and len(core.get("cases", [])) == 6,
        "Exactly two official documents and six Core observations are required",
    )
    documents, cases, observations, cached = [], [], [], {}
    for observed, (metadata, case) in zip(core["cases"], references, strict=True):
        html_path = (Path(fixture_path).parent / metadata["htmlFile"]).resolve()
        rag.require(
            html_path.parent == Path(fixture_path).parent.resolve()
            and html_path.suffix == ".html",
            "HTML path escapes fixture directory",
        )
        html_raw = html_path.read_bytes()
        rag.require(
            rag.digest(html_raw) == metadata["htmlSha256"], "Official HTML changed"
        )
        content = verify_flow.document_content(metadata, html_raw.decode())
        chunk = verify_flow.expected_chunk(metadata, content)
        stored = observed["sourceDocument"]
        rag.require(
            observed.get("id") == case["id"]
            and observed.get("expectedStatus") == case["expectedStatus"]
            and observed.get("publicRequest")
            == {
                "sourceCode": metadata["sourceCode"],
                "sourceProgramId": metadata["sourceProgramId"],
                "question": case["question"],
            }
            and "failureType" not in observed
            and observed.get("publicStatus") == 200
            and all(
                stored.get(key) == metadata[key]
                for key in ("sourceCode", "sourceProgramId", "sourceUrl")
            )
            and stored.get("content") == content
            and stored.get("contentHash") == rag.digest(content),
            "Core request, stored source or public outcome differs",
        )
        document_id = chunk["documentId"]
        if document_id not in cached:
            cached[document_id] = stored
            documents.append(
                {
                    "documentId": document_id,
                    "sourceUrl": metadata["sourceUrl"],
                    "content": content,
                    "contentHash": stored["contentHash"],
                    "chunkVersion": "core-http-recorded-single-chunk-v1",
                    "chunks": [chunk],
                    "source": {
                        "sourceCode": metadata["sourceCode"],
                        "sourceProgramId": metadata["sourceProgramId"],
                        "collectedAt": original["sourceCollectedAt"],
                        "htmlSha256": metadata["htmlSha256"],
                        "scope": "frozen-title-and-body-html-no-attachments",
                    },
                }
            )
        rag.require(
            cached[document_id] == stored, "Source cache changed between questions"
        )
        calls = observed.get("aiCalls", [])
        rag.require(
            [(call.get("operation"), call.get("method")) for call in calls]
            == [("chunks", "PUT"), ("search", "POST"), ("answers", "POST")]
            and all(
                call.get("status") == 200 and "failureType" not in call
                for call in calls
            ),
            "Missing, failed or extra internal AI operations",
        )
        index, search, answer = calls
        rag.require(
            index["request"] == {"chunks": [chunk]}
            and type(index["request"]["chunks"][0]["order"]) is int
            and index["response"] == {"indexedCount": 1},
            "Actual Core chunks differ",
        )
        response = answer["response"]
        verify_flow._answer_contract(response, [chunk])
        rag.require(
            observed["publicResponse"]
            == {
                "answer": response["answer"],
                "answerStatus": response["answerStatus"],
                "citations": _expected_public_citations(
                    observed["publicResponse"],
                    [
                        {
                            "excerpt": chunk["text"],
                            "sourceUrl": metadata["sourceUrl"],
                            "chunkOrder": 0,
                        }
                        for _ in response["citationChunkIds"]
                    ],
                ),
            },
            "Core public citations or answer differ from the internal response",
        )
        if stub:
            rag.require(
                response["answer"] == case["stubAnswer"]
                and response["answerStatus"] == case["expectedStatus"],
                "HTTP fixture answer differs",
            )
        cases.append(
            {
                "id": case["id"],
                "documentId": document_id,
                "question": case["question"],
                "expectedStatus": case["expectedStatus"],
                "expectedEvidence": (
                    [{"chunkId": chunk["id"], "quote": case["evidenceText"]}]
                    if case["expectedStatus"] == "ANSWERED"
                    else []
                ),
            }
        )
        observations.append(
            {
                "caseId": case["id"],
                "traceId": None,
                "sourceContentHash": stored["contentHash"],
                "chunksSha256": rag.json_digest(index["request"]["chunks"]),
                "indexedCount": index["response"]["indexedCount"],
                "search": {key: search[key] for key in ("request", "response")},
                "answer": {key: answer[key] for key in ("request", "response")},
                "failure": None,
            }
        )
    fixture = {
        "schemaVersion": "support-program-rag-fixture-v2",
        "scope": rag.SCOPE,
        "datasetVersion": "core-http-official-six-v1",
        "dataType": "official-html-snapshot",
        "referenceSource": "ai-authored-not-human-reviewed",
        "documents": documents,
        "cases": cases,
    }
    by_id, by_case = rag.validate_fixture(fixture)
    # The AI is an HTTP response fixture in this mode: there is no actual model or prompt.
    execution = (
        {
            "kind": "synthetic",
            "model": None,
            "embeddingModel": None,
            "promptSha256": None,
            "recorderSha256": None,
        }
        if stub
        else {
            "kind": "recorded",
            **{
                key: api[key]
                for key in ("model", "embeddingModel", "promptSha256", "recorderSha256")
            },
        }
    )
    for observed in observations:
        case = by_case[observed["caseId"]]
        rag.validate_observation(
            observed, case, by_id[case["documentId"]], execution["kind"]
        )
    capture = {
        "schemaVersion": "support-program-rag-capture-v1",
        "scope": rag.SCOPE,
        "fixtureSha256": rag.digest(encode(fixture)),
        "execution": execution,
        "cases": observations,
    }
    provenance = {
        "schemaVersion": "core-http-rag-import-v1",
        "coreHttpExecuted": True,
        "aiTransport": core["aiTransport"],
        "importModelApiCalls": 0,
        "coreCaptureSha256": rag.digest(core_raw),
        "apiCaptureSha256": None if stub else rag.digest(api_raw),
        "sourceFixtureSha256": rag.digest(fixture_raw),
        "converterSha256": rag.digest(Path(__file__).read_bytes()),
        "recordedStartedAt": core["startedAt"],
        "recordedFinishedAt": core["finishedAt"],
        "recordedApiCalls": 0 if stub else verified["officialApiCalls"]["total"],
        "recordedTokens": None if stub else verified["tokens"],
        "rankingSelectionCaseCount": 0,
        "attachmentsIncluded": False,
        "semanticFaithfulness": None,
        "humanReviewInherited": False,
        "verification": verified,
    }
    return fixture, capture, provenance


def register(core_path, api_path=None, *, repository=ROOT):
    """목록·해시 명세와 원본을 함께 갱신한다. 중복 등록은 검증 후 같은 경로를 반환한다."""
    from apps.evaluations.execution_spec import build_release

    repository = Path(repository).resolve()
    core_raw = Path(core_path).read_bytes()
    api_raw = None if api_path is None else Path(api_path).read_bytes()
    fixture, capture, provenance = convert(core_raw, api_raw)
    dataset_id = "core-official-" + capture["fixtureSha256"][:24]
    capture_id = (
        "core-http-"
        + rag.json_digest(
            {
                key: provenance[key]
                for key in (
                    "coreCaptureSha256",
                    "apiCaptureSha256",
                )
            }
        )[:24]
    )
    relative = Path("runs") / dataset_id
    destination = repository / EVIDENCE / relative
    run_dir = destination / capture_id
    receipt_path = run_dir / "provenance.json"
    paths = {
        "catalog": repository / OPS / "capture_catalog.json",
        "release": repository / OPS / "execution_release.json",
    }
    lock = repository / OPS / ".core-rag-registration.lock"
    with lock.open("x"):
        try:
            originals = {key: path.read_bytes() for key, path in paths.items()}
            release = build_release(repository)
            rag.require(
                json.loads(originals["release"]) == release,
                "Execution release is stale; verify it before registration",
            )
            rag.require(
                all(
                    rag.digest((ROOT / name).read_bytes()) == expected
                    for name, expected in release["rag_evaluation"]["files"].items()
                ),
                "Import evaluator differs from the deployment checkout",
            )
            catalog = json.loads(originals["catalog"])
            expected = {
                "core-capture.json": core_raw,
                "capture.json": encode(capture),
                "provenance.json": encode(provenance),
            }
            if api_raw is not None:
                expected["api-capture.json"] = api_raw
            entry = next((item for item in catalog if item["id"] == dataset_id), None)
            if entry:
                rag.require(
                    (destination / "fixture.json").read_bytes() == encode(fixture),
                    "Registered fixture differs",
                )
                if any(item["id"] == capture_id for item in entry["captures"]):
                    rag.require(
                        entry.get("replay_only") is True,
                        "Core capture must remain replay-only",
                    )
                    rag.require(
                        all(
                            (run_dir / name).read_bytes() == raw
                            for name, raw in expected.items()
                        ),
                        "Registered source or derived capture changed",
                    )
                    return receipt_path
            created_dataset = not destination.exists()
            run_dir.mkdir(parents=True, exist_ok=False)
            try:
                for name, raw in expected.items():
                    (run_dir / name).write_bytes(raw)
                if created_dataset:
                    (destination / "fixture.json").write_bytes(encode(fixture))
                rag.require(
                    (destination / "fixture.json").read_bytes() == encode(fixture),
                    "Existing fixture differs",
                )
                report = rag.evaluate(
                    destination / "fixture.json", run_dir / "capture.json"
                )
                (run_dir / "report.json").write_bytes(encode(report))
                if entry is None:
                    entry = {
                        "id": dataset_id,
                        "label": "Core HTTP · 공식 공고 H01~H06 · 저장 기록 · 원문당 1청크",
                        "evaluation_scope": rag.SCOPE,
                        "replay_only": True,
                        "fixture": (relative / "fixture.json").as_posix(),
                        "fixture_sha256": capture["fixtureSha256"],
                        "case_ids": [case["id"] for case in fixture["cases"]],
                        "captures": [],
                    }
                    catalog.append(entry)
                label = (
                    "Core HTTP 무료 대역 · 실제 모델 품질 아님"
                    if api_raw is None
                    else f"Core HTTP 저장 응답 · {capture['execution']['model']} · {provenance['recordedStartedAt'][:10]} · 새 호출 없음"
                )
                entry["captures"].append(
                    {
                        "id": capture_id,
                        "label": label,
                        "path": (relative / capture_id / "capture.json").as_posix(),
                    }
                )
                paths["catalog"].write_bytes(encode(catalog))
                paths["release"].write_bytes(encode(build_release(repository)))
            except BaseException:
                for key, raw in originals.items():
                    paths[key].write_bytes(raw)
                shutil.rmtree(destination if created_dataset else run_dir)
                raise
            return receipt_path
        finally:
            lock.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core-capture", type=Path, required=True)
    parser.add_argument(
        "--api-capture",
        type=Path,
        help="실제 모델 실행의 API 기록. 무료 HTTP 대역에는 지정하지 않음",
    )
    parser.add_argument(
        "--register",
        action="store_true",
        help="검증 후 저장소의 Ops 재평가 목록에 등록",
    )
    args = parser.parse_args()
    if args.register:
        print(register(args.core_capture, args.api_capture))
    else:
        _, _, provenance = convert(
            args.core_capture.read_bytes(),
            None if args.api_capture is None else args.api_capture.read_bytes(),
        )
        print(encode(provenance).decode())


if __name__ == "__main__":
    main()
