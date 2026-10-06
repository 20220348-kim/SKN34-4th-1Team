"""Offline native regression on fixed public forms; never calls OpenAI.

Reviewed bindings verify editing only. Captured blind mapping inputs prepare a
separate, explicitly approved model evaluation; they do not prove AI quality.
Core finishes the staged binary HWP and flat PDF outputs using the
OfficialNativeCompletion runner.
"""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.document_contract import (
    DocumentFieldReference, EditOperation, GenerateDocumentRequest, MapDocumentRequest,
    MappingSelection, PlanSelection, digest, validate_mapping,
)
from app.application_preparation.document_pipeline import generate_document, inspect_document


SAMPLES = {
    "hwp": ("medical-export-hwp-2026-v1", "blind-medical-export-hwp-2026-v1"),
    "hwpx": ("seocho-2026-v1", "blind-seocho-2026-v1"),
    "pdf": ("busan-flat-pdf-2026-v1", "blind-busan-flat-pdf-2026-v1"),
    "docx": ("docx-kotra-procurement-2026-v1", "blind-docx-kotra-procurement-2026-v1"),
    "xlsx": ("xlsx-purchase-v1", "blind-xlsx-purchase-v1"),
}


class CapturedInput(Exception):
    def __init__(self, content):
        self.content = content


class OfflinePlan:
    """Only the reviewed flat-PDF plan is allowed; other formats must be deterministic."""

    async def plan_document(self, request, document):
        if request.format != "pdf":
            raise AssertionError("Unexpected model planning in offline regression")
        targets = {target.targetId: target for target in document.targets}
        return PlanSelection(operations=[EditOperation(
            targetId=binding.targetId, operation="set_field",
            expectedText=targets[binding.targetId].currentText, start=0, end=0,
            valueRef=binding.factId, box=None, reason="Reviewed offline PDF blank input",
        ) for binding in request.bindings], unresolvedTargets=[], scopeTargetIds=request.scopeTargetIds)


async def run_one(format_name, sources, output, definitions, mapping_run=None):
    expected_name, blind_name = SAMPLES[format_name]
    expected = json.loads((definitions / "expected" / f"{expected_name}.json").read_text(encoding="utf-8"))
    blind = json.loads((definitions / f"{blind_name}.json").read_text(encoding="utf-8"))
    source = sources / f"official.{format_name}"
    data = source.read_bytes()
    source_hash = digest(data)
    if source_hash != expected["sourceSha256"] or source_hash != blind["sourceSha256"]:
        raise ValueError("Official source hash mismatch")
    native = {}
    if format_name == "hwp":
        exported = json.loads((sources.parent / "hwp-targets.json").read_text(encoding="utf-8"))
        if exported["sourceSha256"] != source_hash:
            raise ValueError("Core HWP inspection hash mismatch")
        native["hwpTargets"] = exported["targets"]
    if format_name == "pdf":
        exported = json.loads((sources.parent / "pdf-inspection.json").read_text(encoding="utf-8"))
        if exported["sourceSha256"] != source_hash:
            raise ValueError("Core PDF inspection hash mismatch")
        native = {key: exported[key] for key in ("pdfTargets", "pageImages", "pdfFields")}
    mapping_request = MapDocumentRequest(sourceBase64=base64.b64encode(data).decode(),
        sourceSha256=source_hash, format=format_name, scope=blind["scopeTitle"], **native,
        fields=[DocumentFieldReference(**{"guidance": "", "required": False, **field}) for field in blind["fields"]])
    document = await inspect_document(source, mapping_request)
    run_dir = output / format_name
    run_dir.mkdir()
    (run_dir / "map.json").write_text(document.model_dump_json(), encoding="utf-8")

    async def capture(_type, _instructions, content, *_args, **_kwargs):
        raise CapturedInput(content)

    probe = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    probe._invoke = capture
    try:
        await probe.map_document(mapping_request, document)
    except CapturedInput as captured:
        text = json.dumps(captured.content, ensure_ascii=False)
        (run_dir / "mapping-input.json").write_text(text, encoding="utf-8")
    else:
        raise AssertionError("Mapping input capture did not run")

    fields = [field for field in expected["fields"] if field.get("writeValue")]
    if format_name == "hwp":
        fields = [{**field, "writeValue": "TEST-" + field["id"].replace(":", "-")}
                  for field in expected["fields"][:3]]
    if not fields:
        raise ValueError("No reviewed dummy writes")
    targets = {target.targetId: target for target in document.targets}
    if mapping_run is None:
        bindings = [{"factId": field["id"], "targetId": field["expectedTargetId"], "box": None} for field in fields]
        scope = [binding["targetId"] for binding in bindings]
    else:
        selection = MappingSelection.model_validate_json(
            (mapping_run / format_name / "selection.json").read_text(encoding="utf-8"))
        validate_mapping(mapping_request, document, selection)
        provided = {field["id"] for field in fields}
        bindings = [binding.model_dump() for binding in selection.bindings if binding.factId in provided]
        if {binding["factId"] for binding in bindings} != provided:
            raise ValueError("A dummy answer has no verified model-selected binding")
        scope = selection.scopeTargetIds
    if any(not targets[binding["targetId"]].editable for binding in bindings):
        raise ValueError("Selected input is no longer editable")
    request = GenerateDocumentRequest(sourceBase64=mapping_request.sourceBase64,
        sourceSha256=source_hash, format=format_name, answerRevision=1, scope=expected["scopeTitle"], **native,
        facts=[{"id": field["id"], "label": field["label"], "value": field["writeValue"]} for field in fields],
        bindings=bindings, scopeTargetIds=scope)
    (run_dir / "request.json").write_text(request.model_dump_json(), encoding="utf-8")
    result = await generate_document(request, OfflinePlan())
    (run_dir / "stage.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    completed = base64.b64decode(result["outputBase64"], validate=True)
    if not str(result["verification"].get("stage", "")).endswith("_REQUIRED"):
        completed_path = run_dir / f"completed.{format_name}"
        completed_path.write_bytes(completed)
        reopened = await inspect_document(completed_path, request.model_copy(update={
            "sourceBase64": result["outputBase64"], "sourceSha256": digest(completed)}))
        after = {target.targetId: target for target in reopened.targets}
        for field in fields:
            if field["writeValue"] not in after[field["expectedTargetId"]].currentText:
                raise AssertionError("Reopened target value mismatch")
    if source.read_bytes() != data:
        raise AssertionError("Official original changed")
    return {"status": "PASSED", "sourceUrl": expected["sourceUrl"], "sourceSha256": source_hash,
            "targetCount": len(document.targets), "mappingFieldCount": len(blind["fields"]),
            "mappingInputCharacters": len(text), "requestedWrites": len(fields),
            "verification": result["verification"], "skippedFacts": result["skippedFacts"],
            "remainingExampleCount": result["remainingExampleCount"], "sourcePreserved": True,
            "openAiCalls": 0, "bindingSource": "verified model selection" if mapping_run else "reviewed reference, editing regression only"}


async def run(sources, output, formats, mapping_run=None):
    sources, output = sources.resolve(), output.resolve()
    if mapping_run is not None:
        mapping_run = mapping_run.resolve()
    if output.exists():
        raise FileExistsError("Use a fresh run directory; never replace prior evidence")
    output.mkdir(parents=True)
    results = {}
    for format_name in formats:
        try:
            results[format_name] = await run_one(format_name, sources, output, Path(__file__).parent, mapping_run)
        except Exception as error:
            results[format_name] = {"status": "FAILED", "errorType": type(error).__name__,
                                    "reason": str(error), "openAiCalls": 0}
        print(json.dumps({"format": format_name, **results[format_name]}, ensure_ascii=False), flush=True)
    (output / "native-regression.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return all(result["status"] == "PASSED" for result in results.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--formats", nargs="+", choices=list(SAMPLES), default=list(SAMPLES))
    parser.add_argument("--mapping-run", type=Path, help="Reuse the approved mapping response without any new model call")
    args = parser.parse_args()
    sys.exit(0 if asyncio.run(run(args.sources, args.output, args.formats, args.mapping_run)) else 1)
