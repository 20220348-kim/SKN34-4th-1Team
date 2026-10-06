# 이미지 발행과 배포의 현재 경계

별도 `deploy/fork` 브랜치와 배포 PR 절차는 사용자 요청으로 제거했다.
현재 흐름은 `skn-* → main 개발 PR → 필수 CI → 검증된 이미지 발행`이다.
배포용 PR이나 추가 리뷰 승인은 요구하지 않는다.

`MSA image candidates`의 CI gate·이미지 출처·digest·receipt 검증은 유지한다.
`Fork image promotion` 워크플로는 제거했으며 `MSA_PROMOTION_ENABLED=false`를 유지한다.
이미지 발행 후 Argo 자동 배포를 연결하는 대체 기능은 아직 없다.
자세한 적용 상태는 [배포 PR 제거 기록](deployment-candidates.md)을 참고한다.

## 클러스터 적용 없이 공개 이미지 검증

기존 개발 환경을 유지한 채 공개 이미지의 발행 증거만 확인하려면 저장소 루트에서 실행한다.
Python 3.13·Git·Helm 4.3.0과 [GitOps Python 의존성](../scripts/requirements.txt),
해당 포크의 CI·Actions artifact를 읽을 수 있는 `gh` 로그인이 필요하다.
Docker·kind·kubectl·kubeconfig나 `fork_cluster.py init`은 필요하지 않다.

```bash
gh auth status
python -B infrastructure/gitops/scripts/deployment.py verify-public
```

검증 대상은 `origin`의 기본 브랜치이며 현재 작업 브랜치의 로컬 수정은 사용하지 않는다.
기본 브랜치를 별도로 지정해야 할 때는 `--branch main`을 사용한다.
Helm이 PATH에 없다면 실행 위치에 영향을 받지 않도록 `--helm`에 실행 파일의 **절대 경로**를 전달한다.
렌더링 대상 Chart·values는 임시 디렉터리에 추출한 검증된 소스만 사용한다.

검증 순서는 `현재 소스·필수 CI → 네 receipt와 Git tree → 동일 소스 Helm 정책
→ 네 digest의 익명 manifest HEAD → 소스·CI·발행 run·artifact 재확인`이다.
공개 receipt만 허용하며, 비공개·v1 receipt는 PAT 입력으로 우회하지 않는다.
GHCR에서는 익명 scoped token으로 manifest를 조회하므로 개인 PAT나 Kubernetes Secret을 읽지 않는다.

성공 시 종료 코드 `0`과 `msa-publication-check-v1` JSON을 출력한다.
`sourceSha`, `publisherRunId`, `images`에 검증한 대상을 기록하고,
`receiptsVerified`, `helmPolicyVerified`, `registryManifestsVerified`를 `true`로 표시한다.
이미지 레이어 다운로드·실행·내용 검사는 하지 않으므로 `layersDownloaded: false`,
실제 배포나 서비스 상태를 확인하지 않으므로 `clusterVerified: false`를 유지한다.
manifest 조회 성공만으로 전체 pull·서비스 기동·Argo 동기화 완료로 판단하지 않는다.

검증 실패 시 종료 코드 `1`, `status: BLOCKED`와 안전한 `reason`만 출력한다.
`publication_not_available`은 완전한 발행 증거가 아직 없다는 뜻이며,
`required_source_checks_not_verified`는 필수 소스 검증이 충족되지 않았다는 뜻이다.
검증 중 변경이 감지되면 `source_not_current`, `publication_changed`, `ci_evidence_changed`로 중단한다.
기타 오류는 `verification_failed`이며 원본 예외·인증 정보는 JSON에 넣지 않는다.
최신 발행이 실행 중이거나 실패한 경우 과거의 성공 이미지를 대신 사용하지 않는다.

클러스터·DB·Secret·원격 Git·작업 파일·index·브랜치를 변경하지 않는다.
로컬에 소스 Git 객체가 없으면 `origin`에서 해당 SHA만 fetch할 수 있다.
검증 결과는 실행 시점의 증거이며 이후 배포를 승인하거나 미래의 상태를 보장하지 않는다.
예전 `bootstrap`, `prepare`, `propose`, `check` 배포 PR 명령은 계속 비활성 상태다.

## 실제 배포 없이 고정된 Argo 입력 준비

공개 이미지 검증을 통과한 소스의 Argo 구성을 확인하려면 다음 명령을 사용한다.
`verify-public`과 같은 Python·Git·Helm·`gh` 환경이 필요하다.

```bash
python -B infrastructure/gitops/scripts/deployment.py plan-gitops
```

`--branch`와 `--helm` 옵션은 `verify-public`과 같다. 실행 흐름은
`최신 소스·필수 CI → 공개 receipt·Helm 정책·익명 manifest 검증 → 변경 여부 재확인 → Argo 계획 JSON`
이다. 실패하면 종료 코드 1과 `BLOCKED`를 반환하고 일부 Application을 출력하지 않는다.
기존 `verify-public`의 출력 계약과 과거 배포 PR 명령의 비활성 상태는 유지한다.

성공한 `msa-gitops-plan-v1` 보고서는 `status: PLANNED`와 다음을 포함한다.

- `resources`: AppProject 1개와 서비스별 Application 4개. Chart의 `targetRevision`은 검증한
  전체 소스 SHA로 고정하고, 발행 receipt로 생성한 전체 values를 `helm.valuesObject`에 넣는다.
  이후 `main` 병합을 따라가거나 소스 커밋에 남아 있는 과거 이미지 values를 다시 읽지 않는다.
- 네 서비스 이미지 digest, 발행 run ID, Argo 리소스와 서비스별 렌더링 결과의 SHA-256.
  해시는 비교용이며 전자서명이나 배포 승인이 아니다.
- 자동 동기화·prune·self-heal 비활성, 자동 재시도 0회. 기존 서비스 namespace와
  Deployment·Service·Ops migration Job 범위만 허용하고 DB·PVC·Secret 관리 권한은 추가하지 않는다.
- `clusterVerified`, `existingRuntimeVerified`, `deploymentAuthorized`, `layersDownloaded`는 모두
  `false`. 기본 실행은 클러스터·로컬 state·Secret에 접근하지 않으며 원격 Git 변경이나 파일 저장도 하지 않는다.
  필요한 Git 객체 fetch와 임시 Helm 렌더링은 기존 공개 검증 경로와 같다.

이는 **현재 개인 환경에 즉시 적용할 전환 파일이 아니라, 발행된 기본 서비스 구성의 검토용 계획**이다.
개인 Ops↔Compose 연결 설정·Secret 존재·Argo 리소스 추적 설정·기존 DB 호환성은 검사하지 않는다.
Argo 설치·Application 적용·sync·원본 migration·런타임 교체 기능은 이번 명령에 없다.
자동 동기화를 꺼도 나중에 사람이 sync하면 Ops PreSync migration Job이 실행될 수 있다.
실제 전환 때에는 최신 검증과 [개인 환경 전환 절차](../../../docs/ops-upgrade-runbook.md)를
수행하고 현재 실행 설정과의 차이를 확인해야 한다. 준비 결과를 재사용 가능한 배포 승인서로 쓰지 않는다.

[Argo Helm valuesObject](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/#values)와
[자동 동기화 설정](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)을 따른다.
무료 회귀 테스트는 실제 Helm으로 각 Application의 고정 Chart·valuesObject를 렌더링해
발행 검증 결과와 비교하고, 공개 검증 실패·소스 불일치·원격 변경 없음도 확인한다.
Infra CI의 기존 `test_*.py` 검색에 포함되며 실제 Argo controller 동작 검증은 별도다.

### 개인 환경의 연동 설정 충돌 먼저 확인하기

개인 WSL/kind 환경에서는 `--state-dir`을 지정해 공개 이미지 조회 전에 기존 연동 설정을
읽기 전용으로 점검할 수 있다. 이 옵션은 `plan-gitops`에서만 허용한다.

```bash
# WSL의 기존 Linux Python 환경에서 실행한다.
python3 -B infrastructure/gitops/scripts/deployment.py plan-gitops \
  --branch main --state-dir "$OPS_STATE_DIR"
```

전용 loopback 클러스터·소유권과 dev 모드를 확인하고, 로컬 연결 기록 및 Core·Catalog·AI·Ops Deployment·Service를 읽는다.
개인 설정 기록이 없어도 각 서비스의 현재 환경변수를 비교하며, 여덟 리소스 중 하나라도 조회할 수 없으면 실패한다.
`--helm`은 공개 이미지 검증과 이 로컬 비교에 함께 사용한다. 현재 Chart·서비스별 values를 메모리에
캡처하고 임시 경로에서 렌더링한 Deployment·Service를 기준으로 삼는다. 임시 파일은 성공·실패 시 제거하며,
이 렌더링은 클러스터·DB·Secret을 변경하거나 migration Job을 실행하지 않는다.
Secret 값·환경변수 값은 보고서에 출력하지 않는다. 다음 충돌은 종료 코드 1과
`reason: runtime_transition_required`, `runtimePreflight.status: BLOCKED`로 반환한다.

| 차단 코드 | 필요한 확인 |
|---|---|
| `local_integration_profile` | 기본 Argo values에 포함되지 않은 개인 연동 설정의 보존 방법 |
| `local_development_images` | 개발 이미지 override의 명시적인 정리·전환 |
| `connected_or_unverified_ops` | Ops 활성화·브리지 기록 또는 Prefect 연결과 최초 migration 절차 |
| `ops_container_layout_differs` | 기본 계획에 없는 `ops-sync` 등 컨테이너 구성의 보존 방법 |
| `ops_environment_differs` | Ops 기본 환경과 다른 환경변수·Secret 참조의 변경·추가·누락 검토 |
| `ops_env_from_uninspected` | `envFrom`으로 주입된 설정의 별도 검토; Secret·ConfigMap 값은 조회하지 않음 |
| `service_container_layout_differs` | Core·Catalog·AI의 추가·누락된 컨테이너 구성 검토 |
| `service_environment_differs` | Core·Catalog·AI 기본 환경 대비 환경변수·Secret 참조의 변경·추가·누락 검토 |
| `service_env_from_uninspected` | Core·Catalog·AI 컨테이너의 `envFrom` 주입 별도 검토 |
| `service_execution_or_storage_differs` | 네 서비스의 저장소·실행 명령·초기화 컨테이너·복제 수·배포 전략 차이 검토 |
| `service_runtime_policy_differs` | 네 서비스의 probe·자원·보안·서비스 계정·DNS·컨테이너 포트 및 lifecycle 설정 차이 검토 |
| `service_routing_differs` | 네 Service의 선언 차이, Deployment selector·Pod 라벨 차이, Pod 선택·이름 기반 targetPort 연결 오류 검토 |

`runtimePreflight.preservationReview`에는 전환 때 검토할 항목을 값 없이 제공한다.

- `integrationFeatures`, `modelSettingNames`: 검증된 개인 설정에 기록된 기능과 모델 설정 키 이름.
  기능 연결의 정상 동작을 증명하지 않으며 실제 Deployment 설정 차이는 `serviceReviews`에서 확인한다.
- `containers`: Ops 기본 구성에 없는 컨테이너와 누락된 기본 컨테이너 이름.
- `environmentChanges`: `ops-service`·`ops-sync` 각각의 `changed`, `runtimeOnly`, `missing` 이름 목록.
  각 컨테이너를 같은 Ops 기본 환경과 비교한다. 변수 순서는 무시하지만 중복 이름·모호한 주입 형식은 거절한다.
  Secret 참조 대상이 달라져도 변수 이름만 표시하고 값·Secret 이름·key는 출력하지 않는다.
- `uninspectedEnvFrom`: 주입 내용을 확인하지 않은 컨테이너 이름. 참조를 따라가 값을 읽지 않는다.
- `serviceReviews`: Core·Catalog·AI의 서비스 이름별 비교 결과. 각각 `containers`, `environmentChanges`,
  `uninspectedEnvFrom`, `reference`, `referenceSha256`을 포함한다. 추가 컨테이너의 환경변수는 비교하지
  않고 구성 차이로 차단하며, 기본 서비스 컨테이너가 누락돼도 차단한다. 기존 Ops 필드 위치는 유지한다.
- `connectionRecordConflict`: 활성화·브리지 기록의 Compose 프로젝트가 서로 다른지 표시.
  프로젝트 이름·주소·인증값은 보고서에 포함하지 않는다.
- `runtimeReviews`: 네 서비스별 `changedFields` 목록. `replicas`, `strategy`, `volumes`, `initContainers`와
  기본 서비스 컨테이너의 `command`, `args`, `volumeMounts`, `volumeDevices`를 비교한다.
  명령 인수·경로·PVC 이름·init container 설정값은 출력하지 않고 차이가 있는 필드 이름만 표시한다.
  볼륨·마운트 순서 차이는 무시하고 중복된 볼륨 이름은 거절한다. 추가 컨테이너는 기존 구성 차이로 차단한다.
- `chartSha256`: 캡처한 Chart 파일 경로와 내용 해시로 계산한 비교 기준 지문.
  서비스별 values의 `referenceSha256`과 함께 사용하며 서명이나 배포 승인이 아니다.
- `policyReviews`: 네 서비스별 `changedFields` 목록. 다음 선언을 같은 Helm 기준과 비교한다.
  - Pod: `securityContext`, `automountServiceAccountToken`, `serviceAccountName` 및 기존 `serviceAccount`,
    `hostNetwork`, `hostPID`, `hostIPC`, `shareProcessNamespace`, `dnsPolicy`, `dnsConfig`, `hostAliases`,
    `terminationGracePeriodSeconds`, `resources`.
  - 기본 서비스 컨테이너: 세 probe, `resources`, `securityContext`, `ports`, `lifecycle`.
  - probe 헤더·handler 명령·DNS 주소·계정 이름 등 값은 출력하지 않는다. 삭제된 probe·필수 보안 설정과
    누락된 자원 요청/한도도 차이로 처리한다. 추가 컨테이너는 기존 구성 차이로 차단한다.
- `networkReviews`: 네 서비스별 `changedFields`와 `routingErrors` 목록.
  - Service의 `selector`, `ports`(targetPort·protocol 포함), `type`, headless 여부, IP family 정책,
    session affinity, 트래픽 정책, 외부 주소 및 LoadBalancer 설정을 같은 Helm 기준과 비교한다.
    Deployment의 `spec.selector`와 Pod template 라벨 차이도 고정된 필드명으로 표시한다.
  - Service selector가 비어 있거나 Pod template 라벨을 선택하지 못하면
    `selector_does_not_match_pod`를 기록한다. 이름 기반 targetPort와 같은 protocol의 포트가
    일반 컨테이너에 정확히 하나 없으면 `named_target_port_unresolved_or_ambiguous`로 차단한다.
    숫자 targetPort에는 containerPort 선언을 강제하지 않는다.
  - selector 값·주소·포트 값은 출력하지 않는다. 미지의 Service spec 필드가 달라지면 값이나 이름을
    노출하지 않고 `service.otherFields`로 차단한다. 포트 순서는 무시하되 중복 항목을 덮어쓰지 않는다.

probe 비교는 [Kubernetes 1.36의 기본값 처리](https://github.com/kubernetes/kubernetes/blob/v1.36.0/pkg/apis/core/v1/defaults.go)를
반영한다. 생략된 probe 시간·횟수, HTTP scheme·path와 명시된 기본값을 같은 것으로 비교하며,
알 수 없는 probe 필드를 삭제해 무시하지 않는다. 포트 목록 순서와 기본 `TCP` 표기도 구분하지 않는다.
자원 비교는 [Kubernetes 수량 표기](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)의
SI·이진·지수 표기를 유리수로 바꿔 `100m=0.1`, `1Gi=1024Mi`를 정확히 비교한다.
요청과 한도는 별도로 유지하며, 알 수 없는 표기·비유한 값·지원 범위 밖 수량은 `UNKNOWN`으로 실패한다.
이 비교는 API의 수량 반올림·범위 보정이나 admission 검증 전체를 재현하지 않는다.

Service 비교에는 [Kubernetes Service 기본 동작](https://kubernetes.io/docs/concepts/services-networking/service/)의
`ClusterIP`, `TCP`, 생략된 targetPort, session affinity·트래픽 정책 등의 기본값을 반영한다.
Chart에 없는 자동 할당 `clusterIP`·`clusterIPs`·`ipFamilies`는 값 비교에서 제외하지만
headless 모드와 `ipFamilyPolicy` 변경은 차단한다. Chart가 주소·family를 명시하면 해당 값도 비교한다.
Service metadata의 annotation·label, EndpointSlice, 실제 Pod·프로세스·통신 상태는 이 검사 범위에 없다.
현재 EndpointSlice·Pod 연결 대상은 별도 [읽기 전용 진단](../../../docs/local-fork-development.md#kubernetes-service의-실제-연결-대상-확인)의
`fork_cluster.py status --json --network-details`로 확인한다. 해당 진단이 통과해도 전환 충돌을 해제하거나 배포를 승인하지 않는다.

비교 기준은 **현재 checkout의 `environments/portfolio/<service>.yaml`에 선언된 기본 환경**이다.
Ops는 `reference: checkout_portfolio_ops_defaults`, 나머지는 `checkout_portfolio_service_defaults`와
각 파일의 SHA-256을 기록한다. `runtimePreflight.inspectedServices`에 검사한 네 서비스를 표시하고,
`scope: local_overrides_and_service_runtime`으로 비교 범위를 구분한다.
네 Deployment와 네 Service의 종류·식별자·resourceVersion·spec과 Chart·values 파일을 다시 읽어 검사 도중 변경도 거절한다.
Helm 실행 실패, 서비스별 Deployment·Service 누락·중복·다른 namespace, 렌더링 결과와 기본 환경의 불일치도
`UNKNOWN`으로 실패하며 계획을 출력하지 않는다.
이 비교를 최신 공개 이미지·발행된 Chart와의 전체 차이 검증으로 해석하지 않는다.
`configurationValuesIncluded=false`, `overlayGenerated=false`를 유지하며 기존 설정을 Argo values로
자동 복사하지 않는다. 표시된 차이가 모두 유지해야 할 설정이라는 뜻도 아니므로 항목별로 검토한다.

활성화 기록이 없어도 실제 `PREFECT_API_URL`이 비활성 기본값과 다르거나 확인 불가이면 차단한다.
검사 전후 Deployment·Service 식별자·설정·로컬 기록이 달라지거나 소유권·조회에 실패하면
`runtimePreflight.status: UNKNOWN`으로 실패하고 계획을 출력하지 않는다. 파일 삭제나 연결 해제는 하지 않는다.

충돌이 없을 때의 `NO_LOCAL_OVERRIDES`는 **이 검사 범위에서 기본 구성과 충돌하는 기록이 없다는 뜻**이다.
그 뒤에도 동일한 소스 CI·공개 발행 검증을 통과해야 계획이 생성된다. Docker·Compose 컨테이너 상태,
Secret 존재·키·DB schema, 이미지·노드 배치·NetworkPolicy 설정의 기준 차이, Service의 실제 통신·EndpointSlice 상태,
실제 probe 성공·자원 사용량·RBAC 권한·PVC 데이터·마운트 동작·관리자 인증이나 Argo 기동을 검증하지 않으며
`existingRuntimeVerified=false`를 유지한다. 실제 적용 전에는 전체 전환 절차가 필요하다.

### 현재 연결 설정을 Helm으로 재현해 보기

기본 환경과 차이가 있다면 다음 옵션으로 현재 환경변수·Secret 참조와 Ops sync 구성을
임시 values에 반영해 같은 checkout의 Chart로 렌더링할 수 있다.

```bash
python3 -B infrastructure/gitops/scripts/deployment.py plan-gitops \
  --branch main --state-dir "$OPS_STATE_DIR" --review-preservation
```

`runtimePreflight.preservationReview.helmPreservation`은 네 서비스의 환경변수와 Ops API/sync의
동일 환경을 재현한 뒤 실행·저장소·probe·자원·보안·Service 선언을 다시 비교한다. RabbitMQ 큐,
개인 관리자 로그인, Compose Prefect·결과 서버 연결을 기본값으로 덮지 않고 표현할 수 있는지
검토하는 단계다. Secret의 실제 값은 조회하지 않는다. 추가·누락된 컨테이너, `envFrom`, 평문
비밀번호·토큰, Chart가 표현할 수 없는 참조, API와 다른 sync 환경·이미지는 재현 대상으로 인정하지 않는다.
sync의 명령·마운트·보안·자원 차이도 비교하므로 컨테이너 이름만 같다고 일치로 처리하지 않는다.

- `MATCHES_INSPECTED_FIELDS`: 비교한 필드를 현재 Chart로 재현할 수 있음. 최신 발행 Chart와의
  호환성, 이미지·Secret 존재·DB schema·외부 연결·노드 배치·NetworkPolicy·실제 통신은 별도 검증이다.
- `BLOCKED`: 지원하지 않는 주입/컨테이너 구성이 있거나 렌더링 후에도 비교 필드에 차이가 있음.
- `UNKNOWN`: Helm 실행·렌더링 결과 비교를 완료하지 못함. 외부 오류 본문은 출력하지 않는다.

재현이 실패하거나 확인 불가이면 `preservation_not_verified`도 차단 목록에 추가한다.
기본 환경과 차이가 없더라도 요청한 재현 검사를 완료하지 못하면 공개 발행 검증·Argo 계획으로
넘어가지 않는다. `UNKNOWN`은 상위 `runtimePreflight.status`에도 반영한다.

보고서에는 상태·고정된 사유·차이 필드명만 포함한다. values는 임시 디렉터리에서만 사용하고 제거하며
출력·영구 저장·Argo 반영을 하지 않는다. 점검 전후 기존 리소스·Chart·로컬 기록의 변경도 재확인한다.
재현에 성공해도 기존 `runtime_transition_required`와 차단 목록은 유지된다. 공개 이미지·migration·
백업·실제 전환 검증을 대신하지 않으며, `--state-dir` 없는 계획이나 `verify-public`에는 사용할 수 없다.

## 배포 PR 없이 GHCR 이미지로 로컬 초기화

`fork_cluster.py up`은 개인 포크 기본 브랜치의 현재 SHA에 대해 다음을 직접 검증한다.

1. 최신 upstream 병합본과의 일치 및 다섯 CI의 필수 16개 job 성공.
2. 성공한 이미지 발행 run/attempt와 정확한 네 receipt의 저장소·SHA·checksum·Git tree.
3. 같은 Git 커밋의 Chart·values와 검증된 digest로 구성한 Helm 4.3.0 렌더링.
4. 무료 실행 정책, Secret 참조, Ops 앱과 동일 이미지의 필수 migration Job.
5. 렌더링 후 소스·CI 증거·최신 발행 run·artifact가 바뀌지 않았는지 재확인.

실행 흐름은 `up → 현재 발행 검증 → immutable Git 설정 + receipt → Helm 검사 → 이미지 pull 권한 확인
→ 전용 kind 초기화 → Ops migration → 서비스 준비 확인`이다.
검증 실패·만료 artifact·최신 발행 실패를 과거 이미지로 대신하지 않는다.
임시 디렉터리에서 렌더링하며 작업 브랜치·index·로컬 수정·원격 Git을 변경하지 않는다.
소스 객체가 없으면 `origin`에서 해당 SHA만 fetch한다.

Python 3.13·Git·Helm·kind 외에 GitHub CLI `gh`와 해당 포크의 CI·Actions artifact를 읽을 수 있는
로그인이 필요하다. `gh`의 GitHub 조회 인증과 이미지 pull용 `read:packages` 인증은 별개다.
[공개 패키지 준비](../../../docs/public-ghcr-transition.md) 또는
[비공개 패키지 준비](../../../docs/private-ghcr-setup.md)를 마친 뒤 저장소 루트에서 실행한다.

```bash
gh auth status
python -B infrastructure/gitops/scripts/fork_cluster.py init
python -B infrastructure/gitops/scripts/fork_cluster.py doctor
python -B infrastructure/gitops/scripts/fork_cluster.py up
python -B infrastructure/gitops/scripts/fork_cluster.py status
```

비공개 이미지는 기존 숨김 입력/`--token-file` 방식으로 pull Secret을 준비하고 공개 이미지는
익명 digest 조회를 확인한다. `up` 완료 후 로컬 `baseline.json`의 `release`에 소스 SHA·발행 run·digest를 기록한다.
로컬 소스의 `up --local-images`는 `gh`·GHCR 없이 계속 사용한다.
로컬 `integrations.json` override는 검증된 발행 설정에 섞지 않으며 해당 연동은 소스 이미지 경로를 사용한다.

이 경로는 명시적인 로컬 초기화이며 Argo 자동 배포가 아니다. 기존 GitOps 모드의 인증 갱신은
그 환경이 고정한 과거 snapshot의 이미지를 계속 확인한다. 새 Argo 전환 경로는 아직 제공하지 않는다.
GitHub 조회와 클러스터 적용 전체를 하나의 transaction으로 잠그지는 않으며,
선택한 이미지의 변경 불가능한 digest와 확인한 소스 SHA를 기준으로 초기화한다.

## 로컬 검증 도구

`scripts/promote_image.py`는 기존 `environments/fork/<service>.yaml`의 digest diff를 확인·편집하는
로컬 도구다. push·PR 생성·클러스터 변경은 하지 않는다.
`sync_images.py`의 receipt 출처·checksum·Git tree 검증과 values 구성 함수도 보존한다.
`release.json`의 형식 검증만으로 GitHub CI·실제 pull·서비스 기동이 증명되지는 않는다.

```bash
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_promote_image.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_sync_images.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_deployment.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_published_release.py'
```

Python 3.13, Helm 4.3.0과 GitOps requirements가 필요하다.
[이미지 발행 최초 설정](../../../docs/msa-image-release.md)
