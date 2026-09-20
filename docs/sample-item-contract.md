# SampleItem 준비 API 계약

SampleItem은 GovBiz의 Frontend·Core API 계층 연결을 보여 주는 최소 예제입니다. 실제 업무
도메인을 추가할 때는 필요한 상태와 필드를 새로 정의하세요.

Frontend의 React Hook 예제와 Redux Toolkit 예제는 모두 이 endpoint를 사용합니다. 두 화면은 상태
수명만 다르며 요청·응답 계약과 Domain 변환 규칙은 동일합니다.

## Endpoint

```text
POST /api/v1/sample-items/prepare
Content-Type: application/json
```

## 요청

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `item.name` | string | 예 | 공백이 아닌 최대 100자 이름 |
| `item.category` | `BASIC` \| `EXTENDED` \| null | 아니오 | 예제 분류 |
| `item.note` | string \| null | 아니오 | 최대 500자 메모 |

```json
{
  "item": {
    "name": "Example item",
    "category": "BASIC",
    "note": "Shows a typed vertical slice."
  }
}
```

## 성공 응답

```json
{
  "phase": "READY_FOR_PROCESSING",
  "item": {
    "name": "Example item",
    "category": "BASIC",
    "note": "Shows a typed vertical slice."
  },
  "processing": {
    "status": "NOT_STARTED"
  }
}
```

성공했다고 실제 처리, 저장, 비동기 작업이 시작된 것은 아닙니다. 이 상태는 입력이 검증되었고 다음
단계가 사용할 수 있음을 보여 주는 예제입니다.

## 오류

필수 이름 누락, 공백 이름, 길이 초과 등 Bean Validation 오류는 `400`과 다음 형식의
`application/problem+json`을 반환합니다. 아래는 `item.name` 검증 실패의 예입니다.

```json
{
  "type": "urn:govbiz:problem:request-validation-failed",
  "title": "Request Validation Failed",
  "status": 400,
  "detail": "One or more request fields are invalid.",
  "instance": "/api/v1/sample-items/prepare",
  "code": "REQUEST_VALIDATION_FAILED",
  "errors": [{ "field": "item.name", "code": "INVALID_VALUE" }]
}
```

잘못된 JSON 문법·타입이나 알 수 없는 enum처럼 역직렬화 단계에서 실패하면 같은
`REQUEST_VALIDATION_FAILED` 코드와 HTTP 400을 반환하되, `detail`은
`The request body is invalid.`, `errors`는 빈 배열입니다. JSON 이외의 지원하지 않는
Content-Type은 HTTP 415와 `UNSUPPORTED_MEDIA_TYPE` 코드를 반환합니다.

Frontend는 Zod로 성공 응답을 검증하고, Core API는 Bean Validation과 JSON 역직렬화 설정으로 요청을
검증합니다.
