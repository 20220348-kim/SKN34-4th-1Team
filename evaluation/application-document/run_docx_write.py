"""Write only reviewed dummy values to a separate official DOCX copy."""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from app.application_preparation.docx_adapter import DocxDocumentAdapter
from app.application_preparation.document_contract import (
    EditOperation, GenerateDocumentRequest, PlanSelection, digest, validate_plan,
)


async def run(source: Path, expected_path: Path, output: Path):
    data = source.read_bytes()
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if digest(data) != expected["sourceSha256"]:
        raise ValueError("Official DOCX source hash mismatch")
    fields = [field for field in expected["fields"] if "writeValue" in field]
    if len(fields) not in range(3, 6):
        raise ValueError("Only three to five reviewed dummy fields may be written")
    adapter = DocxDocumentAdapter()
    document = await adapter.inspect(source)
    targets = {target.targetId: target for target in document.targets}
    if any(not targets[field["expectedTargetId"]].editable or targets[field["expectedTargetId"]].currentText
           for field in fields):
        raise ValueError("A reviewed DOCX input is no longer an empty editable target")
    facts = [{"id": field["id"], "label": field["label"], "value": field["writeValue"]} for field in fields]
    request = GenerateDocumentRequest(sourceBase64=base64.b64encode(data).decode(), sourceSha256=digest(data),
        format="docx", answerRevision=1, facts=facts, scope=expected["scopeTitle"])
    operations = [EditOperation(targetId=field["expectedTargetId"], operation="input", expectedText="",
        start=0, end=0, valueRef=field["id"], box=None, reason="Reviewed official blank cell") for field in fields]
    plan = validate_plan(request, document, PlanSelection(operations=operations, unresolvedTargets=[],
        scopeTargetIds=[field["expectedTargetId"] for field in fields]))
    completed, verification = await adapter.apply(source, document, plan,
        {field["id"]: field["writeValue"] for field in fields})
    output.write_bytes(completed)
    reopened = await adapter.inspect(output)
    by_id = {target.targetId: target for target in reopened.targets}
    if any(by_id[field["expectedTargetId"]].currentText != field["writeValue"] for field in fields):
        raise ValueError("Reopened official DOCX target value mismatch")
    return {"sourceSha256": digest(data), "outputSha256": digest(completed), "writes": len(fields),
            "verification": verification, "outputBytes": len(completed), "outputPath": str(output)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.source, args.expected, args.output)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
