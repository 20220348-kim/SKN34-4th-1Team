"""Stage human-reviewed official AcroForm targets after a failed Mapping validator.

This is a downstream write check, not a successful production Mapping result.
"""

import asyncio
import base64
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

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
    source_hash = digest(source.read_bytes())
    if not (core["sourceSha256"] == document.sourceSha256 == mapping["sourceSha256"]
            == expected["sourceSha256"] == source_hash):
        raise ValueError("Source identity mismatch")
    if mapping["apiCalls"] != 1 or mapping["correct"] != len(expected["fields"]) or mapping["wrong"]:
        raise ValueError("Targets were not scored correct")
    selected = {row["fieldId"]: row for row in mapping["fields"]}
    targets = {target.targetId: target for target in document.targets}
    for field in expected["fields"]:
        row = selected[field["id"]]
        if row["actualTargetId"] != field["expectedTargetId"] or row["status"] != "CORRECT":
            raise ValueError("Unverified native target")
        if not targets[row["actualTargetId"]].editable:
            raise ValueError("Native target is not editable")
    facts = [{"id": field["id"], "label": field["label"], "value": field["writeValue"]}
             for field in expected["fields"] if field.get("writeValue")]
    bindings = [{"factId": fact["id"], "targetId": selected[fact["id"]]["actualTargetId"],
                 "box": None} for fact in facts]
    scope = [binding["targetId"] for binding in bindings]
    request = GenerateDocumentRequest.model_validate({**core, "facts": facts,
        "scope": expected["scopeTitle"], "bindings": bindings, "scopeTargetIds": scope})
    operations = [EditOperation(targetId=binding["targetId"], operation="set_field",
        expectedText=targets[binding["targetId"]].currentText, start=0, end=0,
        valueRef=binding["factId"], box=None, reason="Human-reviewed official AcroForm target")
        for binding in bindings]
    plan = validate_plan(request, document, PlanSelection(
        operations=operations, unresolvedTargets=[], scopeTargetIds=scope))
    output, verification = await PdfDocumentAdapter().apply(
        source, document, plan, {fact["id"]: fact["value"] for fact in facts})
    return {"contractVersion": CONTRACT, "pipelineVersion": PIPELINE_VERSION,
        "sourceSha256": source_hash, "answerRevision": request.answerRevision,
        "outputBase64": base64.b64encode(output).decode(), "outputSha256": digest(output),
        "planHash": plan.planHash, "mapVersion": document.mapVersion,
        "engineVersion": document.engineVersion, "verification": verification,
        "placements": verification["placements"], "documentMap": document.model_dump(),
        "writePlan": plan.model_dump()}


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    for name in ("source", "core-request", "map", "mapping", "expected", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    result = asyncio.run(stage(args.source, args.core_request, args.map,
        args.mapping, args.expected))
    args.output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"stage": result["verification"]["stage"],
        "placements": len(result["placements"]), "sourceSha256": result["sourceSha256"]}))


if __name__ == "__main__":
    main()
