"""Exercise saved-scope planning and native write on the large official HWPX."""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.document_adapters import HwpxDocumentAdapter
from app.application_preparation.document_contract import (
    GenerateDocumentRequest, PlanSelection, digest, validate_plan,
)
from app.application_preparation.document_pipeline import inspect_document


async def validate(source: Path, expected_path: Path, mapping_path: Path) -> dict:
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    source_bytes = source.read_bytes()
    if not (digest(source_bytes) == expected["sourceSha256"] == mapping["sourceSha256"]):
        raise ValueError("Official HWPX identity mismatch")
    if mapping["productionValidation"] != "PASS" or mapping["correct"] != len(expected["fields"]):
        raise ValueError("Mapping was not validated for saved-scope planning")
    by_field = {row["fieldId"]: row for row in mapping["fields"]}
    for field in expected["fields"]:
        if by_field[field["id"]]["actualTargetId"] != field["expectedTargetId"]:
            raise ValueError(f"Unexpected binding: {field['id']}")
    writable = [field for field in expected["fields"] if field.get("writeValue")]
    scope = [by_field[field["id"]]["actualTargetId"] for field in expected["fields"]]
    facts = [{"id": field["id"], "label": field["label"], "value": field["writeValue"]}
             for field in writable]
    bindings = [{"factId": field["id"], "targetId": by_field[field["id"]]["actualTargetId"],
                 "box": None} for field in writable]
    request = GenerateDocumentRequest(sourceBase64=base64.b64encode(source_bytes).decode(),
        sourceSha256=expected["sourceSha256"], format="hwpx", answerRevision=1,
        scope=expected["scopeTitle"], facts=facts, bindings=bindings, scopeTargetIds=scope)
    with TemporaryDirectory(prefix="govbiz-large-hwpx-plan-") as directory:
        copied = Path(directory) / "source.hwpx"
        shutil.copyfile(source, copied)
        document = await inspect_document(copied, request)
        selected = {target.targetId: target for target in document.targets}
        for binding in bindings:
            if selected[binding["targetId"]].currentText:
                raise ValueError("A selected native write target is not empty")
        agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
        captured = {}

        async def invoke(selection_type, _instructions, content, *_args, **_kwargs):
            captured["inputCharacters"] = len(content[0]["text"])
            captured["inputUtf8Bytes"] = len(content[0]["text"].encode("utf-8"))
            captured["targetCount"] = len(json.loads(content[0]["text"])["documentMap"]["targets"])
            return selection_type.model_validate({"operations": [{
                "targetId": binding["targetId"], "operation": "input", "expectedText": "",
                "start": 0, "end": 0, "valueRef": binding["factId"], "box": None,
                "reason": "Human-reviewed official blank native target"}
                for binding in bindings],
                "unresolvedTargets": [], "scopeTargetIds": [binding["targetId"] for binding in bindings]})

        agent._invoke = invoke
        selection = await agent.plan_document(request, document)
        plan = validate_plan(request, document, PlanSelection.model_validate(selection))
        output, verification = await HwpxDocumentAdapter().apply(copied, document, plan,
            {fact["id"]: fact["value"] for fact in facts})
        if digest(copied.read_bytes()) != expected["sourceSha256"]:
            raise ValueError("Official source copy changed")
        return {"sourceSha256": expected["sourceSha256"], "mapVersion": document.mapVersion,
                "boundScopeTargetCount": len(scope), "writeFields": len(writable),
                "planAgentCalls": 0, "planInput": captured,
                "planHash": plan.planHash, "verification": verification,
                "outputSha256": digest(output), "sourcePreserved": True}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--mapping", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    result = asyncio.run(validate(args.source, args.expected, args.mapping))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
