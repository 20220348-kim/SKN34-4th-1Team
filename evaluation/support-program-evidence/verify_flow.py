#!/usr/bin/env python3
"""고정 실제 HTML 전체 흐름 캡처를 API 호출·파일 쓰기 없이 재검증한다."""

import argparse
from hashlib import sha256
from html import unescape
from html.parser import HTMLParser
import json
from math import isfinite
from pathlib import Path
import re
import sys
import unicodedata


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_FIXTURE = ROOT / "backend/core-service/src/test/resources/support-program-evidence/official-sources.json"
HASH = re.compile(r"[0-9a-f]{64}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON object key")
        result[key] = value
    return result


def _json(value):
    def invalid_number(_):
        raise ValueError("non-finite JSON number")
    return json.loads(value, object_pairs_hook=_unique_object, parse_constant=invalid_number)


class _OfficialFragmentText(HTMLParser):
    """독립적으로 고정 fixture의 view_cont 가시 문구를 복원한다. 범용 HTML 수집기가 아니다."""

    BLOCKS = set("p div section article h1 h2 h3 h4 h5 h6 li tr td th br dt dd table ul ol".split())
    REMOVED = set("script style noscript header nav footer svg iframe button input select textarea".split())
    VOID = set("area base br col embed hr img input link meta param source track wbr".split())

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.view = self.title = self.hidden = False
        self.body_parts, self.title_parts = [], []

    def handle_starttag(self, tag, attrs):
        previous = (tag, self.view, self.title, self.hidden)
        values = dict(attrs)
        classes = (values.get("class") or "").split()
        self.view = self.view or "view_cont" in classes
        self.title = self.title or "title" in classes
        self.hidden = self.hidden or tag in self.REMOVED or "hidden" in values
        if self.view and not self.hidden and tag in self.BLOCKS:
            self.body_parts.append("\n")
        if tag in self.VOID:
            if self.view and not self.hidden and tag in self.BLOCKS:
                self.body_parts.append("\n")
            _, self.view, self.title, self.hidden = previous
        else:
            self.stack.append(previous)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.view and not self.hidden and tag in self.BLOCKS:
            self.body_parts.append("\n")
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                _, self.view, self.title, self.hidden = self.stack[index]
                del self.stack[index:]
                return

    def handle_data(self, data):
        if not self.hidden:
            if self.view:
                self.body_parts.append(data)
            if self.title:
                self.title_parts.append(data)


def _readable(value):
    value = "".join(char for char in value if char in "\n\r\t" or not unicodedata.category(char).startswith("C"))
    value = re.sub(r"[\t \x0b\f\r]+", " ", value.replace("\xa0", " "))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(line.strip() for line in value.split("\n"))).strip()


def document_content(metadata, html):
    parser = _OfficialFragmentText()
    parser.feed(html)
    title = re.sub(r"\s+", " ", unescape(unicodedata.normalize("NFKC", "".join(parser.title_parts)))).strip()
    require(title == metadata["title"], "official HTML title does not match fixture")
    body = _readable("".join(parser.body_parts))
    require(80 <= len(body.encode("utf-16-le")) // 2 <= 30000, "unsupported official HTML body")
    return f"공고명: {title}\n공식 원문: {metadata['sourceUrl']}\n\n{body}"


def expected_chunk(metadata, content):
    # Both version-1 official fixtures fit one production chunk. Do not silently claim multi-chunk coverage.
    text = "\n\n".join(line.strip() for line in content.splitlines() if line.strip())
    require(len(text.encode("utf-16-le")) // 2 <= 1500, "this fixed-flow verifier supports single-chunk documents only")
    document_id = f"{metadata['sourceCode']}:{metadata['sourceProgramId']}"
    return {"id": digest(f"{document_id}\0{digest(content)}\0{0}"), "contentHash": digest(text),
            "documentId": document_id, "order": 0, "text": text}


def _answer_contract(answer, chunks):
    require(isinstance(answer, dict) and set(answer) == {"answer", "answerStatus", "citationChunkIds"}, "invalid AI answer fields")
    require(isinstance(answer["answer"], str) and answer["answer"] == answer["answer"].strip()
            and 1 <= len(answer["answer"]) <= 1200, "invalid AI answer text")
    status, ids = answer["answerStatus"], answer["citationChunkIds"]
    require(status in ("ANSWERED", "INSUFFICIENT_EVIDENCE") and isinstance(ids, list)
            and all(isinstance(value, str) for value in ids), "invalid answer status or citation IDs")
    require(len(ids) == len(set(ids)) and set(ids) <= {chunk["id"] for chunk in chunks}, "unknown or duplicate citation")
    require(bool(ids) == (status == "ANSWERED"), "answer status and citations disagree")


def _usage_sum(calls, field, names):
    totals = {name: 0 for name in names}
    for call in calls:
        values = call["response"].get(field)
        for name in names:
            value = values.get(name) if isinstance(values, dict) else None
            require(value is None or (type(value) is int and value >= 0), "invalid token usage")
            totals[name] = None if value is None or totals[name] is None else totals[name] + value
        if isinstance(values, dict) and all(values.get(name) is not None for name in names):
            expected = values[names[0]] if len(names) == 2 else values[names[0]] + values[names[1]]
            require(values[names[-1]] == expected, "token usage total does not match components")
    return totals


def verify(core, api, fixture_path=DEFAULT_FIXTURE):
    fixture_path = Path(fixture_path)
    fixture_bytes = fixture_path.read_bytes()
    fixture = _json(fixture_bytes)
    require(core.get("schemaVersion") == "official-evidence-flow-capture-v1", "unsupported Core capture")
    require(core.get("scope") == "core-http-mysql-frozen-html-ai-evidence-flow"
            and core.get("aiTransport") == "explicit-local-ai-http"
            and core.get("officialSourceTransport") == "frozen-official-html-fragments", "capture is not a recorded local-AI flow")
    require(core.get("fixtureSha256") == digest(fixture_bytes) and core.get("fixture") == fixture, "fixture hash or captured fixture mismatch")
    require(fixture.get("schemaVersion") == "official-evidence-flow-fixture-v1", "unsupported fixture")
    require(core.get("completed") is True and "failureType" not in core, "Core flow is incomplete; no full-flow accuracy is published")
    references = [(doc, case) for doc in fixture["documents"] for case in doc["cases"]]
    require(len(fixture["documents"]) == 2 and len(references) == 6, "version-1 fixture must contain two documents and six questions")
    require(type(core.get("expectedCaseCount")) is int and core["expectedCaseCount"] == 6
            and len(core.get("cases", [])) == 6, "missing or extra Core observations")

    expected_documents = {}
    for doc in fixture["documents"]:
        path = (fixture_path.parent / doc["htmlFile"]).resolve()
        require(path.parent == fixture_path.parent.resolve() and path.suffix == ".html", "HTML fixture path escapes its directory")
        html = path.read_bytes()
        require(digest(html) == doc["htmlSha256"], "official HTML fixture hash mismatch")
        text = document_content(doc, html.decode("utf-8"))
        expected_documents[doc["sourceProgramId"]] = (text, expected_chunk(doc, text))

    expected_api, answers, rows, cached = [], [], [], {}
    for observation, (doc, case) in zip(core["cases"], references, strict=True):
        require(observation.get("id") == case["id"] and observation.get("expectedStatus") == case["expectedStatus"], "case order or expectation mismatch")
        require(observation.get("publicStatus") == 200 and "failureType" not in observation, "failed Core observation")
        require(observation.get("publicRequest") == {"sourceCode": doc["sourceCode"], "sourceProgramId": doc["sourceProgramId"],
                                                   "question": case["question"]}, "public request mismatch")
        stored = observation["sourceDocument"]
        text, chunk = expected_documents[doc["sourceProgramId"]]
        require(all(stored.get(key) == doc[key] for key in ("sourceCode", "sourceProgramId", "sourceUrl")), "source identity mismatch")
        require(stored.get("content") == text and stored.get("contentHash") == digest(text), "stored document differs from the fixed official HTML")
        doc_id = chunk["documentId"]
        if doc_id in cached:
            require(cached[doc_id] == stored, "cached document changed between fixed questions")
        else:
            cached[doc_id] = stored
            expected_api.append(("/v1/embeddings", "document", None))
        expected_api.extend([("/v1/embeddings", "question", None), ("/v1/responses", "answer", len(answers))])

        calls = observation.get("aiCalls", [])
        require(len(calls) == 3 and [(call.get("operation"), call.get("method")) for call in calls]
                == [("chunks", "PUT"), ("search", "POST"), ("answers", "POST")], "wrong internal AI operation sequence")
        require(all(call.get("status") == 200 and "failureType" not in call for call in calls), "failed internal AI operation")
        index, search, answer = calls
        require(index["request"] == {"chunks": [chunk]} and type(index["request"]["chunks"][0]["order"]) is int
                and index["response"] == {"indexedCount": 1} and type(index["response"]["indexedCount"]) is int, "index text, identity, hash or acknowledgement mismatch")
        reference = {key: value for key, value in chunk.items() if key != "text"}
        require(search["request"] == {"question": case["question"], "eligibleChunks": [reference], "limit": 1}, "search eligibility or question mismatch")
        matches = search["response"]["matches"]
        require(search["response"]["question"] == case["question"] and len(matches) == 1, "incomplete or mismatched search")
        match = matches[0]
        score = match.get("score")
        require({key: value for key, value in match.items() if key != "score"} == reference
                and type(match.get("order")) is int and type(score) in (int, float) and isfinite(score), "foreign or invalid search match")
        answer_chunk = {key: value for key, value in chunk.items() if key != "contentHash"}
        require(answer["request"] == {"question": case["question"], "chunks": [answer_chunk]}, "answer did not use exactly the retrieved original text")
        result = answer["response"]
        _answer_contract(result, [chunk])
        citations = [{"excerpt": chunk["text"], "sourceUrl": doc["sourceUrl"], "chunkOrder": 0} for _ in result["citationChunkIds"]]
        require(observation["publicResponse"] == {"answer": result["answer"], "answerStatus": result["answerStatus"], "citations": citations}, "public answer or original citation differs from the validated AI response")
        require(all(type(value["chunkOrder"]) is int for value in observation["publicResponse"]["citations"]), "invalid public chunk order")
        answers.append(result)
        rows.append({"id": case["id"], "expectedStatus": case["expectedStatus"], "actualStatus": result["answerStatus"],
                     "statusMatches": result["answerStatus"] == case["expectedStatus"],
                     "referenceEvidenceCited": any(case["evidenceText"] in value["excerpt"] for value in citations)
                     if case["expectedStatus"] == "ANSWERED" else None})

    require(api.get("schemaVersion") == "support-program-evidence-flow-api-v1", "unsupported official API capture")
    require(all(isinstance(api.get(key), str) and HASH.fullmatch(api[key]) for key in ("promptSha256", "recorderSha256")), "invalid execution source hash")
    require(isinstance(api.get("model"), str) and api["model"] and api.get("embeddingModel") == "text-embedding-3-small"
            and type(api.get("embeddingDimensions")) is int and api["embeddingDimensions"] == 1536, "invalid recorded model configuration")
    api_calls = api.get("calls", [])
    require(type(api.get("maxApiCalls")) is int and len(api_calls) <= api["maxApiCalls"] <= 20, "API budget exceeded")
    require(len(api_calls) == len(expected_api), "official API count does not match a fresh-collection six-question flow")
    for number, (call, (path, _, answer_index)) in enumerate(zip(api_calls, expected_api, strict=True)):
        require(type(call.get("index")) is int and call["index"] == number and call.get("path") == path, "official API call order or operation mismatch")
        require(isinstance(call.get("requestSha256"), str) and HASH.fullmatch(call["requestSha256"]), "invalid recorded API request fingerprint")
        require(type(call.get("elapsedMs")) in (int, float) and isfinite(call["elapsedMs"]) and call["elapsedMs"] >= 0, "invalid API latency")
        response = call["response"]
        require(isinstance(response, dict) and response.get("httpStatus") == 200, "failed or unfinished official API request")
        if answer_index is not None:
            require(response.get("responseStatus") == "completed" and response.get("incompleteReason") is None
                    and response.get("hasRefusal") is False and response.get("outputTextTruncated") is False
                    and len(response.get("outputTexts", [])) == 1, "incomplete or refused model output")
            selection = _json(response["outputTexts"][0])
            require(isinstance(selection, dict) and set(selection) == {"answer", "answerStatus", "citationChunkIndexes"}, "unexpected model output contract")
            indexes = selection["citationChunkIndexes"]
            require(isinstance(indexes, list) and all(type(value) is int and value == 0 for value in indexes)
                    and len(indexes) == len(set(indexes)), "invalid model citation selection")
            result = answers[answer_index]
            require(isinstance(selection["answer"], str) and selection["answer"].strip() == result["answer"]
                    and selection["answerStatus"] == result["answerStatus"] and len(indexes) == len(result["citationChunkIds"]), "model selection did not become the recorded Core answer")

    answer_calls = [call for call in api_calls if call["path"] == "/v1/responses"]
    embedding_calls = [call for call in api_calls if call["path"] == "/v1/embeddings"]
    answer_usage = _usage_sum(answer_calls, "usage", ("input_tokens", "output_tokens", "total_tokens"))
    embedding_usage = _usage_sum(embedding_calls, "embeddingUsage", ("prompt_tokens", "total_tokens"))
    totals = [answer_usage["total_tokens"], embedding_usage["total_tokens"]]
    reference_rows = [row for row in rows if row["referenceEvidenceCited"] is not None]
    return {"schemaVersion": "official-evidence-flow-verification-v1", "integrityVerified": True, "completed": True,
            "caseCount": len(rows), "documentCount": len(cached), "singleChunkDocumentsOnly": True,
            "statusAccuracy": sum(row["statusMatches"] for row in rows) / len(rows),
            "referenceEvidenceCoverage": sum(row["referenceEvidenceCited"] for row in reference_rows) / len(reference_rows),
            "citationIntegrityVerified": True, "semanticFaithfulness": None, "semanticReviewRequired": True,
            "referenceSource": "ai-authored-not-human-reviewed", "cases": rows,
            "officialApiCalls": {"total": len(api_calls), "documentEmbeddings": len(cached), "questionEmbeddings": len(rows), "answers": len(answer_calls)},
            "tokens": {"answers": answer_usage, "embeddings": embedding_usage,
                       "combinedTotal": sum(totals) if all(value is not None for value in totals) else None},
            "recordedModel": api["model"], "promptSha256": api["promptSha256"],
            "apiElapsedMsSum": round(sum(call["elapsedMs"] for call in api_calls), 3),
            "recorderMatchesCurrentCheckout": api["recorderSha256"] == digest((HERE / "serve_flow.py").read_bytes()),
            "apiRequestBodiesRecorded": False, "apiLinkage": "fresh-collection operation sequence and model-output mapping only",
            "limitations": ["Not an independent proof that API requests occurred; upstream request bodies and vectors are not recorded.",
                            "Valid IDs, original excerpts and expected statuses do not establish semantic faithfulness.",
                            "Two fixed single-chunk HTML fragments do not evaluate multi-chunk ranking or attachment contents.",
                            "Recorder read timeouts differ from production; API elapsed sum is not end-to-end latency."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    args = parser.parse_args(argv)
    try:
        result = verify(_json((args.run_dir / "core/capture.json").read_bytes()),
                        _json((args.run_dir / "api/api-capture.json").read_bytes()), args.fixture)
    except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
        print(f"Flow capture verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
