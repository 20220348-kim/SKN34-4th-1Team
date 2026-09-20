# 지원사업 요청량·동시 실행 제한

4단계 3차 작업은 **공개 검색과 공고별 근거 답변의 요청 과다·동시 실행을 제한하는 기본 보호**다.
검색 품질·모델·점수·DB 스키마를 바꾸지 않으며 새 라이브러리나 Redis를 도입하지 않는다.

## 적용 범위와 기본값

`GET /api/v1/support-programs/search`, `POST /api/v1/support-programs/search`와
`POST /api/v1/support-programs/detail/answers`, `POST /api/v1/support-programs/conversation/interpret`가
한 Core 프로세스의 같은 한도를 공유한다. 검색 GET에 대한 HEAD 요청도 동일하게 처리한다.
C02 해석과 사용자 확인 후 검색은 서로 다른 HTTP 요청이므로 각각 한도를 사용한다.
기본 주소별 한도에서는 다른 요청이 없을 때 해석+검색 쌍을 최근 60초에 최대 3회 허용한다.

| 설정 환경변수 | 기본값 | 허용 범위 |
|---|---:|---:|
| `SUPPORT_PROGRAM_REQUEST_PER_CLIENT_PER_MINUTE` | 접속 주소별 최근 60초 6건 | 1~10,000 |
| `SUPPORT_PROGRAM_REQUEST_GLOBAL_PER_MINUTE` | 전체 최근 60초 60건 | 1~10,000 |
| `SUPPORT_PROGRAM_REQUEST_MAX_CONCURRENT` | 동시 처리 4건 | 1~100 |

이 값은 초기 보호 설정이지 부하 테스트로 입증한 적정 처리량이 아니다. `.env.example`과 Compose에
연결되어 있으며 네이티브 실행에서는 환경변수를 직접 주입한다. 잘못된 범위의 설정은 시작을 거부한다.

- 단순 분 단위 고정 구간이 아니라, 현재부터 거슬러 올라간 **최근 60초의 허용 요청**을 센다.
- 시간 측정은 `System.nanoTime()`을 사용하므로 서버 시각 보정으로 제한이 갑자기 풀리지 않는다.
- 빈 검색어의 최신 목록 조회도 검색 endpoint 한도에 포함한다. 이는 API 호출 횟수가 아니라 공개 요청 한도다.
- 입력 검증을 통과한 뒤 입장 여부를 검사한다. 입력 오류·OPTIONS 요청은 한도를 사용하지 않는다.
- 입장한 요청은 이후 실패·공고 없음·지원 불가가 되어도 분당 한도를 사용한다. 실패 반복으로 우회할 수 없다.
- 제한으로 거절된 요청은 카운터에 추가하지 않고 DB·검색·원문 수집·AI 작업을 시작하지 않는다.
- Health·검색 준비 상태·단순 공고 상세 조회는 이 한도를 사용하지 않는다.
- 백그라운드 동기화·색인·비웹 평가 명령은 공개 HTTP 제한 대상이 아니다.

## 실제 흐름

```text
HTTP 요청 및 입력 검증
  → 해당 기능의 Controller
  → SupportProgramRequestAdmissionService.execute(접속 주소)
      ├→ 최근 60초 한도 초과: 429, 하위 Service 호출 없음
      ├→ 동시 처리 한도 초과: 503, 대기열 없이 즉시 거절
      └→ 입장 허용
          → SearchService, EvidenceService 또는 ConversationService
          → 기존 Repository / Facade / Client 호출
          → 응답 또는 예외 발생 시 finally에서 동시 처리 슬롯 반환
```

판단·카운터 갱신만 짧은 동기화 구간에 두고 실제 작업은 그 밖에서 실행한다.
허용 요청의 시간·접속 주소와 주소별 횟수만 메모리에 저장하며, 최대 항목 수는 글로벌 분당 한도로 제한된다.
만료 항목은 다음 입장 검사 때 제거하고 거절된 새 주소는 저장하지 않는다. 접속 주소를 로그나 DB에 기록하지 않는다.
AI Service 내부 흐름은 기존 **HTTP API → Service → Agent → OpenAI → Response** 그대로다.

## 오류 계약과 화면

| 상황 | HTTP | code | 재시도 안내 |
|---|---:|---|---|
| 주소별 또는 전체 요청량 초과 | 429 | `SUPPORT_PROGRAM_RATE_LIMITED` | 해당 한도가 풀리기까지의 시간을 올림한 1~60초 |
| 동시 처리 한도 초과 | 503 | `SUPPORT_PROGRAM_BUSY` | 1초 후 재시도 권고 |

둘 다 `application/problem+json`, `Cache-Control: no-store`를 반환한다.
`Retry-After` 헤더와 본문의 `retryAfterSeconds`는 같은 정수다. 다른 요청이 계속 들어올 수 있으므로
이 시간이 지난 뒤의 성공을 보장하지 않는다. HTTP 429와 Retry-After 의미는
[RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)를 따른다.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Cache-Control: no-store
Retry-After: 60

{
  "type": "urn:govbiz:problem:support-program-rate-limited",
  "title": "Support Program Rate Limited",
  "status": 429,
  "detail": "Too many support program requests. Please retry later.",
  "instance": "/api/v1/support-programs/search",
  "code": "SUPPORT_PROGRAM_RATE_LIMITED",
  "retryAfterSeconds": 60
}
```

Frontend는 Data API에서 status·code·응답 형식을 확인한 뒤 Repository에서 HTTP와 무관한 Domain 오류로
변환한다. ViewModel은 서버 원문 오류를 출력하지 않고 요청 과다와 혼잡을 구분한 한국어 안내를 사용한다.
본문의 대기 시간이 정수 1~60이고 헤더와 일치할 때만 초 단위 안내를 표시한다. CORS는 `Retry-After`를 노출한다.
검색 대화·검색어·근거 질문은 보존하고 수동 재시도를 제공한다. 자동 재시도·카운트다운은 추가하지 않았다.
기존 AI 장애의 `503 AI_SERVICE_UNAVAILABLE`을 혼잡으로 바꾸거나 성공 결과로 숨기지 않는다.

## 접속 주소와 배포 한계

- 기본값 `server.forward-headers-strategy=none`에서 `HttpServletRequest.remoteAddr`를 사용한다.
  클라이언트가 보낸 `X-Forwarded-For`·`Forwarded`를 직접 읽지 않는다.
- **접속 주소는 사용자 신원이 아니다.** NAT·공유망·프록시 뒤의 사용자는 같은 한도를 공유할 수 있다.
  현재 Compose의 Vite 프록시 경로도 Core에는 프록시 주소로 보이므로 기본 6건을 공유한다.
  개발 시 필요하면 위 설정으로 조절하되 이를 사용자별 제한이라고 표현하지 않는다.
- 운영 프록시를 도입할 때는 Core 직접 접근을 차단하고, 프록시가 외부 전달 헤더를 제거·재작성하게 한 뒤
  신뢰할 프록시 주소를 제한해야 한다. 그 전에는 forwarded-header 전략만 켜지 않는다.
  [Spring Boot 프록시 설정 안내](https://docs.spring.io/spring-boot/how-to/webserver.html#howto.webserver.use-behind-a-proxy-server)를 참고한다.
- 카운터는 프로세스 메모리에 있으므로 재시작 시 초기화되며 서버를 여러 대 실행하면 각자 한도를 갖는다.
  다중 서버·실사용자별 제한은 공유 저장소 또는 신뢰 가능한 게이트웨이/인증 경계에서 별도로 설계해야 한다.
- 슬롯은 Core 작업 종료까지 유지한다. 브라우저 취소만으로 서버 작업이 즉시 취소되는 것은 아니다.
  Core timeout 후 이미 시작한 외부 작업의 취소까지 보장하는 전역 OpenAI 동시 호출 제한은 아니다.
- 이 보호는 DDoS 방어, 인증·권한 제어, 월별 비용 상한, 백그라운드 색인 비용 제한을 대체하지 않는다.
  AI Service는 기존 Compose처럼 내부에서만 접근하게 유지해야 한다.

## 검증

- Core: JDK 21 `./gradlew clean test --no-daemon` **321개 통과**, 실제 MySQL 8.4 Testcontainers 포함.
- 새 테스트는 주소별·전체 한도, 정확한 60초 경계, 주소 변경, 동시 진입 원자성, 즉시 혼잡 거절,
  예외·Error 후 슬롯 반환, 공유 한도, 요청 검증 우선, 전달 헤더 우회 거부와 비대상 endpoint 접근을 확인한다.
- Frontend: Node 24에서 전체 테스트 **144개**·빌드·lint 통과. 429/503 계약, 잘못된 대기 시간, 원문 오류 비노출,
  입력·대화 보존, 수동 재시도 및 실제 화면 안내를 검증한다.
- 테스트는 가짜 Service·HTTP 응답을 사용한다. 이번 작업에서 실제 OpenAI API를 호출하지 않는다.
- Compose의 기존 장애·복구 smoke는 반복 폴링 때문에 요청량 한도를 1,000으로 명시적으로 높인다.
  최초 요청 제한 커밋에서는 설정·스크립트 문법만 확인했으며, 후속 전체 실행 결과는 아래와 같다.

## 4단계 최종 통합 검증 (2026-09-06)

요청 제한 구현 커밋 `79c889b` 이후 전체 Compose 검증을 수행했다.

- 첫 실행은 후보 검색까지 성공했으나 추천 단계에서 `503 AI_SERVICE_UNAVAILABLE`로 실패했다.
  검증용 `infrastructure/stubs/openai/server.py`가 예전 배열형 `rankings`와 모델 생성 `totalScore`를 반환한 것이 원인이다.
- 스텁을 현재 Agent의 **공고 ID 키 기반 객체와 `targetAssessment`·`regionAssessment`** 계약에 맞췄다.
  실제 추천 Service의 합산·응답 검증·프롬프트·점수 기준은 바꾸지 않았다.
- 실제 스텁 Handler의 응답을 production Agent·Service로 검증하는 회귀 테스트 4개를 추가했다.
  후보 1개/20개, 관련 후보 있음/전부 무관, 한글·특수문자 ID 보존, 총점 합산과 무관 추천 제외를 확인한다.
- 수정 후 아래 명령으로 전체 스택을 다시 빌드·실행해 **종료 코드 0**을 확인했다.

```bash
VERIFY_COMPOSE_PROJECT_NAME=govbiz-verify-stage4-20260906 \
  bash infrastructure/scripts/verify-compose.sh
```

| 통합 확인 항목 | 결과 |
|---|---|
| Vite → Core 및 Core → AI Health | 200 |
| 기업마당 스텁 공고의 실제 MySQL 저장 | 성공 |
| 기업마당 스텁 중지 후 MySQL 최신 목록 | 200 |
| 최신 20개 밖의 관련 공고 검색·추천 | 200, 대상 공고·100점 확인 |
| Qdrant 중지 시 자연어 검색 / 최신 목록 | 각각 503 / 200 |
| Qdrant 재시작 후 저장된 색인으로 검색 복구 | 200 |
| SampleItem 준비 POST | 200 |
| AI Service 중지 시 Core Health / AI Health·검색 | 각각 200 / 504 |
| AI Service 재시작 후 Core 재시작 없이 Health·검색 복구 | 200 |

MySQL 8.4·Qdrant 1.17.1은 실제 컨테이너, 기업마당·OpenAI는 로컬 HTTP 스텁을 사용했다.
실제 OpenAI 키·유료 호출은 사용하지 않았으며, 실제 모델의 검색 품질을 새로 측정한 것은 아니다.
요청량 1,000/1,000·동시 처리 4 설정의 연결·장애 복구 검증이므로 기본 한도 도달이나 운영 처리량의 증거로 쓰지 않는다.
검증용 컨테이너·볼륨·네트워크는 종료 시 정리했고 기존 개발 스택·MySQL·Qdrant 볼륨은 유지했다.

추가로 AI Service 전체 **192개**와 `verify-shared-run.py --with-capture`의 원표·캡처·지표 재현 검사가 통과했다.
위 Core 321개·Frontend 144개는 요청 제한 구현 시의 결과다. 이번에는 해당 production 코드를 바꾸거나
두 서비스의 전체 테스트를 새로 실행하지 않았다. 원격 GitHub Actions 실행 성공을 주장하는 기록도 아니다.

**4단계의 합의한 범위인 측정 기반 검색 개선·전후 비교·요청 제한·최종 통합 검증을 완료했다.**
다음 개발은 5단계의 기존 공고별 RAG에 대한 답변·인용·근거 부족 응답 검증이다.
이미 확인된 오추천·응답 지연, 배포 경계 확정 후 프록시·서버 수·실제 동시 부하·제한값 측정은 별도 과제로 남긴다.
이 완료를 모든 오추천 해결, 사람 검증 품질 합격 또는 외부 공개 준비 완료로 해석하지 않는다.
