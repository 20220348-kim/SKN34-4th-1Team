"""Inspect one official flat PDF with the production FFDetr and PDF MCP path."""

import argparse
import asyncio
import json
from pathlib import Path
import sys

SCRIPT = Path(__file__).resolve()
LOCAL_APP = SCRIPT.parents[2] / "backend/ai-service" if len(SCRIPT.parents) > 2 else None
sys.path.insert(0, str(LOCAL_APP if LOCAL_APP is not None and LOCAL_APP.is_dir() else Path("/app")))

from app.application_preparation.document_contract import GenerateDocumentRequest, digest
from app.application_preparation.document_mcp import document_session
from app.application_preparation.document_pipeline import inspect_document


async def inspect(source: Path, request_path: Path, map_output: Path | None) -> dict:
    request = GenerateDocumentRequest.model_validate_json(request_path.read_text(encoding="utf-8"))
    source_hash = digest(source.read_bytes())
    if request.format != "pdf" or request.sourceSha256 != source_hash:
        raise ValueError("Expected a matching official PDF and Core request")
    document = await inspect_document(source, request)
    if map_output is not None:
        if map_output.exists():
            raise FileExistsError(map_output)
        map_output.write_text(document.model_dump_json() + "\n", encoding="utf-8")
    async with document_session("pdf", source.parent) as session:
        geometry = await session.call("govbiz_pdf_text_regions", {"pdf_path": str(source)})
    by_page = {page["page"]: page for page in geometry["pages"]}
    inputs = [target for target in document.targets if target.kind == "PDF_INPUT"]
    return {
        "sourceSha256": source_hash,
        "sourceBytes": source.stat().st_size,
        "pageCount": len(request.pageImages),
        "mapVersion": document.mapVersion,
        "engineVersion": document.engineVersion,
        "targetCount": len(document.targets),
        "kindCounts": {kind: sum(target.kind == kind for target in document.targets)
                       for kind in sorted({target.kind for target in document.targets})},
        "geometry": [{"page": page, "printedTextRegions": len(item["regions"]),
                      "blankRegions": len(item.get("blankRegions", []))}
                     for page, item in sorted(by_page.items())],
        "inputs": [{"targetId": target.targetId,
                    "page": target.nativeLocator["page"],
                    "box": target.nativeLocator["box"],
                    "fieldLabels": target.nativeLocator["fieldLabels"],
                    "detectorConfidence": target.nativeLocator["detectorConfidence"],
                    "detectorSha256": target.nativeLocator["detectorSha256"]}
                   for target in inputs],
        "fields": [{"targetId": target.targetId, "kind": target.kind,
                    "label": target.label, "editable": target.editable,
                    "nativeLocator": target.nativeLocator}
                   for target in document.targets if target.kind == "PDF_FIELD"],
        "sourcePreserved": digest(source.read_bytes()) == source_hash,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--map-output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    result = asyncio.run(inspect(args.source, args.request, args.map_output))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "inputs"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
