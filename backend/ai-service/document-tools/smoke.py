"""Opt-in real MCP smoke against an explicit local fixture; no OpenAI calls or document text logging."""
import argparse
import base64
import asyncio
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.application_preparation.document_adapters import HwpxDocumentAdapter, validate_hwpx
from app.application_preparation.document_contract import digest, GenerateDocumentRequest, PlanSelection, EditOperation, validate_plan
from app.application_preparation.document_mcp import document_session


async def run(args):
    with TemporaryDirectory(prefix="govbiz-smoke-") as directory:
        root = Path(directory).resolve()
        source = root / ("fixture." + args.format)
        shutil.copyfile(args.fixture, source)
        original_hash = digest(source.read_bytes())
        if args.format == "hwpx":
            document = await HwpxDocumentAdapter().inspect(source)
            if args.target is None:
                print({"initialize": "passed", "tools/list": "passed", "inspect": "passed", "targetCount": len(document.targets), "edited": False})
                return
            target = next(t for t in document.targets if t.targetId == args.target and t.editable)
            req = GenerateDocumentRequest(sourceBase64=base64.b64encode(source.read_bytes()).decode(), sourceSha256=original_hash,
                format="hwpx", answerRevision=1, facts=[{"id": "company:name", "label": "기업체명", "value": "가상기업"}], scope="Manually verified official company field")
            selection = PlanSelection(operations=[EditOperation(targetId=target.targetId, operation="replace_range",
                expectedText=target.currentText, start=0, end=len(target.currentText), valueRef="company:name", box=None,
                reason="Manually verified official company input field")], unresolvedTargets=[], scopeTargetIds=[target.targetId])
            plan = validate_plan(req, document, selection)
            data, verification = await HwpxDocumentAdapter().apply(source, document, plan, {"company:name": "가상기업"})
            output = root / "completed.hwpx"
            assert data == output.read_bytes() and verification["unresolved"] == 0
            if args.output:
                if Path(args.output).exists():
                    raise ValueError("Output must not already exist")
                shutil.copyfile(output, args.output)
            print({"initialize": "passed", "tools/list": "passed", "preview/apply/verify": "passed", "render": "not run"})
        elif args.format == "pdf":
            async with document_session("pdf", root) as session:
                text = await session.call("pdf_get_text", {"pdf_path": str(source)})
                geometry = await session.call("govbiz_pdf_text_regions", {"pdf_path": str(source)})
                assert geometry["page_count"] == text["page_count"]
                for page in range(text["page_count"]):
                    await session.call("pdf_get_text_layout", {"pdf_path": str(source), "page": page})
                    await session.call("pdf_detect_paragraphs", {"pdf_path": str(source), "page": page})
            async with document_session("kordoc", root) as session:
                parsed = await session.call("parse_document", {"file_path": str(source), "ocr": False,
                    "formula_ocr": False, "remove_header_footer": False,
                    "keep_empty_paragraphs": True, "keep_trailing_empty_cols": True})
                if not parsed.get("text", "").strip():
                    raise ValueError("Auxiliary PDF parser returned no text")
            print({"initialize": "passed", "tools/list": "passed", "pageReads": text["page_count"], "auxiliaryRead": "passed", "edited": False})
        assert digest(source.read_bytes()) == original_hash


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=["hwpx", "pdf"], required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--target", help="Manually reviewed HWPX native target (never a hardcoded production locator)")
    parser.add_argument("--output", type=Path)
    asyncio.run(run(parser.parse_args()))
