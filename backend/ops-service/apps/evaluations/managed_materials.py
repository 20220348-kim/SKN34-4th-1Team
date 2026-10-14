"""관리자가 입력한 고정 근거·답변을 검증하고 불변 평가 입력으로 변환한다."""

import json
import re
from hashlib import sha256
from pathlib import Path
from unicodedata import category
from urllib.parse import urlsplit

MAX_CONTENT_BYTES = 512 * 1024
MANAGED_ID = re.compile(r"managed-[a-f0-9]{32}-v[1-9][0-9]{0,8}\Z")
STATUSES = {"ANSWERED", "INSUFFICIENT_EVIDENCE"}


def encoded(value):
    # MySQL JSON이 객체 키 순서를 바꿔도 원문/응답의 해시는 동일해야 한다.
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _object(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(f"{label}의 항목을 확인하세요.")


def _text(value, limit, label, *, required=True):
    if (
        not isinstance(value, str)
        or len(value) > limit
        or any(category(char).startswith("C") and char not in "\n\r\t" for char in value)
        or (required and not value.strip())
    ):
        raise ValueError(f"{label}: 읽을 수 있는 내용을 {limit:,}자 이내로 입력하세요.")
    return value.strip()


def _identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", value):
        raise ValueError(f"{label} 식별자가 올바르지 않습니다.")
    return value


def _list(value, limit, label, *, required=True):
    if not isinstance(value, list) or len(value) > limit or (required and not value):
        raise ValueError(f"{label}: {1 if required else 0}~{limit}개를 입력하세요.")
    return value


def _orders(value, count, status, label, publish):
    value = _list(value, 5, label, required=False)
    if (
        any(type(order) is not int or order < 0 or order >= count for order in value)
        or len(set(value)) != len(value)
        or (publish and bool(value) != (status == "ANSWERED"))
    ):
        raise ValueError(
            f"{label}: 답변 가능에는 인용이 필요하고 근거 부족에는 인용을 비워야 합니다."
        )
    return sorted(value)


def validate_content(content, *, publish=False):
    """초안도 구조·크기를 검증하고, 게시 때는 모든 질문과 저장 답변을 요구한다."""
    _object(content, ("title", "description", "documents", "cases"), "평가 자료")
    if len(encoded(content)) > MAX_CONTENT_BYTES:
        raise ValueError("평가 자료 전체 크기는 512 KiB 이하여야 합니다.")
    result = {
        "title": _text(content["title"], 150, "자료 이름"),
        "description": _text(content["description"], 2000, "자료 설명", required=False),
        "documents": [],
        "cases": [],
    }
    documents = {}
    for item in _list(content["documents"], 3, "공고 원문", required=publish):
        _object(item, ("id", "title", "source_url", "chunks"), "공고 원문")
        identifier = _identifier(item["id"], "공고")
        if identifier in documents:
            raise ValueError("공고 식별자는 중복할 수 없습니다.")
        url = _text(item["source_url"], 2000, "출처 URL", required=False)
        if url:
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or any(char.isspace() for char in url)
            ):
                raise ValueError("출처 URL에는 인증정보 없는 http 또는 https 주소를 입력하세요.")
        document = {
            "id": identifier,
            "title": _text(item["title"], 300, "공고 제목", required=publish),
            "source_url": url,
            "chunks": [
                _text(text, 12000, "근거 문단", required=publish)
                for text in _list(item["chunks"], 5, "근거 문단", required=publish)
            ],
        }
        documents[identifier] = document
        result["documents"].append(document)
    seen = set()
    for item in _list(content["cases"], 12, "질문", required=publish):
        _object(
            item,
            (
                "id",
                "document_id",
                "question",
                "expected_status",
                "expected_citation_orders",
                "reference_facts",
                "forbidden_claims",
                "answer",
            ),
            "질문",
        )
        identifier = _identifier(item["id"], "질문")
        if identifier in seen:
            raise ValueError("질문 식별자는 중복할 수 없습니다.")
        seen.add(identifier)
        if not isinstance(item["document_id"], str) or item["document_id"] not in documents:
            raise ValueError(f"{identifier}: 사용할 공고 원문을 선택하세요.")
        if not isinstance(item["expected_status"], str) or item["expected_status"] not in STATUSES:
            raise ValueError(f"{identifier}: 예상 답변 상태를 확인하세요.")
        count = len(documents[item["document_id"]]["chunks"])
        case = {
            "id": identifier,
            "document_id": item["document_id"],
            "question": _text(item["question"], 500, f"{identifier} 질문", required=publish),
            "expected_status": item["expected_status"],
            "expected_citation_orders": _orders(
                item["expected_citation_orders"],
                count,
                item["expected_status"],
                f"{identifier} 예상 인용",
                publish,
            ),
            "reference_facts": [],
            "forbidden_claims": [],
            "answer": None,
        }
        for field, label in (
            ("reference_facts", "포함할 사실"),
            ("forbidden_claims", "금지할 주장"),
        ):
            case[field] = [
                _text(text, 1200, f"{identifier} {label}", required=publish)
                for text in _list(item[field], 30, f"{identifier} {label}", required=publish)
            ]
        answer = item["answer"]
        if answer is not None:
            _object(answer, ("text", "status", "citation_orders"), "저장 답변")
            if not isinstance(answer["status"], str) or answer["status"] not in STATUSES:
                raise ValueError(f"{identifier}: 저장 답변 상태를 확인하세요.")
            case["answer"] = {
                "text": _text(answer["text"], 1200, f"{identifier} 저장 답변", required=publish),
                "status": answer["status"],
                "citation_orders": _orders(
                    answer["citation_orders"],
                    count,
                    answer["status"],
                    f"{identifier} 답변 인용",
                    publish,
                ),
            }
        elif publish:
            raise ValueError(f"{identifier}: 평가 목록에 게시하려면 비교용 저장 답변을 입력하세요.")
        result["cases"].append(case)
    return result


def build_snapshot(content, dataset_id):
    if not isinstance(dataset_id, str) or not MANAGED_ID.fullmatch(dataset_id):
        raise ValueError("관리 자료 버전 식별자가 올바르지 않습니다.")
    content = validate_content(content, publish=True)
    documents = []
    for doc in content["documents"]:
        doc_id = f"ADMIN:{doc['id']}"
        documents.append(
            {
                "id": doc_id,
                "title": doc["title"],
                "source": {"sourceUrl": doc["source_url"]},
                "chunks": [
                    {
                        "id": sha256(
                            f"evidence-eval-v1\0{doc_id}\0{order}\0{text}".encode()
                        ).hexdigest(),
                        "order": order,
                        "text": text,
                    }
                    for order, text in enumerate(doc["chunks"])
                ],
            }
        )
    fixture = {
        "schemaVersion": "support-program-evidence-eval-v3",
        "scope": "fixed-answer-context-only",
        "dataType": "admin-provided",
        "referenceSource": "admin-authored",
        "documents": documents,
        "cases": [
            {
                "id": case["id"],
                "documentId": f"ADMIN:{case['document_id']}",
                "category": "administrator-material",
                "question": case["question"],
                "expectedStatus": case["expected_status"],
                "expectedCitationOrders": case["expected_citation_orders"],
                "referenceFacts": case["reference_facts"],
                "forbiddenClaims": case["forbidden_claims"],
            }
            for case in content["cases"]
        ],
    }
    fixture_hash = sha256(encoded(fixture)).hexdigest()
    cases = []
    by_id = {doc["id"]: doc for doc in documents}
    for item in content["cases"]:
        doc_id = f"ADMIN:{item['document_id']}"
        chunks = by_id[doc_id]["chunks"]
        request = {
            "question": item["question"],
            "chunks": [
                {
                    "id": chunk["id"],
                    "documentId": doc_id,
                    "order": chunk["order"],
                    "text": chunk["text"],
                }
                for chunk in chunks
            ],
        }
        answer = item["answer"]
        cases.append(
            {
                "caseId": item["id"],
                "requestSha256": sha256(
                    json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
                ).hexdigest(),
                "outcome": "success",
                "elapsedMs": None,
                "response": {
                    "answer": answer["text"],
                    "answerStatus": answer["status"],
                    "citationChunkIds": [chunks[n]["id"] for n in answer["citation_orders"]],
                },
            }
        )
    capture = {
        "schemaVersion": "support-program-evidence-capture-v3",
        "scope": "fixed-answer-context-only",
        "measurementKind": "admin-entered-answer",
        "fixtureSha256": fixture_hash,
        "model": "not-recorded",
        "promptSha256": None,
        "runnerSha256": None,
        "modelTimeoutSeconds": None,
        "runTimeoutSeconds": None,
        "modelApiCalls": 0,
        "completed": True,
        "caseIds": [item["id"] for item in content["cases"]],
        "cases": cases,
    }
    catalog = {
        "id": dataset_id,
        "label": content["title"],
        "fixture": f"managed/{dataset_id}/fixture.json",
        "fixture_sha256": fixture_hash,
        "case_ids": capture["caseIds"],
        "selection_guide": {
            "category": "quality",
            "title": content["title"],
            "purpose": content["description"] or "관리자가 입력한 고정 근거로 답변을 평가합니다.",
            "material": "관리자 입력 원문·질문·채점 조건과 비교용 저장 답변입니다.",
            "limitations": (
                "출처 URL을 자동 수집하지 않습니다. 등록 자체는 사람 검토 승인이나 "
                "실제 모델 실행 기록이 아닙니다. 검색 품질은 평가하지 않습니다."
            ),
        },
        "captures": [
            {
                "id": "manual",
                "label": "관리자 입력 답변 · 모델 호출 기록 아님",
                "path": f"managed/{dataset_id}/capture.json",
            }
        ],
    }
    return {"catalog": catalog, "fixture": fixture, "capture": capture}


def validate_snapshot(snapshot):
    """접수와 실행 양쪽에서 같은 변환으로 재구성하여 임의 경로·위조 출처를 거절한다."""
    try:
        _object(snapshot, ("catalog", "fixture", "capture"), "자료 스냅샷")
        catalog, fixture, capture = (snapshot[key] for key in ("catalog", "fixture", "capture"))
        responses = {case["caseId"]: case["response"] for case in capture["cases"]}
        documents = fixture["documents"]
        by_id = {doc["id"]: doc for doc in documents}
        cases = []
        for case in fixture["cases"]:
            doc = by_id[case["documentId"]]
            orders = {chunk["id"]: chunk["order"] for chunk in doc["chunks"]}
            response = responses[case["id"]]
            cases.append(
                {
                    "id": case["id"],
                    "document_id": case["documentId"].removeprefix("ADMIN:"),
                    "question": case["question"],
                    "expected_status": case["expectedStatus"],
                    "expected_citation_orders": case["expectedCitationOrders"],
                    "reference_facts": case["referenceFacts"],
                    "forbidden_claims": case["forbiddenClaims"],
                    "answer": {
                        "text": response["answer"],
                        "status": response["answerStatus"],
                        "citation_orders": [
                            orders[value] for value in response["citationChunkIds"]
                        ],
                    },
                }
            )
        content = {
            "title": catalog["label"],
            "description": catalog["selection_guide"]["purpose"],
            "documents": [
                {
                    "id": doc["id"].removeprefix("ADMIN:"),
                    "title": doc["title"],
                    "source_url": doc["source"]["sourceUrl"],
                    "chunks": [chunk["text"] for chunk in doc["chunks"]],
                }
                for doc in documents
            ],
            "cases": cases,
        }
        if build_snapshot(content, catalog["id"]) != snapshot:
            raise ValueError("관리 자료 스냅샷의 내용 또는 해시가 일치하지 않습니다.")
    except (KeyError, TypeError, AttributeError, RecursionError) as exc:
        raise ValueError("관리 자료 스냅샷을 확인할 수 없습니다.") from exc
    return snapshot


def release_dataset(snapshot):
    snapshot = validate_snapshot(snapshot)
    return {
        "fixture_sha256": snapshot["catalog"]["fixture_sha256"],
        "case_ids": snapshot["catalog"]["case_ids"],
        "captures": {"manual": sha256(encoded(snapshot["capture"])).hexdigest()},
        "managed_snapshot": snapshot,
    }


def materialize(snapshot, output_dir):
    snapshot = validate_snapshot(snapshot)
    root = Path(output_dir)
    for field, name in (("fixture", "fixture.json"), ("capture", "capture.json")):
        path = root / "managed" / snapshot["catalog"]["id"] / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded(snapshot[field]))
    return root
