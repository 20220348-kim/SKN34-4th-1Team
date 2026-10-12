# 대화 조건 해석 대리 모델 지침

이 폴더는 `export_proxy_inputs.py`가 실제 AI Service 코드(Agent → LangChain → OpenAI SDK 요청 본문)를 실행해 기록한
조건 해석 모델의 입력이다. 운영 모델(OpenAI) 대신 같은 입력에 답하는 **대리 모델**은 이 지침만 따른다.
이 실행은 **Claude 대리 검증**이며 OpenAI 운영 모델을 측정한 결과가 아니다.

## 읽을 파일

- `system-instructions.txt`: 시스템 지침 원문 (SHA-256 `ccbb549dfbcce787e5cdfc46901f6c8ca443ceb094122170254f7bd145b2ea27`)
- `response-format.json`: 반드시 따를 구조화 출력 형식(strict JSON Schema) (SHA-256 `03121efbe169017bc58ffbfe66db27045059a358946dbbf3c57c0f360caaf9d6`)
- `inputs.jsonl`: 입력 264줄. 각 줄은 `{"caseId", "turn", "user"}`이며 `user` 문자열 전체가 모델이 받는 사용자 메시지다.

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
5. 답을 `../runs/<실행 이름>/outputs.jsonl`에 한 줄에 하나씩 `{"caseId": ..., "turn": ..., "output": {...}}`로 쓴다.
   모든 입력 줄에 정확히 한 번씩 답한다(순서 무관). 어려운 줄도 건너뛰지 말고 지침대로 한 번 답한다.

형식 예시(입력과 무관한 가짜 번호이며 정답 예시가 아니다):

```json
{"caseId": "X000", "turn": 1, "output": {"status": "ANSWERED", "updates": [], "answerKind": "SEARCH_HELP", "clarificationKind": null}}
```

출력을 모두 쓴 뒤 운영자는 이 폴더의 `manifest.json`을 실행 폴더에 `inputs-manifest.json`으로 복사하고
상위 README의 재생 명령으로 채점한다.
