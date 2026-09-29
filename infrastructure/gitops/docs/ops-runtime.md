# Ops와 Compose 평가 실행 환경의 연결 계약

Prefect·평가 실행기·결과 저장소는 기존 Compose에서 유지하고 Kubernetes에는 Ops API를 둔다.
이 배치 방향은 사용자가 선택했다. 현재 커밋은 **Core 주소 수정과 연결 진단**을 구현하며,
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
| results_directory | 결과 디렉터리 읽기 가능 여부. 새로 만들거나 쓰기 테스트를 하지 않음 |
| prefect_deployment | 설정된 이름의 deployment UUID·flow UUID·이름·중지 여부 확인 |
| result_artifact | run_id가 있으면 완료 DB 기록에 연결된 기존 결과 검증을 실행. 없으면 NOT_CHECKED |

Prefect 등록 확인은 [공식 조회 API](https://docs.prefect.io/v3/api-ref/rest-api/server/deployments/read-deployment-by-name)를 사용한다.
등록돼 있다는 사실은 실행기가 살아 있다는 증거가 아니다.

응답의 `scope`는 `deployment_configuration`이다. `status: PASS`는 위 검사 범위만 의미한다.
`evaluation_executed`, `runner_liveness_verified`, `shared_volume_identity_verified`는 false다.
`result_artifact_verified`는 지정한 완료 실행의 결과를 실제 검증했을 때만 true다.
빈 디렉터리 또는 과거 결과 파일의 사본을 실제 공유 volume이나 새 평가 실행 성공으로 간주하지 않는다.
DB 연결·migration·스키마 준비는 별도의 [Ops readiness](ops-migration.md)가 담당한다.

## 실제 연결의 남은 조건

1. 승인된 후보의 Prefect 주소를 Kubernetes Pod에서 접근 가능한 전용 내부 주소로 정한다.
   현재 Compose의 loopback 포트를 외부 전체 인터페이스로 바꾸어 해결하지 않는다.
2. Compose 평가 실행기는 결과에 쓰고 Ops API는 같은 결과에 읽기만 가능한 저장소를 연결한다.
   Compose named volume은 Kubernetes PVC와 자동으로 공유되지 않는다. 현재 hostPath 금지 정책을
   임의로 풀거나 기존 데이터 volume을 삭제·교체하지 않는다.
3. 실행 release에 맞는 자료를 읽기 전용으로 제공한다. 단순 디렉터리 존재가 아닌 해시로 검증한다.
4. `ops-sync`의 배치·Ops DB 접근 책임도 정한다. 기존 Compose의 별도 Ops DB에 연결된
   동기화 프로세스를 Kubernetes Ops DB용으로 그대로 재사용하지 않는다.
5. 새 격리 환경에서 Core 관리자 인증 → 무료 저장 캡처 평가 → 목록 자동 갱신 → 결과 조회 →
   재시작 후 유지까지 확인한다. 진단 응답만으로 이 E2E를 대체하지 않는다.

기존 Compose 평가 CI는 완료된 무료 실행에 대해 새 진단 API를 호출하고 모든 검사 통과 및
결과 검증 여부를 확인한다. 이는 Compose 내부 통합 증거이며 Kubernetes↔Compose 연결 증거가 아니다.
