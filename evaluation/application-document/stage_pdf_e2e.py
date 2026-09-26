"""Stage dummy PDF_INPUT edits from the single scored Mapping response."""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys

SCRIPT = Path(__file__).resolve()
LOCAL_APP = SCRIPT.parents[2] / "backend/ai-service" if len(SCRIPT.parents) > 2 else None
sys.path.insert(0, str(LOCAL_APP if LOCAL_APP is not None and LOCAL_APP.is_dir() else Path("/app")))

from app.application_preparation.document_adapters import PdfDocumentAdapter
from app.application_preparation.document_contract import (
    CONTRACT, PIPELINE_VERSION, DocumentMap, EditOperation, GenerateDocumentRequest,
    PlanSelection, digest, validate_plan,
)


async def stage(source: Path, core_path: Path, map_path: Path,
                mapping_path: Path, expected_path: Path) -> dict:
    core = json.loads(core_path.read_text(encoding="utf-8"))
    document = DocumentMap.model_validate_json(map_path.read_text(encoding="utf-8"))
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    source_bytes = source.read_bytes()
    source_hash = digest(source_bytes)
    if not (core["sourceSha256"] == document.sourceSha256 == mapping["sourceSha256"]
            == expected["sourceSha256"] == source_hash):
        raise ValueError("PDF source identity mismatch")
    if (mapping["apiCalls"] != 1 or mapping["productionValidation"] != "PASS"
            or mapping["wrong"] or mapping["unmapped"] or mapping["ambiguous"]):
        raise ValueError("Mapping was not verified for native writing")
    selected = {row["fieldId"]: row for row in mapping["fields"]}
    by_id = {target.targetId: target for target in document.targets}
    for field in expected["fields"]:
        row = selected[field["id"]]
        if row["status"] != "CORRECT" or row["actualTargetId"] != field["expectedTargetId"]:
            raise ValueError(f"Unverified Mapping target: {field['id']}")
        target = by_id[row["actualTargetId"]]
        page = (target.nativeLocator.get("page") if target.kind == "PDF_INPUT" else
                target.nativeLocator.get("widgets", [{}])[0].get("page"))
        if (target.kind not in {"PDF_INPUT", "PDF_FIELD"} or target.currentText or
                page is None or page + 1 != field["expectedPage"]):
            raise ValueError(f"Unsafe PDF input: {field['id']}")
    fields = [field for field in expected["fields"] if field.get("writeValue")]
    facts = [{"id": field["id"], "label": field["label"], "value": field["writeValue"]}
             for field in fields]
    bindings = [{"factId": field["id"], "targetId": selected[field["id"]]["actualTargetId"],
                 "box": None} for field in fields]
    scope = [binding["targetId"] for binding in bindings]
    request = GenerateDocumentRequest.model_validate({**core, "answerRevision": 1,
        "facts": facts, "scope": expected["scopeTitle"],
        "bindings": bindings, "scopeTargetIds": scope})
    operations = [EditOperation(targetId=binding["targetId"], operation="set_field",
        expectedText="", start=0, end=0, valueRef=binding["factId"], box=None,
        reason="Human-reviewed official PDF_INPUT selected by the single Mapping response")
        for binding in bindings]
    plan = validate_plan(request, document, PlanSelection(
        operations=operations, unresolvedTargets=[], scopeTargetIds=scope))
    output, verification = await PdfDocumentAdapter().apply(
        source, document, plan, {fact["id"]: fact["value"] for fact in facts})
    if digest(source.read_bytes()) != source_hash:
        raise ValueError("Original PDF changed")
    return {"contractVersion": CONTRACT, "pipelineVersion": PIPELINE_VERSION,
        "sourceSha256": source_hash, "answerRevision": request.answerRevision,
        "outputBase64": base64.b64encode(output).decode(), "outputSha256": digest(output),
        "planHash": plan.planHash, "mapVersion": document.mapVersion,
        "engineVersion": document.engineVersion, "verification": verification,
        "placements": verification["placements"], "documentMap": document.model_dump(),
        "writePlan": plan.model_dump()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--core-request", required=True, type=Path)
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--mapping", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    result = asyncio.run(stage(args.source, args.core_request, args.map,
                               args.mapping, args.expected))
    args.output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"stage": result["verification"]["stage"],
        "sourceSha256": result["sourceSha256"], "placements": len(result["placements"]),
        "planHash": result["planHash"], "outputSha256": result["outputSha256"]}))


if __name__ == "__main__":
    main()
