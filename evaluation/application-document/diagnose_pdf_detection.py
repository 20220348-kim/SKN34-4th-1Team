"""Capture official PDF detector and measured geometry evidence before region filtering."""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys

SCRIPT = Path(__file__).resolve()
LOCAL_APP = SCRIPT.parents[2] / "backend/ai-service" if len(SCRIPT.parents) > 2 else None
sys.path.insert(0, str(LOCAL_APP if LOCAL_APP is not None and LOCAL_APP.is_dir() else Path("/app")))

from app.application_preparation.document_contract import GenerateDocumentRequest, digest
from app.application_preparation.document_mcp import document_session


async def diagnose(source: Path, request_path: Path) -> dict:
    request = GenerateDocumentRequest.model_validate_json(request_path.read_text(encoding="utf-8"))
    if request.format != "pdf" or digest(source.read_bytes()) != request.sourceSha256:
        raise ValueError("Source or Core request mismatch")
    images = []
    for page, encoded in enumerate(request.pageImages):
        image = source.parent / f"detector-page-{page}.png"
        image.write_bytes(base64.b64decode(encoded, validate=True))
        images.append(str(image))
    async with document_session("pdf", source.parent) as session:
        geometry = await session.call("govbiz_pdf_text_regions", {"pdf_path": str(source)})
        detections = await session.call("govbiz_pdf_detect_inputs", {"image_paths": images})
    return {"sourceSha256": request.sourceSha256, "pageCount": len(request.pageImages),
            "geometry": geometry, "detections": detections}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    result = asyncio.run(diagnose(args.source, args.request))
    args.output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"sourceSha256": result["sourceSha256"], "pageCount": result["pageCount"],
        "detections": [len(page["detections"]) for page in result["detections"]["pages"]],
        "printedTextRegions": [len(page["regions"]) for page in result["geometry"]["pages"]],
        "blankRegions": [len(page.get("blankRegions", [])) for page in result["geometry"]["pages"]]}))


if __name__ == "__main__":
    main()
