"""Validate a local evidence/case draft without network access, model calls, or scoring."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlparse
import xml.etree.ElementTree as ET
import zipfile


DEFAULT_BUNDLE = Path(__file__).parent / "data" / "startup-jump-2026-v1"
ANSWERS = {"YES", "NO", "UNKNOWN"}
EXECUTION_STATES = {"UNKNOWN", "NOT_STARTED", "IN_PROGRESS", "COMPLETED", "STOPPED"}
FACT_FIELDS = {
    "applicationSubmitted", "selected", "commitmentSubmitted", "agreementSigned",
    "executionStatus", "fundingReceived",
}
STAGES = {"APPLICATION", "SELECTION", "COMMITMENT", "AGREEMENT", "EXECUTION", "FUNDING"}
JUDGMENTS = {
    "RESTRICTION_APPLIES", "PERMISSION_IN_SCOPE", "NEEDS_FACTS",
    "INSUFFICIENT_EVIDENCE", "CONFLICTING_EVIDENCE",
}
HP = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path) -> dict:
    result = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    require(isinstance(result, dict), f"expected JSON object: {path.name}")
    return result


def bundle_file(root: Path, name: str) -> Path:
    require(isinstance(name, str) and bool(name), "empty bundle path")
    require(not Path(name).is_absolute() and "\\" not in name and ":" not in name, "invalid bundle path")
    path = (root / name).resolve()
    require(path.is_relative_to(root.resolve()) and path.is_file(), f"missing/outside bundle file: {name}")
    return path


def check_file(root: Path, record: dict) -> Path:
    path = bundle_file(root, record["path"])
    require(bool(re.fullmatch(r"[0-9a-f]{64}", record["sha256"])), "invalid SHA-256")
    data = path.read_bytes()
    require(len(data) == record["byteLength"], f"size mismatch: {path.name}")
    require(hashlib.sha256(data).hexdigest() == record["sha256"], f"hash mismatch: {path.name}")
    return path


def hwpx_paragraphs(path: Path) -> dict[tuple[str, int], str]:
    """1-based hp:p document order, including empty/container paragraphs in numbering.

    Only direct run text belongs to a paragraph: nested table paragraphs are separate
    anchors. No whitespace normalization, OCR, or inferred page numbers are used.
    """
    result = {}
    with zipfile.ZipFile(path) as archive:
        sections = sorted(n for n in archive.namelist() if re.fullmatch(r"Contents/section\d+\.xml", n))
        require(bool(sections), f"no HWPX sections: {path.name}")
        for section in sections:
            root = ET.fromstring(archive.read(section))
            for index, paragraph in enumerate(root.findall(".//hp:p", HP), 1):
                result[section, index] = "".join(
                    "".join(text.itertext()) for text in paragraph.findall("./hp:run/hp:t", HP)
                ).strip()
    return result


def index_rows(rows: list, label: str) -> dict:
    require(isinstance(rows, list) and bool(rows), f"empty {label}")
    result = {}
    for row in rows:
        identifier = row["id"]
        require(isinstance(identifier, str) and bool(identifier) and identifier not in result, f"duplicate/invalid {label} id")
        result[identifier] = row
    return result


def validate_bundle(root: Path) -> dict:
    manifest = read_json(root / "manifest.json")
    require(manifest["schemaVersion"] == 1, "unsupported manifest schema")
    require(manifest["reviewStatus"] == "AI_DRAFT_PENDING_HUMAN", "this validator accepts review drafts only")
    require(manifest["productionApproved"] is False, "draft must not be production-approved")
    require(manifest["modelEvaluation"] == {"executed": False, "model": None, "promptVersion": None}, "model evaluation must be unexecuted")
    sources = index_rows(manifest["sources"], "source")
    extracted = {}
    for identifier, source in sources.items():
        for field in ("landingUrl", "downloadUrl"):
            url = urlparse(source[field])
            require(url.scheme == "https" and url.hostname in {"mss.go.kr", "www.mss.go.kr", "www.bizinfo.go.kr"}
                    and url.username is None, f"not an approved official URL: {identifier}")
        path = check_file(root, source)
        require(source["version"] == "sha256:" + source["sha256"], "source version/hash mismatch")
        if source["format"] == "HWPX":
            extracted[identifier] = hwpx_paragraphs(path)
        else:
            require(source["format"] == "PDF" and path.read_bytes().startswith(b"%PDF-"), "invalid PDF source")

    require(set(manifest["artifacts"]) == {"evidence", "cases"}, "unexpected artifact set")
    evidence_doc = read_json(check_file(root, manifest["artifacts"]["evidence"]))
    cases_doc = read_json(check_file(root, manifest["artifacts"]["cases"]))
    for document in (evidence_doc, cases_doc):
        require(document["bundleId"] == manifest["bundleId"] and document["schemaVersion"] == 1, "bundle/schema mismatch")
    evidence = index_rows(evidence_doc["evidence"], "evidence")
    for identifier, entry in evidence.items():
        require(entry["provenance"] == "OFFICIAL_SOURCE_EXCERPT", "synthetic evidence in official bundle")
        require(entry["humanReviewed"] is False, "unreviewed excerpt relabeled")
        require(bool(entry["scope"]) and bool(entry["quotes"]), "missing excerpt scope/quotes")
        for quote in entry["quotes"]:
            source_id = quote["sourceId"]
            require(source_id in extracted and sources[source_id]["role"] == "PRIMARY", "quote must point to a primary HWPX")
            require(type(quote["paragraph"]) is int and quote["paragraph"] > 0, "invalid paragraph")
            actual = extracted[source_id].get((quote["section"], quote["paragraph"]))
            require(bool(quote["text"]) and actual == quote["text"], f"quote mismatch: {identifier}")
        require(set(entry["relatedEvidenceIds"]) <= evidence.keys(), f"missing related evidence: {identifier}")
        visual = entry["visualCrossCheck"]
        if visual is not None:
            require(visual["sourceId"] in sources and sources[visual["sourceId"]]["format"] == "PDF", "invalid visual source")
            page_count = sources[visual["sourceId"]]["pageCount"]
            require(visual["reviewerType"] == "AI" and bool(visual["pages"])
                    and all(type(page) is int and 1 <= page <= page_count for page in visual["pages"]), "invalid visual page/reviewer")

    programs = index_rows(manifest["programs"], "program")
    for program in programs.values():
        require(program["productionSupported"] is False, "draft program cannot be enabled")
        require(set(program["sourceIds"]) <= sources.keys(), "unknown program source")
        if program["identity"] is None:
            require(program["sourceStatus"] == "NOT_ACQUIRED" and not program["sourceIds"], "unresolved identity must remain unsupported")
        else:
            identity = program["identity"]
            require(identity["sourceCode"] == "BIZINFO" and bool(re.fullmatch(r"PBLN_\d+", identity["sourceProgramId"]))
                    and identity["subProgramId"] is None, "use actual notice IDs, not invented subtype IDs")
            require(program["sourceStatus"] == "ACQUIRED" and bool(program["sourceIds"]), "resolved program needs a source")

    cases = index_rows(cases_doc["cases"], "case")
    kinds = {"OFFICIAL_SOURCE_SCENARIO", "SYNTHETIC_CONTEXT_CONFLICT", "EVIDENCE_WITHHELD", "TECHNICAL_FAILURE"}
    for identifier, case in cases.items():
        require(case["kind"] in kinds, "invalid case kind")
        require(case["reviewStatus"] == "AI_DRAFT_PENDING_HUMAN" and case["factsProvenance"] == "AI_SYNTHETIC_SCENARIO", "case provenance missing")
        chosen = [p["programId"] for p in case["input"]["programs"]]
        require(2 <= len(chosen) <= 3 and len(set(chosen)) == len(chosen) and set(chosen) <= programs.keys(), "invalid selected programs")
        for program in case["input"]["programs"]:
            facts = program["participation"]
            require(set(facts) == FACT_FIELDS, "missing/unexpected participation facts")
            for field, value in facts.items():
                require(value in (EXECUTION_STATES if field == "executionStatus" else ANSWERS), "invalid participation value")
        context = set(case["evidenceIds"])
        require(len(context) == len(case["evidenceIds"]) and context <= evidence.keys(), f"duplicate/unknown case evidence: {identifier}")
        for entry_id in context:
            require(set(evidence[entry_id]["relatedEvidenceIds"]) <= context, f"missing linked context: {identifier}/{entry_id}")
        synthetic = case["syntheticContext"]
        if case["kind"] == "SYNTHETIC_CONTEXT_CONFLICT":
            require(len(synthetic) >= 2 and not context, "synthetic conflict must be isolated")
            require(all(item["provenance"] == "SYNTHETIC_NOT_OFFICIAL" for item in synthetic), "unlabeled synthetic source")
        else:
            require(not synthetic, "synthetic context outside a negative case")
        expected = case["expected"]
        require(bool(expected["mustNotClaim"]), "missing forbidden claims")
        if case["kind"] == "TECHNICAL_FAILURE":
            require(expected["executionStatus"] == "FAILED" and expected["judgments"] == [] and expected["technicalFailure"] == "SOURCE_INTEGRITY_ERROR", "technical failure must not become a judgment")
        else:
            require(expected["executionStatus"] == "SUCCEEDED" and expected["technicalFailure"] is None and bool(expected["judgments"]), "invalid expected execution")
            for judgment in expected["judgments"]:
                require(judgment["stage"] in STAGES and judgment["status"] in JUDGMENTS and bool(judgment["scope"]), "invalid expected judgment")
            if case["kind"] == "EVIDENCE_WITHHELD":
                require(not context and all(j["status"] == "INSUFFICIENT_EVIDENCE" for j in expected["judgments"]), "no evidence must not imply permission")
            if case["kind"] == "SYNTHETIC_CONTEXT_CONFLICT":
                require(all(j["status"] == "CONFLICTING_EVIDENCE" for j in expected["judgments"]), "conflict must remain unresolved")
            if any(j["status"] == "NEEDS_FACTS" for j in expected["judgments"]):
                require(bool(expected["questions"]), "missing fact question")
        require(type(expected["requiresInstitutionConfirmation"]) is bool, "invalid institution confirmation flag")

    return {
        "bundleId": manifest["bundleId"], "integrityValid": True,
        "sourceCount": len(sources), "evidenceCount": len(evidence), "caseCount": len(cases),
        "caseKinds": {kind: sum(c["kind"] == kind for c in cases.values()) for kind in sorted(kinds)},
        "humanReviewedCaseCount": 0, "modelExecuted": False, "qualityScore": None,
        "productionApproved": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=DEFAULT_BUNDLE)
    args = parser.parse_args()
    try:
        report = validate_bundle(args.bundle)
    except (ValueError, KeyError, TypeError, OSError, ET.ParseError, zipfile.BadZipFile) as error:
        print(json.dumps({"integrityValid": False, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
