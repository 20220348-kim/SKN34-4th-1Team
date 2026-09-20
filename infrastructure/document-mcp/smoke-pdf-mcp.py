"""Manual Core-request -> actual PDF MCP -> Core-response smoke, without OpenAI."""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend/ai-service"))
from app.application_preparation.document_adapters import PdfDocumentAdapter
from app.application_preparation.document_contract import (
    CONTRACT, PIPELINE_VERSION, GenerateDocumentRequest, EditOperation, PlanSelection, digest, validate_plan,
)
from app.application_preparation.document import DocumentBox


async def run(args):
    request = GenerateDocumentRequest.model_validate_json(args.request.read_text(encoding="utf-8"))
    if len(request.facts) != 1:
        raise ValueError("This manual smoke requires one confirmed fact")
    outputs = [Path(str(args.output_prefix) + suffix) for suffix in (".pdf", ".json")]
    if any(path.exists() for path in outputs):
        raise ValueError("Output already exists")
    source = base64.b64decode(request.sourceBase64, validate=True)
    with TemporaryDirectory(prefix="govbiz-pdf-smoke-") as directory:
        path = Path(directory).resolve() / "source.pdf"
        path.write_bytes(source)
        adapter = PdfDocumentAdapter()
        document = await adapter.inspect(path, request)
        operations = []
        for text in args.cleanup_text:
            candidates = [t for t in document.targets if t.kind == "PDF_TEXT" and text in t.currentText]
            if len(candidates) != 1:
                raise ValueError("Cleanup must match one inspected paragraph")
            target = candidates[0]
            start = target.currentText.index(text)
            operations.append(EditOperation(targetId=target.targetId, operation="delete_range", expectedText=target.currentText,
                start=start, end=start + len(text), valueRef=None, box=None, reason="Human-reviewed removable example range"))
        target = next(t for t in document.targets if t.targetId == f"page-{args.page}")
        operations.append(EditOperation(targetId=target.targetId, operation="set_field", expectedText=target.currentText,
            start=0, end=len(target.currentText), valueRef=request.facts[0].id,
            box=DocumentBox(x=args.box[0], y=args.box[1], width=args.box[2], height=args.box[3]),
            reason="Human-reviewed company name input rectangle in the rendered application"))
        plan = validate_plan(request, document, PlanSelection(operations=operations, unresolvedTargets=[],
                            scopeTargetIds=list(dict.fromkeys(op.targetId for op in operations))))
        data, verification = await adapter.apply(path, document, plan, {f.id: f.value for f in request.facts})
        assert path.read_bytes() == source
        response = {"contractVersion": CONTRACT, "pipelineVersion": PIPELINE_VERSION, "sourceSha256": request.sourceSha256,
            "answerRevision": request.answerRevision, "outputBase64": base64.b64encode(data).decode(), "outputSha256": digest(data),
            "planHash": plan.planHash, "mapVersion": document.mapVersion, "engineVersion": document.engineVersion,
            "verification": verification, "placements": verification["placements"], "documentMap": document.model_dump(), "writePlan": plan.model_dump()}
        with outputs[0].open("xb") as output:
            output.write(data)
        with outputs[1].open("x", encoding="utf-8") as output:
            json.dump(response, output, ensure_ascii=False)
    print({"sourceUnchanged": True, "deletionsVerified": verification["deletionsVerified"], "stage": "PDFBOX_REQUIRED"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output-prefix", type=Path, required=True)
    parser.add_argument("--page", type=int, default=0)
    parser.add_argument("--box", nargs=4, type=float, required=True)
    parser.add_argument("--cleanup-text", action="append", default=[])
    asyncio.run(run(parser.parse_args()))
