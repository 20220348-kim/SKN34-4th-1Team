"""Real AI HTTP router/pipeline; only the paid model boundary uses saved fixtures."""

import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from fastapi import FastAPI
from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.router import get_service, router

MAPPING = json.loads((Path(__file__).parent / "runs/docx-kotra-20260926-v1/mapping.json").read_text(encoding="utf-8"))
assert MAPPING["wrong"] == MAPPING["unmapped"] == 0
TARGETS = {row["fieldId"]: row["actualTargetId"] for row in MAPPING["fields"]}
LOG = Path(os.environ["DOCX_E2E_AI_LOG"])


class FixtureModelAgent(ApplicationPreparationAgent):
    async def _invoke(self, selection_type, instructions, content, *args, **kwargs):
        payload = json.loads(content[0]["text"])
        if "fields" in payload:
            bindings = [{"factId": f["id"], "targetId": TARGETS[f["id"]], "box": None}
                        for f in payload["fields"]]
            result = {"bindings": bindings, "unmappedFieldIds": [],
                      "scopeTargetIds": [b["targetId"] for b in bindings]}
            stage = "mapping"
        else:
            targets = {t["targetId"]: t for t in payload["documentMap"]["targets"]}
            result = {"operations": [{"targetId": b["targetId"], "operation": "input",
                "expectedText": targets[b["targetId"]]["currentText"], "start": 0, "end": 0,
                "valueRef": b["factId"], "box": None, "reason": "Dummy fact from saved native binding"}
                for b in payload["bindings"]], "unresolvedTargets": [],
                "scopeTargetIds": payload["scopeTargetIds"]}
            stage = "planning"
        with LOG.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"stage": stage, "paidCalls": 0,
                "sourceSha256": payload["documentMap"]["sourceSha256"], "selection": result}) + "\n")
        return selection_type.model_validate(result)


agent = FixtureModelAgent(model=None, run_timeout_seconds=240)
application = FastAPI()
application.include_router(router)
application.dependency_overrides[get_service] = lambda: SimpleNamespace(agent=agent)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(application, host="0.0.0.0", port=18081)
