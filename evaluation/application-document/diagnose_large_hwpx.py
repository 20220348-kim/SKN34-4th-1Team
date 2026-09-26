"""Measure production HWPX Mapping context and conservative native candidates."""

import argparse
import asyncio
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.application_preparation.document_adapters import HwpxDocumentAdapter
from app.application_preparation.document_contract import (
    DocumentFieldReference, MapDocumentRequest, digest, mapping_label_matches,
)
from app.application_preparation.hwpx_form_analysis import annotate_semantic_reading_order
from validate_mapping import preserve_printed_labels


def serialized_input(request, document, targets) -> str:
    parents = {target.nativeLocator.get("parent") for target in targets}
    leaves = [target for target in targets if target.targetId not in parents]
    editable = [target for target in leaves if target.editable
                and target.nativeLocator.get("bindingEligible", True)]
    field_candidates = {field.id: [target.targetId for target in editable
        if target.nativeLocator.get("fieldLabels")
        and mapping_label_matches(field.label, target, field.guidance)]
        for field in request.fields}
    mapping_document = document.model_dump(exclude={"targets", "auxiliaryText"})
    mapping_document["targets"] = [target.model_dump(exclude={"context"}, exclude_none=True)
                                   for target in leaves]
    return json.dumps({"scope": request.scope,
        "fields": [field.model_dump() for field in request.fields],
        "fieldCandidates": field_candidates,
        "documentMap": mapping_document}, ensure_ascii=False)


async def diagnose(source: Path, blind_path: Path, expected_path: Path) -> dict:
    blind = json.loads(blind_path.read_text(encoding="utf-8"))
    if digest(source.read_bytes()) != blind["sourceSha256"]:
        raise ValueError("Official HWPX SHA-256 mismatch")
    request = MapDocumentRequest(
        sourceBase64=__import__("base64").b64encode(source.read_bytes()).decode(),
        sourceSha256=blind["sourceSha256"], format="hwpx", scope=blind["scopeTitle"],
        fields=[DocumentFieldReference(id=field["id"], label=field["label"],
                                      guidance="", required=False) for field in blind["fields"]])
    document = await HwpxDocumentAdapter().inspect(source, request.fields)
    annotate_semantic_reading_order(document.targets)
    preserve_printed_labels(document, blind)
    parents = {target.nativeLocator.get("parent") for target in document.targets}
    leaves = [target for target in document.targets if target.targetId not in parents]
    eligible = [target for target in leaves if target.editable
                and target.nativeLocator.get("bindingEligible", True)]
    candidates = {field.id: [target.targetId for target in eligible
        if target.nativeLocator.get("fieldLabels") and
        mapping_label_matches(field.label, target, field.guidance)] for field in request.fields}
    candidate_ids = set().union(*candidates.values())
    candidate_tables = {target.nativeLocator.get("table") for target in leaves
                        if target.targetId in candidate_ids}
    by_id = {target.targetId: target for target in leaves}
    same_tables = [target for target in leaves if target.nativeLocator.get("table") in candidate_tables]
    candidate_only = [target for target in leaves if target.targetId in candidate_ids]
    full_payload = serialized_input(request, document, document.targets)
    same_table_payload = serialized_input(request, document, same_tables)
    candidate_payload = serialized_input(request, document, candidate_only)
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if expected["sourceSha256"] != blind["sourceSha256"]:
        raise ValueError("Ground Truth identity mismatch")
    expected_coverage = {field["id"]: field["expectedTargetId"] in candidates[field["id"]]
                         for field in expected["fields"]}
    try:
        import tiktoken
        encoding = tiktoken.get_encoding("cl100k_base")
        token_counts = {"before": len(encoding.encode(full_payload)),
                        "sameTables": len(encoding.encode(same_table_payload)),
                        "candidateOnly": len(encoding.encode(candidate_payload))}
        token_method = "cl100k_base estimate"
    except Exception:
        token_counts = {"before": (len(full_payload) + 3) // 4,
                        "sameTables": (len(same_table_payload) + 3) // 4,
                        "candidateOnly": (len(candidate_payload) + 3) // 4}
        token_method = "characters/4 heuristic"
    return {"sourceSha256": blind["sourceSha256"], "sourceBytes": source.stat().st_size,
        "targetCount": len(document.targets), "leafTargetCount": len(leaves),
        "editableLeafCount": len(eligible),
        "contextCharacterCount": sum(len(target.currentText) + len(target.context)
                                     for target in document.targets),
        "productionInspectLimitCharacters": 400000,
        "failurePoint": "inspect_document: currentText+context > 400000 before agent invocation",
        "candidateCounts": {key: len(ids) for key, ids in candidates.items()},
        "candidateUnionCount": len(candidate_ids), "candidateTableCount": len(candidate_tables),
        "sameTableLeafCount": len(same_tables),
        "serializedCharacters": {"before": len(full_payload),
                                 "sameTables": len(same_table_payload),
                                 "candidateOnly": len(candidate_payload)},
        "serializedUtf8Bytes": {"before": len(full_payload.encode("utf-8")),
                                "sameTables": len(same_table_payload.encode("utf-8")),
                                "candidateOnly": len(candidate_payload.encode("utf-8"))},
        "estimatedTokens": token_counts, "tokenMethod": token_method,
        "expectedCandidateCoverage": expected_coverage,
        "candidateIds": sorted(candidate_ids),
        "candidateTables": sorted(table for table in candidate_tables if table is not None),
        "unusedCandidateCount": sum(target.targetId not in by_id for target in candidate_only)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--blind", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    result = asyncio.run(diagnose(args.source, args.blind, args.expected))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items()
                      if key not in {"candidateIds", "candidateTables", "expectedCandidateCoverage"}},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
