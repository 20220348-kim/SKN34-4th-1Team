# 실제 검색 평가 실행과 중단 기록

**3단계 미완료.** 고정 질문 16개의 실제 검색을 시작했지만 첫 질문 `Q01`의 AI 추천 응답이 검증을
통과하지 못했다. 성공한 전체 capture·Recall·MRR 보고서는 없다. 오류를 빈 검색 결과로 바꾸거나
저장된 AI 판정으로 실제 검색 결과를 대신 만들지 않았다.

## 확인한 실행 조건

- 기준일 `2026-09-06`, `acceptingOnly=true`, 공고 전체 1,506건 / 적격 1,422건.
- 실제 MySQL을 기존 fixture-export로 내보내 고정 fixture의 이름·기준일·catalog·전체 docs를 비교했다.
  ID·본문·contentHash·sortTimestamp 모두 일치했다. Qdrant에도 정확한 ID+contentHash 버전 1,422개가 있었다.
- DB는 읽기 전용 세션으로 연결했고 Flyway·공고 동기화·색인 복구 스케줄러를 비활성화했다.
  공고 재수집·DB 수정·추가 공고 임베딩·벡터 삭제는 하지 않았다.
- 사용자에게 질문·공개 후보 공고의 OpenAI 공식 API 전송 승인을 받은 뒤 실행했다.
  키는 환경변수로 주입했고 인증 헤더·키·DB 비밀번호를 기록하지 않았다.
- Core / 수정 전 AI 소스: `d92bf4ee265dd779f9cfd502cee6093969c9c47a`.
- OpenAI `gpt-5.6-luna`, 임베딩 `text-embedding-3-small` / 1536차원. 모델 접근 조회도 성공했다.
- 실행 패키지: openai 3.3.1, openai-agents 0.22.0, qdrant-client 1.17.1, tiktoken 0.12.0, FastAPI 0.139.2.

## 실행 결과

| 시도 | 모델 / Agent / Core 읽기 제한 | 결과 |
| --- | --- | --- |
| 기본 설정 | 8초 / 10초 / 12초 | Q01 후보 검색 성공, 추천 503. 원인·토큰 미관측 |
| 진단 설정 | 25초 / 30초 / 35초 | OpenAI HTTP 200, SDK ModelBehaviorError. 해당 응답의 구체적 실패 필드는 미보존 |
| Q01만 진단 | 25초 / 30초 / 35초 | OpenAI 완료 응답에서 후보 20개 중 19개 반환. Service가 누락 거부 |
| 후보 개수 제약 수정 후 | 25초 / 30초 / 35초 | 20개 반환. 총점 불일치 2건·대상 부적합 점수 모순 1건으로 실패 |

각 시도는 Q01에서 즉시 중단했다. Q02~Q16은 호출하지 않았다. 서로 다른 시도의 오류를 같은 원인으로
단정하지 않는다. 실패하면 capture 파일을 만들지 않는 기존 보호 동작은 유지됐다.

생성·임베딩 요청은 합계 **8회 시도**(질문 임베딩 4회, 추천 4회), 읽기 전용 모델 조회는 별도 1회다.
공고 벡터 생성은 0회다. 첫 시도 사용량은 관측하지 못했으므로 뒤의 토큰만 더해 전체 요금으로 표현하지 않는다.
실제 청구 금액은 확인하지 않았다. 상세 시간·사용량은 [실행 기록](failed-attempts.json), 마지막 시도의
원응답 사용량은 [사용량 로그](fixed-count-usage.jsonl)에 보관했다.

## 수정한 범위와 남은 결함

Agent의 strict output `rankings`를 매 요청 후보 수에 맞춘 `minItems=maxItems=n`으로 제한했다.
기존 출력 모델의 validator와 Service의 ID exact-set 검증을 유지하고 요청별 Agent 복사본을 사용한다.
모델·점수 정책·프롬프트·기본 timeout·공개 HTTP 계약은 변경하지 않았다. 긴 timeout은 이번 진단 실행만의 설정이며
실서비스 기본 설정에서 안정성을 검증했다는 뜻이 아니다.

실제 관측한 잔여 오류:

- `BIZINFO:PBLN_000000000121799`: 세부 점수 합은 81인데 totalScore는 80.
- `BIZINFO:PBLN_000000000126164`: 세부 점수 합은 38인데 totalScore는 28.
- `BIZINFO:PBLN_000000000125877`: targetEligibility가 INCOMPATIBLE인데 targetFit는 4.

다음 작업은 **기계적으로 계산할 총점과 조건부 점수를 모델이 중복 생성하지 않도록 책임을 정리하는 것**이다.
총점 검증을 삭제하거나 모순된 자격을 MATCH로 바꾸는 방식은 사용하지 않는다. 이 변경은 아직 구현하지 않았다.
수정·오프라인 재현 후 새 버전으로 실제 capture를 실행하고, 성공했을 때만 새 후보 판정·최종 품질 측정으로 진행한다.

## API 없이 실패 응답 재현

[19개 응답](diagnostic-output-19.json)과 [20개 응답](fixed-count-output-20.json)은 실제 모델 출력에서 추출한
진단 근거다. **정답 라벨·성공한 추천·전체 검색 capture가 아니다.** 공유 데이터에 키·헤더·원문 요청은 없다.
AI Service 의존성이 설치된 환경에서 저장소 루트 기준으로 실행한다. 이 명령은 `.env`를 읽거나 API를 호출하지 않는다.

```bash
PYTHONPATH=backend/ai-service backend/ai-service/.venv/bin/python - <<'PY'
import json
from pathlib import Path
from pydantic import Field, TypeAdapter, ValidationError, create_model
from app.support_program_ranking.models import ScoredSupportProgram, SupportProgramRankingOutput

base = Path("evaluation/support-program-search/runs/support-program-catalog-20260906-v1/actual-capture-v1")
bound = create_model("TwentyCandidates", __base__=SupportProgramRankingOutput,
    rankings=(list[ScoredSupportProgram], Field(min_length=20, max_length=20)))
for name in ("diagnostic-output-19.json", "fixed-count-output-20.json"):
    raw = (base / name).read_text(encoding="utf-8")
    print(name, len(json.loads(raw)["rankings"]))
    try:
        TypeAdapter(bound).validate_json(raw, strict=True)
        raise AssertionError("Saved invalid output unexpectedly passed")
    except ValidationError as error:
        print(error.errors(include_input=False, include_context=False, include_url=False))
PY
```

AI Service 전체 테스트 163건, 평가/검토 도구 135건, 기존 공유 판정 재현 검증과 `git diff --check`가 통과했다.
이는 코드·실패 재현 검증이며 실제 검색 품질 통과를 의미하지 않는다. 평가용 프로세스는 종료하고,
이 작업에서 시작한 MySQL·Qdrant도 데이터를 보존한 채 원래의 중지 상태로 돌렸다.
