"""대리 모델 입력 내보내기의 테스트. 실제 Agent 요청 본문을 HTTP 대역에서 기록하며 모델을 부르지 않는다."""

import json

import pytest

import export_proxy_inputs
import validate_cases
from app.support_program_conversation.models import SupportProgramConversationRequest
from app.support_program_conversation.prompt import SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS

PROXY = export_proxy_inputs.PROXY_DIR


@pytest.fixture(scope="module")
def cases():
    return validate_cases.load_cases()


def test_committed_proxy_inputs_match_the_current_cases_prompt_and_schema(cases, tmp_path):
    manifest = export_proxy_inputs.export(cases, tmp_path)
    assert export_proxy_inputs.differences(tmp_path, PROXY) == []
    assert manifest["inputCount"] == len(validate_cases.iter_items(cases))


def test_each_line_is_exactly_the_agent_user_payload_without_labels(cases):
    requests = {item.key: item.request for item in validate_cases.iter_items(cases)}
    lines = [json.loads(line) for line in (PROXY / "inputs.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(lines) == len(requests)
    assert len({f"{line['caseId']}#{line['turn']}" for line in lines}) == len(lines)
    for line in lines:
        assert set(line) == {"caseId", "turn", "user"}
        request = requests[f"{line['caseId']}#{line['turn']}"]
        assert json.loads(line["user"]) == SupportProgramConversationRequest.model_validate(request).model_dump(by_alias=True)
    text = (PROXY / "inputs.jsonl").read_text(encoding="utf-8")
    for label in ('"expected"', '"rationale"', '"mustNot"', '"route"', '"targetIndexes"', '"intents"', '"lastResults"'):
        assert label not in text


def test_system_text_and_strict_schema_come_from_the_ai_service(cases):
    assert (PROXY / "system-instructions.txt").read_text(encoding="utf-8") == SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS
    response_format = json.loads((PROXY / "response-format.json").read_text(encoding="utf-8"))
    assert response_format["type"] == "json_schema" and response_format["strict"] is True
    assert response_format["name"] == "SupportProgramConversationOutput"
    assert response_format["schema"]["required"] == ["status", "updates", "answerKind", "clarificationKind"]
    manifest = json.loads((PROXY / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["casesCanonicalSha256"] == validate_cases.canonical_sha256(cases)
    assert manifest["modelRequestOptions"] == {"max_output_tokens": 2000, "reasoning": {"effort": "none"}, "store": False}
    instructions = (PROXY / "INSTRUCTIONS.md").read_text(encoding="utf-8")
    assert "Claude 대리 검증" in instructions and "../cases.json" in instructions


def test_input_order_does_not_group_categories(cases):
    lines = [json.loads(line) for line in (PROXY / "inputs.jsonl").read_text(encoding="utf-8").splitlines()]
    singles = [line["caseId"] for line in lines if line["caseId"].startswith("S")]
    assert singles != sorted(singles)
