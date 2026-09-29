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

이어서 같은 완료 실행에 두 artifact 장애를 주입한다. 내부 결과 서버의 응답과 사용자 API 응답을 구분해 검사한다.

| 시험 | 내부 artifact HTTP | 사용자 보고서 | 관리자 런타임 진단 |
|---|---|---|---|
| API 토큰 불일치 | 401 | 404 | 503, evidence·results_directory·result_artifact 실패 |
| 해당 보고서 누락 | 404 | 404 | 503, result_artifact만 실패 |
| 원상 복구 후 | 보고서 읽기 성공 | 200, 원본 SHA-256 동일 | 200, 전체 PASS |

장애 중에도 Ops 생존·DB 준비 probe는 200이어야 한다. 완료 기록의 상태·flow·실행 명세·모델 호출 0회를 보존하며
추가 평가 접수·모델 호출·장부 보정 없이 복구한다. 보고서의 404만으로 내부 인증 오류와 파일 누락을 구별하지 않는다.

주입은 도구가 생성한 시험 프로젝트·kind context·실행기 소유권을 확인한 후에만 수행한다.
잘못된 토큰은 임시 Deployment의 Ops API 환경변수 하나에 적용하고 Secret 데이터는 그대로 둔다.
배포 UID와 기존 값을 비교하는 JSON patch로 원래 참조를 복원한다. Pod 교체마다 포트 전달을 새로 연다.
보고서는 실행기의 시험 결과 볼륨에서 해시를 확인하고 잠시 이름을 바꾸며, 원본이나 보관 파일을 덮어쓰지 않는다.
각 장애는 `finally`에서 복원한다. 검사·복원 실패 시 전체 결과는 FAIL이며 다음 평가를 자동 생성하지 않는다.

`ops-bridge.json`의 `artifact_recovery`에 두 사례의 장애 응답·복구 진단·보고서 해시가 기록된다.
`artifact_recovery.status=PASS`와 `evaluation_status=PASS`, 최상위 정리 성공이 모두 필요하다.
이 검증은 Prefect 장애·동기화 중단·유료 예산의 역방향 연결을 포함하지 않는다.

필수 LLMOps CI의 기존 integration 작업에 이 전체 검증을 연결했다.
코드 추가·오프라인 검사와 실제 CI 통과는 구분하며 최신 커밋의 원격 결과는 푸시 후 확인한다.

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
