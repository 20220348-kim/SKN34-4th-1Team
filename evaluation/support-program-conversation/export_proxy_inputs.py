#!/usr/bin/env python3
"""조건 해석 모델이 실제로 받는 입력을 proxy/로 내보낸다. 기대 라벨은 내보내지 않으며 모델을 호출하지 않는다.

각 문항·턴의 요청을 실제 SupportProgramConversationAgent에 넣고, LangChain·OpenAI SDK가 만든 Responses API 요청
본문을 HTTP 대역에서 기록한다. 시스템 지침·사용자 입력·구조화 출력 형식은 손으로 복사하지 않고 이 본문에서 가져온다.
"""

import argparse
import asyncio
from hashlib import sha256
import json
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import validate_cases as cases_module  # noqa: E402  (AI Service 경로도 등록한다)

from app.config import (  # noqa: E402
    DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
    DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
    DEFAULT_OPENAI_MODEL,
)
from app.support_program_conversation.agent import SupportProgramConversationAgent  # noqa: E402
from app.support_program_conversation.models import SupportProgramConversationRequest  # noqa: E402

PROXY_DIR = HERE / "proxy"
PROXY_SCHEMA_VERSION = "govbiz-support-program-conversation-proxy-inputs-v1"
FILES = ("INSTRUCTIONS.md", "inputs.jsonl", "manifest.json", "response-format.json", "system-instructions.txt")
# 입력 기록용 고정 응답이다. Agent 호출을 끝내기 위해서만 쓰며 결과는 버린다.
_CAPTURE_REPLY = {"status": "ANSWERED", "updates": [], "answerKind": "SEARCH_HELP", "clarificationKind": None}

_INSTRUCTIONS = """# 대화 조건 해석 대리 모델 지침

이 폴더는 `export_proxy_inputs.py`가 실제 AI Service 코드(Agent → LangChain → OpenAI SDK 요청 본문)를 실행해 기록한
조건 해석 모델의 입력이다. 운영 모델(OpenAI) 대신 같은 입력에 답하는 **대리 모델**은 이 지침만 따른다.
이 실행은 **Claude 대리 검증**이며 OpenAI 운영 모델을 측정한 결과가 아니다.

## 읽을 파일

- `system-instructions.txt`: 시스템 지침 원문 (SHA-256 `{system_sha}`)
- `response-format.json`: 반드시 따를 구조화 출력 형식(strict JSON Schema) (SHA-256 `{format_sha}`)
- `inputs.jsonl`: 입력 {count}줄. 각 줄은 `{{"caseId", "turn", "user"}}`이며 `user` 문자열 전체가 모델이 받는 사용자 메시지다.

## 열지 말 것

다음에는 기대 동작과 채점 기준이 있다. 대리 모델은 열거나 검색하지 않는다.

- `../cases.json`, `../README.md`, `../*.py`, `../runs/`의 다른 실행
- 저장소의 AI Service 테스트·문서, Core·웹 코드, 이 평가에 관한 다른 대화 기록

## 답하는 방법

1. `system-instructions.txt`를 시스템 지침으로, 각 줄의 `user`를 사용자 메시지로 삼아 줄마다 한 번 답한다.
2. 줄마다 독립적으로 답한다. 다른 줄의 입력·답을 참고하지 않는다. 여러 턴 대화의 이전 상태는 `user` 안의
   `pendingClarification`·`pendingProposal`·`lastSearch`에 이미 들어 있다. `caseId`·`turn`은 답을 구분하는 번호일 뿐이다.
3. 운영 설정은 추론 노력 `none`, 최대 출력 2,000 tokens, 재시도 없는 한 번의 호출이다. 오래 고민하거나 답을 고쳐 쓰지 않는다.
4. 출력은 `response-format.json`의 `schema`를 엄격히 따르는 JSON 객체 하나다. `status`, `updates`, `answerKind`,
   `clarificationKind` 네 키를 모두 쓰고(null 포함) 다른 키를 넣지 않는다. 설명·마크다운을 붙이지 않는다.
5. 답을 `../runs/<실행 이름>/outputs.jsonl`에 한 줄에 하나씩 `{{"caseId": ..., "turn": ..., "output": {{...}}}}`로 쓴다.
   모든 입력 줄에 정확히 한 번씩 답한다(순서 무관). 어려운 줄도 건너뛰지 말고 지침대로 한 번 답한다.

형식 예시(입력과 무관한 가짜 번호이며 정답 예시가 아니다):

```json
{{"caseId": "X000", "turn": 1, "output": {{"status": "ANSWERED", "updates": [], "answerKind": "SEARCH_HELP", "clarificationKind": null}}}}
```

출력을 모두 쓴 뒤 운영자는 이 폴더의 `manifest.json`을 실행 폴더에 `inputs-manifest.json`으로 복사하고
상위 README의 재생 명령으로 채점한다.
"""


def ordered_items(cases: dict) -> list:
    """범주·시나리오 순서가 드러나지 않도록 id 지문 순으로 섞은 고정 순서."""
    return sorted(cases_module.iter_items(cases), key=lambda item: sha256(item.key.encode()).hexdigest())


async def capture(items: list) -> list:
    stub_module = cases_module.langchain_stub()
    start = len(stub_module.ResponsesChatStub.clients)
    stub = stub_module.ResponsesChatStub([])
    agent = SupportProgramConversationAgent(
        model=stub.model, model_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
        run_timeout_seconds=DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
    )
    try:
        for item in items:
            stub.outputs.append([stub_module.response_message(json.dumps(_CAPTURE_REPLY))])
            await agent.interpret(SupportProgramConversationRequest.model_validate(item.request))
        stub.assert_complete()
        return list(stub.calls)
    finally:
        await cases_module.close_stub_clients(stub_module, start)


def _single(values: set, label: str):
    if len(values) != 1:
        raise RuntimeError(f"모든 요청의 {label}이(가) 같아야 함")
    return next(iter(values))


def export(cases: dict, out_dir: Path) -> dict:
    items = ordered_items(cases)
    calls = asyncio.run(capture(items))
    lines = []
    for item, call in zip(items, calls, strict=True):
        payload = call.input[0]["content"]
        expected = SupportProgramConversationRequest.model_validate(item.request).model_dump(by_alias=True)
        if json.loads(payload) != expected:
            raise RuntimeError(f"{item.key}: 기록한 사용자 입력이 요청과 다름")
        lines.append(json.dumps({"caseId": item.case_id, "turn": item.turn, "user": payload}, ensure_ascii=False))
    system = _single({call.system_instructions for call in calls}, "시스템 지침")
    _single({json.dumps(call.body["text"]["format"], sort_keys=True) for call in calls}, "출력 형식")
    response_format = calls[0].body["text"]["format"]  # 요청 본문의 키 순서를 그대로 둔다.
    options = json.loads(_single({json.dumps({
        "max_output_tokens": call.body.get("max_output_tokens"), "reasoning": call.body.get("reasoning"),
        "store": call.body.get("store"),
    }, sort_keys=True) for call in calls}, "모델 요청 옵션"))
    format_text = json.dumps(response_format, ensure_ascii=False, indent=2) + "\n"
    inputs_text = "\n".join(lines) + "\n"
    singles = sum(1 for item in items if item.scenario_id is None)
    manifest = {
        "schemaVersion": PROXY_SCHEMA_VERSION,
        "description": "조건 해석 모델 입력(기대 라벨 없음). 대리 모델 실행은 Claude 대리 검증이며 OpenAI 측정이 아니다.",
        "casesCanonicalSha256": cases_module.canonical_sha256(cases),
        "requestSchemaVersion": cases["requestSchemaVersion"],
        "inputCount": len(lines), "singleTurnCases": singles, "scenarios": len(cases["scenarios"]),
        "scenarioTurns": len(lines) - singles,
        "systemInstructionsSha256": sha256(system.encode()).hexdigest(),
        "responseFormatSha256": sha256(format_text.encode()).hexdigest(),
        "inputsSha256": sha256(inputs_text.encode()).hexdigest(),
        "modelRequestOptions": options,
        "productionModelDefault": DEFAULT_OPENAI_MODEL,
    }
    texts = {
        "system-instructions.txt": system,
        "response-format.json": format_text,
        "inputs.jsonl": inputs_text,
        "manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        "INSTRUCTIONS.md": _INSTRUCTIONS.format(
            system_sha=manifest["systemInstructionsSha256"], format_sha=manifest["responseFormatSha256"], count=len(lines),
        ),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, text in texts.items():
        (out_dir / name).write_text(text, encoding="utf-8", newline="\n")
    return manifest


def differences(expected_dir: Path, actual_dir: Path) -> list[str]:
    """줄바꿈 표현과 무관하게 두 내보내기의 파일 내용을 비교한다."""
    found = []
    for name in FILES:
        expected, actual = expected_dir / name, actual_dir / name
        if not actual.exists():
            found.append(f"{name} 없음")
        elif expected.read_text(encoding="utf-8").replace("\r\n", "\n") != actual.read_text(encoding="utf-8").replace("\r\n", "\n"):
            found.append(f"{name} 내용이 현재 cases.json·프롬프트·출력 형식과 다름")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cases", type=Path, default=cases_module.CASES_PATH)
    parser.add_argument("--out-dir", type=Path, default=PROXY_DIR)
    parser.add_argument("--check", action="store_true", help="쓰지 않고 커밋된 proxy/가 최신인지만 확인한다")
    args = parser.parse_args()
    cases = cases_module.load_cases(args.cases)
    errors = cases_module.validate(cases)
    if errors:
        print(f"cases.json 검증 실패 {len(errors)}건: validate_cases.py로 확인", file=sys.stderr)
        return 1
    if args.check:
        with tempfile.TemporaryDirectory() as directory:
            export(cases, Path(directory))
            found = differences(Path(directory), args.out_dir)
        for line in found:
            print(f"- {line}", file=sys.stderr)
        if found:
            print("proxy/가 최신이 아님: export_proxy_inputs.py로 다시 내보내세요.", file=sys.stderr)
            return 1
        print("proxy/ 입력이 현재 cases.json·프롬프트·출력 형식과 같음")
        return 0
    manifest = export(cases, args.out_dir)
    print(f"{args.out_dir}에 입력 {manifest['inputCount']}줄을 내보냄(기대 라벨 없음, 모델 호출 없음)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
