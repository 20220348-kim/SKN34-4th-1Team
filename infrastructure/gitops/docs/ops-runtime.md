# Ops와 Compose 평가 실행 환경의 연결 계약

Prefect·평가 실행기·결과 저장소는 기존 Compose에서 유지하고 Kubernetes에는 Ops API를 둔다.
이 배치 방향은 사용자가 선택했다. 현재 구현은 **연결 진단과 선택 가능한 내부 HTTP 저장소 조회**를 제공하며,
Compose 결과 볼륨이 Kubernetes에 자동 공유되거나 두 환경의 통신이 개통된 상태는 아니다.

## 명시적인 설정

새 로컬 values와 후보 생성용 portfolio 템플릿은 다음 값을 선언한다.
과거에 승인된 snapshot·이미지 digest는 직접 수정하지 않는다.

| 설정 | 기본값과 의미 |
| --- | --- |
| CORE_API_URL | `http://core-service:8080`: Kubernetes 내부 Core 관리자 인증 |
| DJANGO_COOKIE_SECURE | `false`: loopback HTTP 개발용 CSRF 쿠키. 외부 HTTPS 운영 설정과 구분 |
| OPS_WEB_URL | `http://localhost:5173`: 개발 웹 화면 |
| PREFECT_API_URL | `http://disabled-prefect.invalid/api`: 미연결 상태를 명시 |
| PREFECT_UI_URL | `http://localhost:14200`: 사용자 브라우저의 Prefect 주소 |
| LLMOPS_EVIDENCE_DIR | `/evaluation-data`: 버전과 해시가 일치하는 읽기 전용 평가 자료 |
| LLMOPS_RESULTS_DIR | `/results`: 실행기가 기록하고 Ops가 읽는 결과 경로 |
| LLMOPS_ARTIFACT_URL | 빈 값은 파일 방식. HTTP 모드는 결과·평가 자료를 모두 지정한 내부 서버에서 조회 |
| LLMOPS_ARTIFACT_TOKEN | HTTP 모드의 별도 읽기 전용 인증값. Git values가 아닌 `ops-runtime` Secret과 `secretKeys`로 주입 |
| LLMOPS_LIVE_ENABLED | `false`: 공통 bootstrap에서 유료 실행 금지 |

Core 인증은 기존 `govbiz_session` 쿠키를 Core `/api/v1/admin/session`에 전달한다.
Django가 자체 관리자 계정을 인증 근거로 사용하지 않는다.
values를 추가한 것만으로 자료나 결과 volume이 생기지는 않는다.

## 읽기 전용 진단

관리자 로그인 후 `GET /api/v1/ops/runtime`을 호출한다.
완료된 실행의 결과까지 대조하려면 `?run_id=<실행 UUID>`를 지정한다.
미인증 401·비관리자 403·Core 장애 503을 유지하며 응답을 캐시하지 않는다.
API는 진단 실패에 503을 반환한다. 이 경로를 Kubernetes probe에 연결하지 않는다.

컨테이너 안에서는 같은 검사 함수를 관리 명령으로 실행할 수 있다.

```bash
python manage.py check_evaluation_runtime
python manage.py check_evaluation_runtime --run-id <완료된-실행-UUID>
```

관리 명령은 서버 운영자용이며 Core 로그인 검사를 수행하지 않는다.
JSON 결과를 출력하고 검사 실패 시 비정상 종료한다.
API 인증 이외에 새로운 평가 접수·파일 생성·DB 수정·유료 호출을 하지 않는다.

| checks 항목 | 검사 내용 |
| --- | --- |
| evidence | 허용 목록·실행 release의 자료·사례 ID·캡처 목록 일치, 실제 파일 SHA-256, 자료 디렉터리 이탈 차단 |
| results_directory | 파일 모드는 결과 디렉터리, HTTP 모드는 인증된 저장소 상태 조회. 생성·쓰기 없음 |
| prefect_deployment | 설정된 이름의 deployment UUID·flow UUID·이름·중지 여부 확인 |
| result_artifact | run_id가 있으면 완료 DB 기록에 연결된 기존 결과 검증을 실행. 없으면 NOT_CHECKED |

Prefect 등록 확인은 [공식 조회 API](https://docs.prefect.io/v3/api-ref/rest-api/server/deployments/read-deployment-by-name)를 사용한다.
등록돼 있다는 사실은 실행기가 살아 있다는 증거가 아니다.

응답의 `storage_transport`는 `filesystem` 또는 `http`다. 기존 `results_directory` 검사 키는 호환성을 유지한다.
응답의 `scope`는 `deployment_configuration`이다. `status: PASS`는 위 검사 범위만 의미한다.
`evaluation_executed`, `runner_liveness_verified`, `shared_volume_identity_verified`는 false다.
`result_artifact_verified`는 지정한 완료 실행의 결과를 실제 검증했을 때만 true다.
빈 디렉터리 또는 과거 결과 파일의 사본을 실제 공유 volume이나 새 평가 실행 성공으로 간주하지 않는다.
DB 연결·migration·스키마 준비는 별도의 [Ops readiness](ops-migration.md)가 담당한다.

## Compose 결과·평가 자료의 HTTP 조회

`Ops API / ops-sync → 인증된 ops-artifacts → Compose 결과 볼륨·평가 자료`로 읽는다.
평가 실행기는 기존 결과 볼륨에 계속 기록한다. Ops에 결과 디렉터리나 PVC를 복제하지 않는다.
`ops-artifacts`는 같은 Ops 이미지의 별도 Gunicorn 프로세스이며 Django·DB·평가 SDK를 시작하지 않는다.
새 production 패키지나 외부 저장소는 추가하지 않았다.

[compose.artifacts.yaml](../../llmops/compose.artifacts.yaml)은 명시적으로 선택하는 무료 검증 구성이다.
결과 서버는 호스트 포트를 공개하지 않고, 두 입력 mount와 컨테이너 파일시스템을 읽기 전용으로 둔다.
Ops API·동기화 컨테이너의 파일 mount는 모두 제거하고 실행기의 유료 실행과 모델 키는 비활성화한다.
[실행 방법](../../llmops/README.md#내부-http로-결과-조회)을 따른다.

- 서버와 클라이언트는 별도의 무작위 토큰을 사용한다. 예산 승인 토큰·Core 세션과 공유하지 않는다.
- `GET /v1/status`, 허용된 UUID 아래 결과 파일 8종, 카탈로그에 등록된 평가 자료만 읽는다.
  디렉터리 목록·임의 경로·업로드·수정·삭제 API는 제공하지 않는다.
- 파일당 최대 8 MiB, 클라이언트 HTTP timeout 3초다. 경로 이탈·심볼릭 링크·비정규 파일을 거절한다.
  Linux 서버는 디렉터리 descriptor와 `O_NOFOLLOW`로 검사 중 경로가 바뀌는 경우도 차단한다.
- 리다이렉트와 환경변수 HTTP proxy를 사용하지 않는다. 토큰·원격 오류 본문을 공개 Ops 응답에 싣지 않는다.
- HTTP가 설정돼 있으면 누락·인증 실패·불완전 응답을 로컬 사본으로 대체하지 않는다.
- 보고서·비교 결과·검토 자료·복구 입력의 기존 ID·실행 명세·SHA-256 검증을 유지한다.
  보고서는 해시를 확인한 바로 그 바이트를 기존 sandbox CSP로 반환한다.
- 공유 복구 입력 코드가 바뀌어 pipeline 실행 해시를 갱신했다. Ops와 실행기는 같은 release로 배포해야 한다.
  과거에 접수한 명세를 새 실행기 명세로 임의 변경하지 않는다.

이 구성의 HTTP는 신뢰하는 전용 내부 개발 네트워크를 전제로 한다. 외부·공유 네트워크에 노출할 때는
TLS·접근 제한을 갖춘 별도 주소를 승인된 배포 후보에 반영해야 한다. Kubernetes Pod가 Compose DNS 이름을
자동으로 해석한다고 가정하지 않는다. 새 URL과 Secret 참조는 PR 리뷰 후 수동 병합으로 승인한다.

## 실제 연결의 남은 조건

1. Kubernetes Pod에서 Compose Prefect와 결과 HTTP 서버로 접근할 전용 내부 주소·DNS·접근 경로를 구성한다.
   현재 Compose의 loopback 포트를 전체 인터페이스로 바꾸어 해결하지 않는다.
2. 새 Ops 배포 후보에 해당 URL과 별도 인증 Secret 참조를 반영한다. 실제 결과 볼륨은 Compose에 남긴다.
   hostPath 허용·기존 volume 삭제·스토리지 이관 없이 새 실행 결과 조회를 검증한다.
3. 실행 release에 맞는 평가 자료가 HTTP로 전달되는지 해시로 확인한다.
4. `ops-sync`의 Kubernetes 배치·Ops DB 접근 책임을 연결한다. 현재 Compose 동기화 프로세스는
   여전히 Compose Ops DB를 사용하므로 Kubernetes Ops DB의 동기화를 대신하지 않는다.
5. 새 격리 환경에서 Core 관리자 인증 → 무료 저장 캡처 평가 → 목록 자동 갱신 → 결과 조회 →
   재시작 후 유지까지 확인한다. 진단 응답만으로 이 E2E를 대체하지 않는다.

LLMOps CI는 HTTP overlay와 실제 Compose 병합 검사를 사용한다. Ops에 파일 mount가 없는 상태에서
무료 평가·완료 결과 진단·비교·후처리 복구를 검증하고 `storage_transport=http`를 확인한다.
기존 파일 방식은 Ops 테스트와 취소 통합 검증에 유지한다. 이는 Compose 내부 HTTP 통합 검증이며,
Kubernetes↔Compose 통신 또는 Argo 동기화 완료의 증거는 아니다. 새 변경의 CI 결과는 푸시 후 확인한다.
