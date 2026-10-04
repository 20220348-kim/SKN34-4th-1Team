"""검증된 과거 공식 HTML 실행의 답변 부분을 고정 근거 평가 자료로 옮긴다."""

import argparse
from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from verify_flow import DEFAULT_FIXTURE, document_content, expected_chunk, verify

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "runs/official-answer-20260907-v2"
SOURCE = HERE / "runs/official-flow-20260907-v2"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def digest(value):
    return sha256(value).hexdigest()


def validate_fixture(fixture):
    """원문 조각과 추출된 근거의 관계를 재검사한다. 출처의 진위를 인증하지는 않는다."""
    require(fixture.get("dataType") == "official-html-snapshot", "official source type required")
    require(fixture.get("referenceSource") == "ai-authored", "unreviewed AI reference required")
    documents = fixture.get("documents")
    require(isinstance(documents, list) and 1 <= len(documents) <= 3, "invalid official documents")
    for doc in documents:
        require(isinstance(doc, dict) and isinstance(doc.get("title"), str), "official document required")
        source = doc.get("source")
        require(isinstance(source, dict), "official provenance required")
        require(source.get("sourceCode") == "BIZINFO", "unsupported official source")
        program = source.get("sourceProgramId")
        require(isinstance(program, str) and re.fullmatch(r"PBLN_[0-9]+", program), "invalid source id")
        require(doc.get("id") == f"BIZINFO:{program}", "official identity differs")
        url = urlsplit(source.get("sourceUrl", ""))
        require(url.scheme == "https" and url.netloc == "www.bizinfo.go.kr"
                and url.path == "/sii/siia/selectSIIA200Detail.do"
                and url.query == f"pblancId={program}" and not url.fragment, "official URL differs")
        collected = source.get("collectedAt")
        require(isinstance(collected, str) and datetime.fromisoformat(collected.replace("Z", "+00:00")).tzinfo is not None,
                "collection time with timezone required")
        require(source.get("scope") == "frozen-title-and-body-html-no-attachments", "unsupported source scope")
        html = source.get("html")
        require(isinstance(html, str) and digest(html.encode()) == source.get("htmlSha256"), "HTML hash differs")
        content = document_content({**source, "title": doc["title"]}, html)
        require(content == source.get("content") and digest(content.encode()) == source.get("contentSha256"),
                "source content differs")
        chunk = expected_chunk({**source, "title": doc["title"]}, content)
        require(doc.get("chunks") == [{key: chunk[key] for key in ("id", "order", "text")}],
                "fixed official chunk differs")


def validate_projection(fixture, capture):
    require(fixture.get("schemaVersion") == "support-program-evidence-eval-v2", "projection requires official fixture")
    require(capture.get("measurementKind") == "historical-answer-projection", "historical projection label required")
    provenance = capture.get("provenance")
    require(isinstance(provenance, dict) and provenance.get("scope") == "answers-only-from-frozen-official-flow",
            "projection provenance required")
    for key in ("coreCaptureSha256", "apiCaptureSha256", "sourceFixtureSha256", "sourceRecorderSha256"):
        require(isinstance(provenance.get(key), str) and re.fullmatch(r"[a-f0-9]{64}", provenance[key]),
                "projection source hashes required")
    require(capture.get("modelApiCalls") == 0 and type(capture.get("modelApiCalls")) is int,
            "projection cannot claim new calls")


def build():
    """저장 자료만 검증·변환한다. OpenAI·DB·승인 API는 호출하지 않는다."""
    # The original capture is verified before any derived fixture/answer is emitted.
    core_raw = (SOURCE / "core/capture.json").read_bytes()
    api_raw = (SOURCE / "api/api-capture.json").read_bytes()
    core, api = json.loads(core_raw), json.loads(api_raw)
    verify(core, api, DEFAULT_FIXTURE)
    original = json.loads(DEFAULT_FIXTURE.read_bytes())
    documents, cases = [], []
    for doc in original["documents"]:
        html = (DEFAULT_FIXTURE.parent / doc["htmlFile"]).read_text(encoding="utf-8")
        content = document_content(doc, html)
        chunk = expected_chunk(doc, content)
        documents.append({
            "id": chunk["documentId"], "title": doc["title"],
            "source": {**{key: doc[key] for key in ("sourceCode", "sourceProgramId", "sourceUrl", "htmlSha256")},
                       "collectedAt": original["sourceCollectedAt"],
                       "scope": "frozen-title-and-body-html-no-attachments", "html": html,
                       "content": content, "contentSha256": digest(content.encode())},
            "chunks": [{key: chunk[key] for key in ("id", "order", "text")}],
        })
        for case in doc["cases"]:
            cases.append({**{key: case[key] for key in ("id", "question", "expectedStatus", "referenceFacts", "forbiddenClaims")},
                          "category": "official-html-reference-review", "documentId": chunk["documentId"],
                          "expectedCitationOrders": [0] if case["expectedStatus"] == "ANSWERED" else []})
    fixture = {"schemaVersion": "support-program-evidence-eval-v2", "scope": "fixed-answer-context-only",
               "dataType": "official-html-snapshot", "referenceSource": "ai-authored",
               "documents": documents, "cases": cases}
    validate_fixture(fixture)
    # Preserve original request IDs/text and responses. Never replace them with synthetic IDs.
    from evaluate import SupportProgramEvidenceAnswerRequest, request_digest
    answer_calls = [call for call in api["calls"] if call["path"] == "/v1/responses"]
    capture = {
        "schemaVersion": "support-program-evidence-capture-v2", "scope": "fixed-answer-context-only",
        "measurementKind": "historical-answer-projection", "fixtureSha256": digest(encoded(fixture)),
        "model": api["model"], "promptSha256": api["promptSha256"], "runnerSha256": digest(Path(__file__).read_bytes()),
        "modelTimeoutSeconds": None, "runTimeoutSeconds": None, "modelApiCalls": 0,
        "startedAt": core["startedAt"], "completed": True, "caseIds": [case["id"] for case in cases],
        "provenance": {"scope": "answers-only-from-frozen-official-flow", "coreCaptureSha256": digest(core_raw),
                       "apiCaptureSha256": digest(api_raw), "sourceFixtureSha256": digest(DEFAULT_FIXTURE.read_bytes()),
                       "sourceRecorderSha256": api["recorderSha256"]},
        "apiResponses": [call["response"] for call in answer_calls],
        "cases": [{"caseId": item["id"], "requestSha256": request_digest(
            SupportProgramEvidenceAnswerRequest.model_validate(item["aiCalls"][-1]["request"])),
                   "outcome": "success", "response": item["aiCalls"][-1]["response"],
                   "apiResponseIndexes": [index], "elapsedMs": None}
                  for index, item in enumerate(core["cases"])],
    }
    validate_projection(fixture, capture)
    return fixture, capture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="검증한 파생 자료를 저장소의 고정 경로에 작성")
    args = parser.parse_args()
    fixture, capture = build()
    expected = {"fixture.json": encoded(fixture), "capture.json": encoded(capture)}
    if args.write:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        for name, raw in expected.items():
            (OUTPUT / name).write_bytes(raw)
    else:
        for name, raw in expected.items():
            require((OUTPUT / name).read_bytes() == raw, "registered official projection differs")
    from evaluate import load_fixture, report
    report_raw = encoded(report(*load_fixture(OUTPUT / "fixture.json"), capture))
    if args.write:
        (OUTPUT / "report.json").write_bytes(report_raw)
    else:
        require((OUTPUT / "report.json").read_bytes() == report_raw, "registered report differs")
    print("Official answer snapshot: verified 2 documents / 6 cases; new model calls 0")


if __name__ == "__main__":
    main()
