"""검증된 공식 HTML을 문단 청크 RAG 자료로 준비한다. 모델·DB·네트워크 호출 없음."""

import argparse
import json
from pathlib import Path

import official_snapshot
import rag_evaluate as rag

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "runs/official-answer-20260907-v3/fixture.json"
OUTPUT = HERE / "runs/official-rag-20261006-v1"
DATASET = "official-rag-20261006-v1"
GROUPED_DATASET = "official-rag-20261006-v2"
GROUPED_OUTPUT = HERE / "runs" / GROUPED_DATASET
# 새 청크의 검색 참조는 AI 초안이다. 기존 답변 검토 승인을 승계하지 않는다.
QUOTES = {
    "H01": [
        "☞ 자체역량으로 스마트공장 구축한 기업(정부 스마트공장지원사업 미참여)",
        "- 자발적으로 고도화를 추진하여 스마트화 수준상승이 기대되는 기업",
        "- 스마트공장 수준확인서의 유효기간 만료기업",
        "☞ 중소ㆍ중견 제조기업의 자발적인 스마트공장 구축 및 고도화를 유도하기 위해 스마트화 수준진단을 지원",
    ],
    "H04": [
        "☞ 강원 글로벌 IP 스타기업",
        "☞ 해외 특허ㆍ디자인ㆍ상표 출원 중인 건이 글로벌 IP 스타기업 지위에서 중간사건(OA)인 경우 일부 소요 비용 지원",
    ],
}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def paragraphs(content, *, grouped_lists=False):
    """연속된 목록은 원문 순서대로 묶는다. 질문·참조 정답은 분할에 사용하지 않는다."""
    chunks = []
    previous_is_list = False
    for paragraph in content.split("\n\n"):
        paragraph = paragraph.strip()
        rag.require(bool(paragraph), "empty source paragraph")
        is_list = paragraph.startswith(("☞", "- "))
        if grouped_lists and is_list and previous_is_list:
            chunks[-1] += "\n\n" + paragraph
        else:
            chunks.append(paragraph)
        previous_is_list = is_list
    return chunks


def build(*, grouped_lists=False):
    original, _ = rag.read_json(SOURCE)
    official_snapshot.validate_fixture(original)
    documents = []
    for doc in original["documents"]:
        source = doc["source"]
        chunks = []
        for order, paragraph in enumerate(paragraphs(source["content"], grouped_lists=grouped_lists)):
            chunks.append({
                "id": rag.digest(f"{doc['id']}\0{source['contentSha256']}\0{order}"),
                "documentId": doc["id"], "order": order, "text": paragraph,
                "contentHash": rag.digest(paragraph),
            })
        documents.append({
            "documentId": doc["id"], "sourceUrl": source["sourceUrl"],
            "content": source["content"], "contentHash": source["contentSha256"],
            "chunkVersion": (
                "evaluation-list-preserving-v2-not-core-chunker"
                if grouped_lists else "evaluation-paragraph-split-v1-not-core-chunker"
            ),
            "chunks": chunks,
            "source": {key: source[key] for key in (
                "sourceCode", "sourceProgramId", "collectedAt", "htmlSha256", "scope"
            )},
        })
    by_id = {doc["documentId"]: doc for doc in documents}
    cases = []
    for case in original["cases"]:
        by_chunk = {}
        for quote in QUOTES.get(case["id"], []):
            matches = [c for c in by_id[case["documentId"]]["chunks"] if quote in c["text"]]
            rag.require(len(matches) == 1, "reference quote must match exactly one chunk")
            chunk = matches[0]
            by_chunk.setdefault(chunk["id"], {"text": chunk["text"], "quotes": []})["quotes"].append(quote)
        evidence = []
        for chunk_id, item in by_chunk.items():
            # 같은 청크에 합쳐진 참조 사실을 모두 포함하는 원문의 연속 구간을 보존한다.
            start = min(item["text"].index(quote) for quote in item["quotes"])
            end = max(item["text"].index(quote) + len(quote) for quote in item["quotes"])
            evidence.append({"chunkId": chunk_id, "quote": item["text"][start:end]})
        cases.append({
            **{key: case[key] for key in ("id", "documentId", "question", "expectedStatus")},
            "expectedEvidence": evidence,
        })
    fixture = {
        "schemaVersion": "support-program-rag-fixture-v2", "scope": rag.SCOPE,
        "datasetVersion": GROUPED_DATASET if grouped_lists else DATASET,
        "dataType": "official-html-snapshot",
        "referenceSource": "ai-authored-not-human-reviewed", "documents": documents, "cases": cases,
    }
    rag.validate_fixture(fixture)
    # 첫 실행 비교용 빈 기록이다. 과거 답변을 검색 실행 결과로 바꾸지 않는다.
    pending = {
        "schemaVersion": "support-program-rag-capture-v1", "scope": rag.SCOPE,
        "fixtureSha256": rag.digest(encoded(fixture)),
        "execution": {"kind": "synthetic", "model": None, "embeddingModel": None,
                      "promptSha256": None, "recorderSha256": None},
        "cases": [{
            "caseId": case["id"], "traceId": None, "sourceContentHash": None,
            "chunksSha256": None, "indexedCount": None, "search": None, "answer": None,
            "failure": {"stage": "not_started", "code": "NOT_STARTED"},
        } for case in cases],
    }
    return fixture, pending


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--grouped-lists", action="store_true", help="연속 목록을 보존하는 별도 v2 자료")
    args = parser.parse_args()
    fixture, pending = build(grouped_lists=args.grouped_lists)
    output = GROUPED_OUTPUT if args.grouped_lists else OUTPUT
    for name, value in (("fixture.json", fixture), ("not-started.json", pending)):
        path = output / name
        if args.write:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(encoded(value))
        else:
            rag.require(path.read_bytes() == encoded(value), "official RAG preparation is stale")
    print("공식 공고 2개 · 질문 6개 · RAG 준비 자료 검증 완료 · 모델 호출 0회")


if __name__ == "__main__":
    main()
