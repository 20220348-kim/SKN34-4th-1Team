# Core HTTP 대역 수집의 저장 캡처

실제 JVM/Core → AI → Qdrant 통합 검사에서 생성한 고정 캡처다. 모델 HTTP 응답은 대역이며
유료 모델 호출은 0회다. Ops에는 `core-rag-20261002-v1`, `core-rag-20261002-v2`로 등록한다.

## 출처와 보존

- 저장소: `ilil1/SKN34-4th-1Team`
- 원본 커밋: `461e79e13c9d8a87d7aa1fa5d59da64833762600`
- [LLMOps CI 실행 36982990150](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36982990150)
- artifact: `llmops-core-search-traces-461e79e13c9d8a87d7aa1fa5d59da64833762600` / ID `11216108148`
- 원본 artifact의 `core-rag/{v1,v2}/fixture.json`, `capture.json` 바이트를 그대로 복사했다.
- [provenance.json](provenance.json)에 출처와 네 파일의 SHA-256을 기록했다. Ops 실행 명세도
  fixture·capture 해시와 `integration-stub` 출처를 고정한다.

원본 수집 단계와 전체 LLMOps workflow 성공을 확인했다. 다른 workflow의 성공을 이 기록으로
판단하지 않는다. 새 수집 자료를 등록하려면 별도 디렉터리·자료 ID로 추가하고 실행 명세를 갱신한다.
기존 파일을 새 응답으로 덮어쓰지 않는다. `budget-plan.json`과 예산 검증 보고서는 이 재평가의 입력이 아니다.

## 재평가 의미

| 버전 | 사례 | 검색 측정 | 답변 측정 | 원본 실패 | 원본 완료 |
|---|---:|---:|---:|---:|---|
| v1 | 9 | 8 | 5 | 4 | false |
| v2 | 1 | 1 | 1 | 0 | true |

v1의 `fail`, `timeout`, `invalid-citation`은 답변 실패, `search-fail`은 검색 실패다.
`COMPLETED`는 저장 캡처의 재계산·보고서·점수 등록 완료를 뜻하며 원본 4건의 실패를 바꾸지 않는다.
v1의 검색 재현율 분모는 측정 7/대상 8, 인용 재현율은 4/8, 답변 상태 정확도는 5/9다.

모델명·trace ID는 당시 수집 기록이다. 저장된 trace ID에 재평가 점수를 연결하지만, 이전 CI의
임시 Langfuse 프로젝트가 현재 환경에도 존재한다는 의미는 아니다. 현재 모델 품질·운영 성능을
측정하거나 사람이 검토한 기준으로 승격하지 않는다. 공개 live 실행·유료 예약은 허용하지 않는다.

실행 방법은 [Ops의 등록 Core 캡처 재평가](../../README.md#등록된-core-캡처의-ops-재평가)를 따른다.
