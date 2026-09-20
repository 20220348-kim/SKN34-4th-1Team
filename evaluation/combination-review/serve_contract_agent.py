"""TEST ONLY: real AI router/service/Agent with a LangChain fixed response; no OpenAI client."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
from fastapi import FastAPI
import uvicorn

from app.combination_review.agent import CombinationReviewAgent
from app.combination_review.models import AnalysisSelection, CONTRACT_VERSION
from app.combination_review.router import router
from app.combination_review.service import CombinationReviewService


def create_contract_app(fixture: Path) -> FastAPI:
    data = json.loads(fixture.read_text(encoding="utf-8"))
    if (data.pop("model"), data.pop("contractVersion")) != (
        "test-model", CONTRACT_VERSION,
    ):
        raise ValueError("fixture must match test-model and the current contract")
    # This is a fixed contract response, not a model run against its recorded prompt.
    # Like the AI unit tests, let the Service report the current prompt version.
    data.pop("promptVersion")
    scripted_calls = []

    def respond(messages):
        if scripted_calls:
            raise ValueError("restart this test-only server before another model call")
        scripted_calls.append(messages)
        payload = json.loads(messages[-1].content)
        output = deepcopy(data)
        for pair in output["pairs"]:
            for stage in pair["stages"]:
                for citation in stage["citations"]:
                    citation.pop("evidenceId")
                    quote = " ".join(citation.pop("quote").split())
                    matching = [option["citationOptionIndex"] for option in payload["citationOptions"]
                                if quote in " ".join(option["quote"].split())
                                and option["programIndex"] == pair["firstProgramIndex"]]
                    if not matching:
                        raise ValueError("fixture quote is missing from the actual request")
                    citation["citationOptionIndex"] = matching[0]
        parsed = AnalysisSelection.model_validate(output)
        return {"raw": AIMessage(content="", response_metadata={"status": "completed"}),
                "parsed": parsed.model_dump(), "parsing_error": None}

    model = SimpleNamespace(with_structured_output=lambda *args, **kwargs: RunnableLambda(respond))
    agent = CombinationReviewAgent(model=model, run_timeout_seconds=5)
    app = FastAPI(title="GovBiz TEST ONLY contract agent")
    app.state.container = SimpleNamespace(combination_review_service=CombinationReviewService(agent, "test-model"))
    app.include_router(router)

    @app.get("/__test__/calls")
    def calls():
        return {"scriptedCalls": len(scripted_calls), "paidCalls": 0, "qualityMeasured": False}

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18042)
    args = parser.parse_args()
    uvicorn.run(create_contract_app(args.fixture), host=args.host, port=args.port, access_log=False)
