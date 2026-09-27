"""Write 3 to 5 reviewed dummy values and verify the official XLSX copy."""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from app.application_preparation.xlsx_adapter import XlsxDocumentAdapter
from app.application_preparation.document_contract import (
    EditOperation, GenerateDocumentRequest, PlanSelection, digest, validate_plan,
)


async def run(source, expected_path, output):
    data = source.read_bytes()
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if digest(data) != expected["sourceSha256"] or source.resolve() == output.resolve():
        raise ValueError("Official source hash/path mismatch")
    fields = [f for f in expected["fields"] if "writeValue" in f]
    if not 3 <= len(fields) <= 5:
        raise ValueError("Only 3 to 5 reviewed dummy fields may be written")
    adapter = XlsxDocumentAdapter()
    document = await adapter.inspect(source)
    by_id = {t.targetId: t for t in document.targets}
    if any(not by_id[f["expectedTargetId"]].editable for f in fields):
        raise ValueError("Reviewed native target is no longer editable")
    request = GenerateDocumentRequest(sourceBase64=base64.b64encode(data).decode(),
        sourceSha256=digest(data), format="xlsx", answerRevision=1, scope=expected["scopeTitle"],
        facts=[{"id": f["id"], "label": f["label"], "value": f["writeValue"]} for f in fields])
    operations = [EditOperation(targetId=f["expectedTargetId"], operation="input", expectedText="",
        start=0, end=0, valueRef=f["id"], box=None, reason="Reviewed official blank cell, dummy value") for f in fields]
    plan = validate_plan(request, document, PlanSelection(operations=operations,
        unresolvedTargets=[], scopeTargetIds=[f["expectedTargetId"] for f in fields]))
    completed, verification = await adapter.apply(source, document, plan, {f["id"]: f["writeValue"] for f in fields})
    output.write_bytes(completed)
    reopened = await adapter.inspect(output)
    after = {t.targetId: t for t in reopened.targets}
    if any(after[f["expectedTargetId"]].currentText != f["writeValue"] for f in fields):
        raise ValueError("Reopened XLSX target mismatch")
    return {"sourceSha256": digest(data), "outputSha256": digest(completed), "writes": len(fields),
            "verification": verification, "outputBytes": len(completed)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("source", "expected", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.source, args.expected, args.output)), ensure_ascii=False, indent=2))
