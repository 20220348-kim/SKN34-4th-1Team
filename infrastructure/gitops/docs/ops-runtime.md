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

- 서버와 클라이언트에 같은 전용 무작위 토큰을 설정한다. 예산 승인 토큰·Core 세션과 공유하지 않는다.
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
자동으로 해석한다고 가정하지 않는다. 새 URL과 Secret 참조는 기존 개발 PR에서 필수 검사를 통과한 뒤 반영한다. 별도 배포 PR은 만들지 않는다.

## Kubernetes Ops 상태 동기화

Helm의 `opsSync.enabled` 기본값은 `false`다. 연결 설정을 준비한 뒤 `true`로 선택하면
`ops-service` Deployment의 **같은 Pod**에 `ops-sync` 일반 컨테이너가 추가된다.
기존 `python manage.py sync_evaluations --watch`를 실행하며 새 평가나 모델 호출을 접수하지 않는다.
실행 흐름은 `Ops migration Job 완료 → Ops API + ops-sync → Compose Prefect·결과 HTTP 조회 → Kubernetes Ops DB 갱신`이다.
Prefect·평가 실행기·결과 볼륨은 Compose에 유지한다.

- API와 같은 이미지·DB 환경변수·`ops-runtime` Secret 참조·보안 설정을 사용한다.
  별도 DB, Kubernetes Service, hostPath, production 패키지를 추가하지 않는다.
- `replicas: 1`, `Recreate`를 유지한다. migration Job에는 동기화 컨테이너를 넣지 않는다.
  동일 Pod의 일반 컨테이너는 시작 순서를 보장하지 않으므로 둘 사이의 시작 순서에 의존하지 않는다.
  [Kubernetes의 다중 컨테이너 Pod 설명](https://kubernetes.io/docs/concepts/workloads/pods/)을 따른다.
- 두 컨테이너 각각에 기존 Ops resources를 적용한다. 활성화 시 Ops Pod의 CPU·메모리 요청량과 제한량은
  기존 API 컨테이너의 두 배가 되므로 클러스터 용량을 확인한다.
- 기본 10초 주기·최대 25개 실행의 기존 동기화 명령을 재사용한다. DB 오류로 종료되면 Kubernetes가
  재시작하며 SIGTERM/SIGINT 종료 처리를 유지한다. API용 HTTP probe를 동기화 컨테이너에 복사하지 않는다.
  Pod Ready·rollout 성공만으로 동기화 진척, Prefect 실행기 생존 또는 실제 결과 조회를 증명하지 않는다.
- `dev.py`의 이미지 갱신·실패 복구·원래 이미지 복원은 두 컨테이너를 한 번에 변경한다.
  두 이미지가 이미 다르거나 알 수 없는 컨테이너가 있으면 변경을 거절한다.

연결 values의 형태는 다음과 같다. 아래 `.internal` 주소는 형식 예시이며 저장소에서 이 DNS를 제공하지 않는다.
실제로 Pod에서 접근 가능한 전용 내부 주소로 바꿔 기존 개발 변경에 포함한다.

```yaml
opsSync:
  enabled: true
env:
  PREFECT_API_URL: http://prefect.internal:4200/api
  LLMOPS_ARTIFACT_URL: http://artifacts.internal:8010
secretName: ops-runtime
secretKeys: [DJANGO_SECRET_KEY, DB_PASSWORD, LLMOPS_ARTIFACT_TOKEN]
```

`secretKeys`는 Helm에서 배열 전체를 교체하므로 기존 필수 키를 함께 선언한다.
토큰 값은 Git·values에 넣지 않고 namespace의 기존 `ops-runtime` Secret에 주입한다.
유효한 HTTP(S) 주소·토큰 참조가 없거나 `.invalid`·loopback·URL 내 인증값을 지정하면 Helm 렌더링을 거절한다.
참조 존재·DNS·실제 인증 성공까지 오프라인 렌더링이 확인하지는 않는다.

무료 검증은 `scripts/test_ops_sync.py`에서 실제 Helm 렌더링, 설정 누락 거절, API/동기화 이미지·DB·Secret 일치,
migration 분리, 이미지 교체·실패 복구를 검사한다. 활성화 후에는 관리자 런타임 진단과 **새 무료 평가**의
자동 상태 갱신·완료 결과 검증을 별도로 수행해야 한다. Compose의 `ops-sync`가 Kubernetes DB 동기화를
대신하지 않으며, 두 환경이 실수로 서로 다른 Ops API·DB에 평가를 접수하지 않는지도 확인한다.

## 로컬 kind와 Compose의 전용 통신 경로

`compose.kind.yaml`과 `scripts/ops_bridge.py`는 기존 개인 개발 kind 클러스터와 같은 Docker Engine의
Compose를 연결한다. WSL2/Linux·Intel Mac의 `dev` 모드용이며 Argo가 소유한 환경에는 적용하지 않는다.
기존 `fork_cluster.py init/up`으로 준비된 상태·kubeconfig·클러스터 소유권 표시가 필요하다.
Docker의 `network connect --gw-priority`를 지원하는 Engine을 사용한다(검증 기준 29.6.2).

연결 흐름은 `Ops Pod → ClusterIP 서비스 → EndpointSlice → Docker 내부 네트워크 → Compose HTTP 서버`다.
[Docker 내부 네트워크](https://docs.docker.com/reference/compose-file/networks/#internal)에는 Prefect,
`ops-artifacts`, 해당 kind 노드만 참가한다. 다른 kind 클러스터가 공유하는 기본 네트워크를 통신 경로로 쓰거나
호스트에 새 포트를 열지 않는다. Prefect의 기존 UI 포트는 loopback에 유지한다.
Kubernetes는 [selector 없는 Service와 EndpointSlice](https://kubernetes.io/docs/concepts/services-networking/service/#services-without-selectors)를
사용해 클러스터 외부 서버에 고정된 이름을 제공한다. Compose DNS 이름을 Pod에 그대로 전달하지 않는다.

저장소 루트에서 실행한다. 기본 `.env`·`.env.ops`·`.env.artifacts`는 앞의 Compose 절차로 준비하며
기존 비밀값과 볼륨을 유지한다. 다음 `govbiz-llmops`는 실제 연결할 Compose 프로젝트 이름과 일치해야 한다.

```bash
python3 -B infrastructure/gitops/scripts/ops_bridge.py env \
  > infrastructure/gitops/.local/fork/ops-bridge.env

dc_bridge() {
  docker compose --project-name govbiz-llmops \
    --env-file infrastructure/llmops/.env \
    --env-file infrastructure/llmops/.env.ops \
    --env-file infrastructure/llmops/.env.artifacts \
    --env-file infrastructure/gitops/.local/fork/ops-bridge.env \
    -f infrastructure/llmops/compose.yaml \
    -f infrastructure/llmops/compose.ops.yaml \
    -f infrastructure/llmops/compose.artifacts.yaml \
    -f infrastructure/llmops/compose.kind.yaml --profile evaluation "$@"
}
dc_bridge config --format json | python3 infrastructure/llmops/check_artifact_compose.py
dc_bridge up -d --no-deps prefect ops-artifacts
python3 -B infrastructure/gitops/scripts/ops_bridge.py connect --compose-project govbiz-llmops
python3 -B infrastructure/gitops/scripts/ops_bridge.py check --compose-project govbiz-llmops
```

연결 도구는 토큰을 읽거나 애플리케이션을 자동 변경하지 않는다. 클러스터·Docker 노드·Compose 프로젝트·
네트워크 state ID·참가자·포트·현재 IP·Pod/Service CIDR 중복과 기존 Kubernetes 리소스 소유권을 검사한 뒤 경로만 만든다.
다른 소유자의 동명 Service/EndpointSlice를 인수하지 않고, 기존 Service는 변경하지 않는다.
EndpointSlice 갱신에는 `resourceVersion`을 사용하며 연결 중 컨테이너 교체를 감지하면 실패한다.
도구는 bootstrap·개발 이미지 watcher와 같은 작업 잠금을 사용한다.
`check`는 경로 조회 후 Docker 토폴로지를 다시 읽어 검사 도중 컨테이너가 교체되었는지도 확인한다.
Docker·Kubernetes 조회와 개발 모드 소유권 조회는 명령당 15초, 연결·경로 쓰기는 명령당 60초로 제한한다.
시간 초과는 종료 코드 1이며 HTTP 통신 성공으로 처리하지 않는다. `connect` 중 시간 초과라면 일부
변경이 이미 반영되었을 수 있으므로 현재 상태를 먼저 확인한다. `check`는 경로를 수정하지 않는다.
Docker가 응답하지 않으면 [읽기 전용 상태 진단](../../../docs/local-fork-development.md#실제-배포-이미지와-준비-상태-확인)으로
Kubernetes와 디스크 상태를 별도로 확인한다. Docker 복구 전에는 컨테이너 교체 후 IP 일치 여부를 확정할 수 없다.

생성되는 `.local/fork/ops-bridge-values.json`은 비밀값 없는 다음 설정을 제공한다.

- Prefect: `http://ops-compose-prefect:4200/api`
- 결과 서버: `http://ops-compose-artifacts:8010`
- `opsSync.enabled=true`, `LLMOPS_LIVE_ENABLED=false`, 기존 Ops 필수 Secret 키와 artifact 토큰 참조

로컬 소스 이미지로 초기화한 `dev` 환경에서는 다음 명령으로 적용한다. 실행기는 먼저 시작해 둔다.
`--artifact-env`는 Compose 결과 서버에 사용한 소유자 전용 0600 파일을 지정한다.

```bash
dc_bridge up -d --build langfuse-worker evaluation-runner
python3 -B infrastructure/gitops/scripts/ops_runtime.py \
  --artifact-env infrastructure/llmops/.env.artifacts
python3 -B infrastructure/gitops/scripts/fork_cluster.py web
```

활성화 도구는 `ops-bridge.json`의 repository·state·namespace·Compose 프로젝트와 현재 연결 주소,
변조되지 않은 values, 로컬 이미지 baseline, 현재 Ops DB 주소·계정·Secret 참조를 검사한다.
결과 서버에서 토큰 인증을 확인한 뒤 기존 `ops-runtime`에 artifact 토큰 키만 추가한다.
DB 비밀번호·Django 키를 재발급하지 않으며 기존 artifact 토큰이 다르면 회전을 거절한다.
Secret 쓰기는 [resourceVersion을 통한 동시 갱신 검사](https://kubernetes.io/docs/reference/using-api/api-concepts/)를 사용한다.
migration → API+sync 적용 → rollout → 읽기 전용 런타임 진단 순서로 실행하며, migration 실패 시 API를 적용하지 않는다.

### 소스와 실행 환경의 버전 점검

갱신 전 접수 제어·미완료 평가·열린 예산 예약·Prefect 작업과 활성 스케줄은 `ops_runtime.py --preflight`로
읽기 전용 점검한다. 기존 연결의 재활성화도 이 검사가 통과해야 Secret·migration·workload 변경을 진행한다.
운영자가 접수를 중지한 뒤 지원 여부·중지 상태·버전을 모두 확인해야 통과한다. 접수 제어가 없는
구버전은 남은 작업이 없어도 `admission_control_unsupported`로 차단하며 현재 자동 갱신 대상이 아니다.
Prefect 직접 접수 통제·일관된 백업은 별도이며 [갱신 절차와 검사 범위](../../../docs/ops-upgrade-runbook.md)를 따른다.
무료 CI 통합 검증은 일회용 Ops 전체 DB를 네트워크가 없는 별도 MySQL 8.4에 복원하고
스키마·행·migration·외래 키 제약과 원본 보존을 확인한다. 보고서의 `database_restore`는
이 DB 훈련 범위이며 개인 환경이나 결과 볼륨·Prefect 복원 완료를 의미하지 않는다.
같은 Ops 이미지의 조회 컨테이너를 복원 DB에만 연결하고, SELECT 전용 계정으로 실제 Django
readiness와 완료 평가 3건의 ORM 조회·응답 직렬화·실행 명세 해시를 확인한다.
DB 쓰기 거절·검사 전후 덤프 무변경·정리 성공도 필수다. 이때 웹 서버나 Core 로그인은 실행하지 않으며,
`database_restore.application`은 관리자 화면·HTTP 인증 검증을 대신하지 않는다.
이후 `volume_restore` 단계는 같은 시험 프로젝트의 쓰기 프로세스를 중지하고 결과·Prefect 볼륨을 각각
새 격리 볼륨에 복원한다. 원본 읽기 전용 연결, 전체 파일 해시·권한, 인증 보고서와 완료 실행 연결,
SQLite WAL·무결성·이력 및 정리 성공을 확인한다. 복원된 결과 볼륨만 읽기 전용으로 연결한
별도 UID/GID 10001 컨테이너에서 실제 결과 서버를 기동해 인증된 보고서 해시·401·쓰기 거절을 확인한다.
일회용 검사 토큰을 사용하므로 기존 키 복구를 증명하지 않으며 원본 볼륨·자격 증명은 전달하지 않는다.
복원 DB는 이 단계가 끝날 때까지 유지하고, 별도 Ops HTTP 검사 컨테이너가 SELECT 전용 계정과
복원 결과 서버를 함께 사용해 보고서 3건을 조회한다. 실제 Ops 인증 코드는 유지하되 Core 세션 응답만
로컬 테스트 서버로 재현한다. 무인증·일반 사용자 거절, 결과/인증 서버 중단 시 오류, 파일·DB 무변경을
확인하며 `results.ops_http`에 기록한다. 실제 Core 로그인·관리자 화면 검증을 뜻하지 않는다.
같은 이미지의 Prefect API도 격리 기동해
실행·배포·상태 이력을 재조회하고 종료 후 DB 무변경을 대조한다. 스케줄러·migration·실행기는 시작하지 않는다.
개인 환경 백업·키 복구·업그레이드 완료를 증명하지 않는다. 세부 범위는 위 갱신 절차의 복원 검증 절을 따른다.

`main`을 갱신해도 이미 실행 중인 이미지가 자동으로 바뀌지는 않는다. 기존 개인 환경을 다시 사용할 때는
다음 읽기 전용 점검으로 현재 체크아웃과 실행 환경을 대조한다. WSL2/Linux에서 실행하며 artifact env 파일은 필요 없다.

```bash
python3 -B infrastructure/gitops/scripts/ops_runtime.py --check \
  --state-dir /기존/개인/state/경로

# 과거 완료 평가의 결과까지 검증
python3 -B infrastructure/gitops/scripts/ops_runtime.py --check \
  --state-dir /기존/개인/state/경로 \
  --run-id <완료된-평가-UUID>
```

- 현재 소스의 실행 release가 최신인지 검증한 뒤 API·sync·Compose 실행기·결과 서버의 SHA-256과 비교한다.
  이전 버전끼리 서로 일치하는 경우도 현재 소스와 다르면 실패한다.
- 활성화 기록·브리지·baseline 소유권, API/sync 이미지와 실제 Pod의 ReplicaSet 소유 관계·준비 상태를 확인한다.
  점검 중 Pod·컨테이너·실행기·경로·baseline이 바뀌면 성공을 반환하지 않는다.
- API·sync·실행기의 무료 설정과 모델 키 미설정을 확인한다. DB migration 이력뿐 아니라 실제 모델 컬럼도 검사한다.
- 기존 런타임 진단으로 평가 자료·Prefect 등록·결과 HTTP 연결을 확인한다. `--run-id`는 완료된 결과를 읽어서 검증한다.
- 클러스터·DB·컨테이너 설정을 변경하거나 Secret 리소스를 읽거나 비밀값을 출력하지 않는다.
  migration·평가 접수·모델 호출·상태 보정은 하지 않는다.
  동일 작업의 충돌 방지를 위한 로컬 작업 잠금은 사용한다.
- `--check`는 `--artifact-env`·`--ops-image`와 함께 사용할 수 없다. 실패 시 자동으로 재배포하지 않는다.

성공 범위는 `local_ops_release_and_configuration`이다. 새 평가 실행이나 Core 관리자 인증의 검증을 대신하지 않으며,
`evaluation_executed`와 `core_admin_auth_verified`는 false로 남긴다. `runtime.result_artifact_verified`는
지정한 완료 결과를 실제 검증한 경우에만 true다. 버전 불일치는 아래의 명시적인 이미지 갱신 절차로 해소한다.

기존 LLMOps CI의 Kubernetes E2E에서도 최초 활성화 후와 Compose 컨테이너 교체·새 평가 완료 후에
같은 점검을 호출한다. 설정 점검 성공과 새 평가·재시작·장애 복구 검증 결과는 보고서에서 별도로 기록한다.

### 기존 개인 Ops 이미지 갱신

진행 중 평가·접수 중지·백업 복원과 실패 후 조치는
[개인 Ops 갱신·복구 절차](../../../docs/ops-upgrade-runbook.md)를 따른다.
활성화 단계별 결과는 state의 `ops-updates/<UUID>.json`에 남는다. `ACTIVATED`도 새 무료 평가와
관리자 인증 성공을 뜻하지 않으며 `RUNNING`/`FAILED` 기록은 조사 없이 완료로 처리하지 않는다.

기존 클러스터의 Ops가 오래된 이미지라면 같은 소스에서 Ops와 Compose 실행기를 먼저 빌드한다.
실행 중인 평가가 없는지 확인하고 실행기를 갱신한 뒤, 고유한 로컬 Ops 태그를 지정한다.
기존 Core·Ops DB와 Prefect·결과 볼륨은 백업하고 유지한다. Core 관리자 세션 API의 지원 여부도 별도로 확인한다.

```bash
python3 -B infrastructure/gitops/scripts/ops_runtime.py \
  --state-dir /기존/개인/state/경로 \
  --artifact-env /소유자/전용/artifacts.env \
  --ops-image govbiz-ops-service:msa-고유태그
```

- `--ops-image`는 `local` baseline·`dev` 환경에서 Ops만 갱신한다. `--kind`로 사용할 kind 실행 파일을 지정할 수 있다.
- 동일 Compose 프로젝트의 실행 중인 실행기 하나를 확인한다. 다른 프로젝트·one-off·호스트 포트 노출은 거절한다.
- 선택한 Ops 이미지와 실행기의 `execution_release.json` SHA-256이 같아야 한다.
  실행기는 `LLMOPS_LIVE_ENABLED=false`이고 모델 키가 비어 있어야 한다. 토큰이나 키 값은 출력하지 않는다.
- 이미지 검사는 immutable Docker ID로 네트워크 없는 읽기 전용 컨테이너에서 수행한다.
  이후 기존 kind 적재 검증을 재사용하며 Secret·migration 전에 이미지·실행기와 현재 Deployment·baseline을 다시 확인한다.
- DB 주소·계정·Secret 참조를 보존한다. API·sync의 이미지를 함께 적용하며 Deployment의 `resourceVersion`으로 동시 변경을 거절한다.
- migration·rollout·런타임 진단이 모두 성공한 뒤 baseline의 Ops 이미지 항목만 갱신한다.
  다른 서비스 이미지·기존 baseline 부가 정보는 유지한다.

migration 실패 시 workload와 baseline을 갱신하지 않는다. rollout·진단 실패 시 새 workload가 이미 적용됐을 수 있지만
성공으로 기록하거나 DB·이미지를 자동으로 되돌리지 않는다. 실패 Job과 원인을 확인한 뒤 같은 `--ops-image`로 재시도한다.
현재 API·sync가 서로 다른 이미지이거나 baseline·명시한 대상 이외의 이미지라면 변경을 거절한다.
이 사전검사는 실행기 프로세스의 실제 평가 처리 성공을 증명하지 않는다. 활성화 후 무료 평가와 보고서 조회를 확인해야 한다.

성공한 연결은 비밀값 없는 `ops-activation.json`에 저장해 다음 `up --local-images`에도 유지한다.
GHCR baseline·Argo 소유 환경·미복원 개발 이미지에는 적용하지 않으며 발행 이미지의 추적된 입력 검증을 우회하지 않는다.
진단 PASS는 새 평가 실행 완료가 아니다. 이후 기존 Core 관리자 계정으로 웹에 로그인해 무료 평가를 확인한다.

웹 명령은 같은 클러스터의 Core `127.0.0.1:18080`, Ops `127.0.0.1:18001`을 함께 전달한다.
Vite는 다른 터미널에서 `pnpm --dir frontend/web dev:k8s`로 실행한다.
두 포트 중 하나라도 점유되면 다른 프로세스를 종료하거나 재사용하지 않고 거절한다.
[port-forward는 선택한 Pod 종료 시 끊어지므로](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_port-forward/),
한쪽이 종료되면 함께 시작한 두 전달을 정리한다. Pod 교체 후 웹 명령을 다시 실행한다.

`connect`는 자동 컨트롤러가 아니다. Compose가 Prefect/결과 서버를 교체하거나 네트워크를 다시 만들면
**다시 실행해 EndpointSlice를 갱신**한다. `check`는 현재 IP·소유권만 읽어 확인하며 HTTP 성공을 뜻하지 않는다.
EndpointSlice의 ready 표시는 구성된 라우팅 대상으로만 해석한다. Prefect에는 이 개발 구성의 별도 인증이 없으므로
신뢰하는 로컬 Docker 환경에 한정하며 외부·공유 환경으로 그대로 확장하지 않는다.

무료 실제 통신 검증은 다음과 같다.

```bash
python3 -B infrastructure/gitops/scripts/smoke_ops_bridge.py --report work/ops-bridge.json
```

새 이름의 임시 kind 클러스터와 Compose 프로젝트만 만들고 종료 시 해당 시험 컨테이너·볼륨을 정리한다.
실제 Pod에서 DNS·Prefect HTTP·결과 서버 토큰 거절(401)·쓰기 거절(405)·평가 자료 SHA-256을 확인한다.
오래된 EndpointSlice를 의도적으로 넣어 `check`가 거절하고 `connect`로 복구되는지도 확인한다.
시험 Compose는 호출 셸의 토큰·경로·Compose 설정을 상속하지 않고 임시 환경변수를 사용한다.
기본 실행은 현재 Ops 소스를 빌드한다. `--ops-image <기존 로컬 이미지>`를 명시하면 해당 이미지로만 검사하므로
최신 소스의 빌드 증거로 보고하지 않는다. 기본 통신 검증은 평가를 접수하지 않는다.

전체 무료 업무 검증은 `--evaluate`를 추가한다. Helm 4.3.0, 저장소의 Node·pnpm 의존성과
비어 있는 loopback 5173·18080·18001 포트가 필요하다.

```bash
python3 -B infrastructure/gitops/scripts/smoke_ops_bridge.py --evaluate \
  --report work/ops-kubernetes-evaluation.json
```

새 격리 클러스터에 실제 Core·MySQL 8.4·Ops API+sync를 배치하고,
Compose에는 Prefect·실행기·결과 서버·Langfuse만 실행한다. Compose Ops API·sync·DB가 없음을 확인한다.
운영용 활성화 명령을 두 번 실행해 비밀값 보존을 검사하고, 기존 `ops_smoke.py`의
관리자/일반 사용자 권한·CSRF·동일 요청 중복 접수·자동 목록 동기화·보고서·로그아웃 검증을 재사용한다.
개발 로그인 계정 생성은 이 임시 Core DB에서만 수행한다.

Kubernetes Ops DB의 요청·flow·명세를 직접 대조한 뒤 API+sync Pod를 재시작한다.
새 Pod에서 같은 DB 기록과 인증된 보고서 SHA-256이 유지돼야 통과한다.
보고서에는 소스 SHA, Ops 실제 image ID, 실행 release 해시, request/flow ID, HTTP transport,
모델 호출 0회, 실행·재시작·정리 결과를 남긴다. 사람의 품질 검토나 현재 모델의 실제 품질 측정은 아니다.

같은 격리 환경에서 `ops_smoke.py --rag-replay`도 호출한다. 기존 고정 근거 6사례 검증을 유지하며,
합성 RAG 저장 캡처 3사례의 접수·중복 요청·목록 자동 동기화·인증 보고서·로그아웃을 추가로 확인한다.
Kubernetes DB의 request/flow/명세/모델 호출 수와 Prefect의 완료 실행 정확히 1건을 대조한다.
검색·인용 지표는 대상 2사례, 상태 일치율은 대상 3사례이며 비측정 값을 0으로 바꾸지 않는다.
합성·미검토 출처, `baseline_eligible=false`, live 실행 없음도 검사한다.

보고서의 `rag_replay`에는 최초 평가(`initial`), Pod 재시작 후 기존 결과 확인(`pod_restart`),
Compose 교체 후 새 평가(`after_replacement`), 그 뒤 최초 DB 기록·인증 보고서 해시 보존
(`endpoint_replacement`)을 기록한다. 두 RAG 요청은 서로 다른 request/flow ID와 같은 실행 명세를
가져야 하며, 기존 고정 근거 요청과도 겹치면 안 된다. 모든 대조가 끝나야 `rag_replay.status=PASS`다.
이 검사는 이미 저장된 합성 결과의 재계산이다. 새 검색·임베딩·답변 생성, RAG 예산 왕복,
사람 검토·모델 품질 합격을 검증하지 않는다. 새 코드의 실제 Kubernetes 통과 여부는 해당 SHA의
LLMOps CI 결과로 별도 확인하며, 로컬 선택 테스트만으로 배포 완료를 선언하지 않는다.

이어서 같은 완료 실행에 세 가지 artifact 장애를 주입한다. 내부 결과 서버의 응답과 사용자 API 응답을 구분해 검사한다.

| 시험 | 내부 artifact HTTP | 사용자 보고서 | 관리자 런타임 진단 |
|---|---|---|---|
| API 토큰 불일치 | 401 | 404 | 503, evidence·results_directory·result_artifact 실패 |
| 해당 보고서 누락 | 404 | 404 | 503, result_artifact만 실패 |
| 같은 길이의 보고서 변조 | 200, 변조 바이트 해시 확인 | 404 | 503, result_artifact만 실패 |
| 원상 복구 후 | 보고서 읽기 성공 | 200, 원본 SHA-256 동일 | 200, 전체 PASS |

장애 중에도 Ops 생존·DB 준비 probe는 200이어야 한다. 완료 기록의 상태·flow·실행 명세·모델 호출 0회를 보존하며
추가 평가 접수·모델 호출·장부 보정 없이 복구한다. 보고서의 404만으로 내부 인증 오류와 파일 누락을 구별하지 않는다.

주입은 도구가 생성한 시험 프로젝트·kind context·실행기 소유권을 확인한 후에만 수행한다.
잘못된 토큰은 임시 Deployment의 Ops API 환경변수 하나에 적용하고 Secret 데이터는 그대로 둔다.
배포 UID와 기존 값을 비교하는 JSON patch로 원래 참조를 복원한다. Pod 교체마다 포트 전달을 새로 연다.
누락 시험은 실행기의 시험 결과 볼륨에서 보고서 해시를 확인하고 잠시 이름을 바꾼다.
변조 시험은 같은 원본 보관 절차 후 마지막 1바이트만 바꾼 동일 길이의 사본을 배타적으로 생성한다.
manifest의 원래 해시는 유지하고, 실제 Pod에서 받은 HTTP 응답의 해시·길이가 이 사본과 일치해야 한다.
복원할 때는 사본과 백업을 다시 검증하고 시험 사본만 제거한다.
다른 작성자의 파일·기존 백업·심볼릭 링크를 덮어쓰지 않으며 복원 충돌은 실패로 남긴다.
각 장애는 `finally`에서 복원한다. 검사·복원 실패 시 전체 결과는 FAIL이며 다음 평가를 자동 생성하지 않는다.

`ops-bridge.json`의 `artifact_recovery`에 세 사례의 장애 응답·복구 진단·보고서 해시가 기록된다.
`scenarios.report_tampered`에는 내부 HTTP 200, 변조 해시·바이트 수와 원본 복원 결과를 추가로 남긴다.
`artifact_recovery.status=PASS`와 `evaluation_status=PASS`, 최상위 정리 성공이 모두 필요하다.
Prefect 장애·동기화 중단은 아래 추가 단계에서 검사한다. 유료 예산의 역방향 연결은 별도 후속 작업이다.

추가로 무료 replay 한 건을 사용해 Prefect 응답 중단과 동기화 중단·재개를 검증한다.

| 단계 | 확인 조건 |
|---|---|
| 시험 Prefect 일시 정지 | 새 접수 HTTP 503, REQUESTED·flow 없음, 상태 조회 오류와 실제 60초 경과 후 지연 표시 |
| Prefect 재개 | 동기화 시도 시각 갱신, 접수 미확인 유지, Prefect 실행 0건으로 자동 재접수 없음 |
| 시험 ops-sync 중단 | 같은 요청을 명시적으로 재시도·중복 접수. Prefect는 COMPLETED이지만 Ops 목록은 QUEUED·지연 상태 유지 |
| ops-sync 복원 | 상세 조회 없이 목록에서 COMPLETED로 갱신. 같은 flow·명세·호출 0회, Prefect 실행 1건과 보고서 조회 확인 |

Prefect 중단은 생성된 시험 컨테이너 ID에 대한 `pause/unpause`로 재현한다.
기존 사용자 컨테이너·다른 서비스·이미 정지된 컨테이너는 대상으로 삼지 않는다.
동기화는 시험 Deployment의 `ops-sync` 명령만 종료 신호를 처리하는 대기 프로세스로 교체한다.
원래 명령과 배포 UID를 비교해 복원하며 API 이미지·Secret·DB 데이터는 그대로 유지한다.
각 주입 구간의 예외에서도 원상 복원을 시도하고 복원 실패를 정상 결과로 처리하지 않는다.

시험 중 상태·시각을 DB에서 조작하지 않고 실제 지연 시간과 목록 응답을 관찰한다.
직접 상태를 갱신하는 상세 API·수동 sync 명령은 호출하지 않는다.
Prefect 장애 중에도 기존 완료 보고서와 Ops 생존·DB 준비 probe가 정상이어야 한다.
동기화가 멈춘 동안 런타임 구성 진단은 PASS일 수 있다. 이 진단은 실행기·sync의 진척을 증명하지 않으며,
목록의 `status_stale`·`synced_at`·`sync_attempted_at`으로 지연 상태를 확인한다.

`ops-bridge.json`의 `sync_recovery.status=PASS`, `automatic_dispatch_count=0`,
`prefect_flow_count=1`, `model_api_calls=0`과 기존 artifact·평가·정리 결과가 모두 필요하다.
복구된 실행은 Kubernetes DB에서도 직접 읽어 요청·flow·명세·완료 상태를 대조한다.
이 경로는 무료 저장 캡처만 사용하며, 실행기에서 Kubernetes 예산 API로 연결하는 live 경로는 별도 작업이다.

마지막으로 실제 Compose 컨테이너 교체 후의 복구를 검사한다.

| 단계 | 확인 조건 |
|---|---|
| Prefect 재생성 | 같은 이미지·`prefect-data` 볼륨, 새 컨테이너 ID |
| 결과 서버 교체 | 기존 읽기 전용 서버를 유지한 채 두 번째 서버 시작 → 같은 이미지·`ops-results` 볼륨 및 다른 IP 확인 → 이전 시험 서버만 제거 |
| 오래된 경로 검사 | `check`가 주소 변경을 거절하고 기존 EndpointSlice를 수정하지 않음 |
| 명시적 경로 갱신 | `connect` 후 `check` 통과, 기존 Service UID·ClusterIP와 Docker 네트워크·kind 노드 유지 |
| 결과·업무 복구 | Pod 런타임 진단 PASS, 기존 인증 보고서 해시 보존, 새 무료 평가 완료·Prefect 실행 정확히 1건·Kubernetes DB 대조 |

단순 재시작은 Docker가 이전 IP를 재사용할 수 있으므로 결과 서버의 실제 주소 변경을 강제한다.
임시 복제는 같은 결과를 읽는 서버에만 적용하며 Prefect를 동시에 두 개 실행하지 않는다.
교체 전에 프로젝트·서비스·컨테이너·네트워크·named volume·읽기 전용 마운트를 확인하고,
새 서버 검증을 통과한 뒤 확인된 이전 결과 서버 ID만 제거한다. 교체 중 볼륨을 삭제하지 않는다.
예외가 발생하면 전체 E2E를 실패로 남기고 최상위 정리에서 생성한 시험 프로젝트·클러스터만 제거한다.

`ops-bridge.json`의 `replacement_recovery`에는 교체 전후 ID·IP·이미지·볼륨,
경로 복구·기존 보고서 해시, 새 평가·Kubernetes DB 대조 결과를 남긴다.
`replacement_recovery.status=PASS`, `new_request_flow_count=1`, 새 평가의 `model_api_calls=0`과
기존 평가·artifact·동기화 복구·최종 정리가 모두 성공해야 한다. 경로 갱신만으로 PASS를 기록하지 않는다.
새 무료 평가에서도 Core 인증·권한·CSRF·중복 접수·목록 자동 동기화·보고서·로그아웃 검증을 재사용한다.
이전 두 고정 근거 평가와 최초 RAG 평가의 Kubernetes DB 기록도 보존돼야 한다.

필수 LLMOps CI의 기존 integration 작업에 이 전체 검증을 연결했다.
코드 추가·오프라인 검사와 실제 CI 통과는 구분하며 최신 커밋의 원격 결과는 푸시 후 확인한다.

## 연결된 Ops의 이미지 갱신 경로

Compose 실행기와 연결된 Ops는 `ops_runtime.py --preflight`로 접수 중지·진행 중 작업 상태를
확인한 뒤, 이 문서의 `--ops-image` 갱신 절차를 사용한다. 실행기와 이미지의 release 확인,
migration, 실행 후 런타임 검사를 일반 이미지 교체로 건너뛰지 않는다.

`dev.py`는 활성화 기록이 있거나 실제 컨테이너의 Prefect URL이 명시적인 초기화용 비활성 주소가
아니면 Ops 빌드·교체·이전 이미지 복원을 거절한다. URL 누락·간접 참조·중복도 미확인으로 거절한다.
전체 서비스 선택 시 다른 서비스를 먼저 변경하지 않도록 사전 검사하며, Ops 빌드 뒤에도 연결 상태를
다시 확인한다. Core·Catalog·AI는 해당 서비스를 명시해 개발할 수 있다.

`fork_cluster.py up`도 활성화된 Ops를 다시 초기화하는 용도로 사용할 수 없다. 활성화 파일뿐 아니라
기존 Deployment 설정을 조회하므로 기록 삭제로 우회하지 않는다. 차단은 기존 실행 환경·DB·이미지를
수정하지 않으며, 연결이 의도적으로 해제됐다는 증거 없이 차단 파일이나 환경값을 임의로 지우지 않는다.

## 실제 연결의 남은 조건

1. 사용할 개인 개발 환경에 위 전용 브리지를 연결한다. 임시 환경의 통신 검증과 기존 개발 환경 활성화는
   별개다. 외부·공유 클러스터의 TLS·인증·네트워크 정책은 이 로컬 브리지 범위 밖이다.
2. 새 Ops 배포 후보에 해당 URL과 별도 인증 Secret 참조를 반영한다. 실제 결과 볼륨은 Compose에 남긴다.
   hostPath 허용·기존 volume 삭제·스토리지 이관 없이 새 실행 결과 조회를 검증한다.
3. 실행 release에 맞는 평가 자료가 HTTP로 전달되는지 해시로 확인한다.
4. 위 연결 values와 Secret을 준비한 뒤 `opsSync.enabled=true`로 활성화하고 Kubernetes Ops DB의
   실행 상태가 실제로 갱신되는지 확인한다. 배치 기능은 구현했지만 기본 설정은 계속 비활성화다.
5. 새 격리 환경에서 Core 관리자 인증 → 무료 저장 캡처 평가 → 목록 자동 갱신 → 결과 조회 →
   재시작 후 유지까지 확인한다. 진단 응답만으로 이 E2E를 대체하지 않는다.

LLMOps CI는 HTTP overlay와 실제 Compose 병합 검사를 사용한다. Ops에 파일 mount가 없는 상태에서
무료 평가·완료 결과 진단·비교·후처리 복구를 검증하고 `storage_transport=http`를 확인한다.
기존 파일 방식은 Ops 테스트와 취소 통합 검증에 유지한다. 이는 Compose 내부 HTTP 통합 검증이며,
Kubernetes 평가 E2E나 Argo 동기화 완료의 증거는 아니다. 새 `--evaluate` 경로는 위 Kubernetes 업무 검증을
별도로 수행한다. 실행하지 않았거나 실패한 검증은 완료로 표시하지 않으며 새 변경의 CI 결과는 푸시 후 확인한다.
