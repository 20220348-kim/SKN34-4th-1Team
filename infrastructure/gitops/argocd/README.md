# Argo CD 구성 경계

## 통합 저장소 기준

Application의 `repoURL`은 `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`, revision은 `main`,
Chart 경로는 `infrastructure/gitops/charts/govbiz-service`입니다. `local/`은 최초 수동 sync이고,
`portfolio/`도 이번 제출본에서 자동 sync·self-heal·prune를 껐습니다.
portfolio의 기존 GovBiz-Team 비공개 이미지는 과거 검증 자료로만 보존합니다.
기존 개인 Mac bootstrap은 잠겼으며 [개인 fork 전환 조건](../docs/portfolio-gitops.md)을 먼저 충족해야 합니다.
이 파일 변경은 이미 실행 중인 Mac 클러스터에 적용하지 않습니다.

상태: **로컬용 Application 4개와 AppProject 정의를 구현했다.** `local/`에서
Core·Catalog·AI·Ops의 Helm 배포를 별도로 관리한다. 최초 sync는 수동이며 운영에 연결하지 않는다.
Argo CD Core 3.5.3을 임시 kind에 설치해 원격 Git A → B → A 동기화와 AI만의 Pod 교체·복귀를
검증했다. [실행 기록](../docs/msa-validation-20260920.md)과 [실행 방법](../docs/msa-local.md)을 따른다.
Core 설치는 웹 UI 없이 동기화 엔진을 검증하는 방식이다. 테스트 중에만 자동 동기화를 켰으며,
`local/` Application의 최초 sync는 계속 수동이다. 이 임시 검증은 상시 운영 환경이 아니다.

별도의 `portfolio/`는 이전 Mac 유지형 환경에서 가져온 템플릿이다. `environments/portfolio`의
과거 GHCR digest를 보존하며 Secret·DB·PVC는 관리하지 않는다. 새 fork용 설정 완료 전 적용하지 않는다.

## 이 디렉터리에 들어갈 내용

- AppProject: 허용하는 소스 저장소, 대상 클러스터·namespace, 배포 리소스 종류
- Application: 서비스별 환경 경로, 추적할 승인된 revision, 대상 namespace와 동기화 정책
- 로컬 검증 후 운영 연결로 전환하는 부트스트랩·권한·복구 절차

현재 Application은 `../charts/govbiz-service`와 서비스별 `../environments/local-msa/` 값을 읽는다.
대상 namespace는 `govbiz-msa`이며 Deployment·Service만 허용한다. 기존 Ops Kustomize
예제의 `govbiz-local`과 분리하고 Secret·PVC·클러스터 관리 권한을 앱에 주지 않는다.

## 연결 전 통과 조건

1. 대상 로컬 클러스터와 전용 kubeconfig를 확인하고 기존 운영 컨텍스트를 사용하지 않는다.
2. 최소 서비스의 불변 이미지 digest, 상태 확인, 자원 제한, 격리된 검증 데이터를 준비한다.
3. manifests의 렌더링·스키마·정책 검증을 통과하고 읽을 Git 경로·revision을 원격에 확정한다.
4. 최초 AppProject·Application은 검토 후 명시적으로 동기화한다. 자동 동기화·prune·self-heal은 각각 별도 판단한다.
5. 이미지 변경이 지정 서비스에만 적용되는지, 기존 버전 복귀·권한 제한·장애 복구를 확인한다.
6. 운영으로 전환할 때 같은 환경·서비스의 기존 SSM 등 배포 주체를 정리한다. 두 도구가 같은 대상을 갱신하지 않는다.

Argo CD는 Docker 이미지를 빌드하지 않고 GHCR의 최신 태그를 자동으로 선택하지 않는다.
이미지 발행과 portfolio digest 선택은 별도 workflow의 책임이나 통합본에서는 둘 다 잠겨 있다.
다른 운영 환경은 별도로 승인하며 임의 환경을 자동 갱신하지 않는다.
프론트를 Vercel에 유지한다면 해당 배포는 이 디렉터리의 관리 대상이 아니다.

Git 저장소 읽기 자격 증명과 GHCR 이미지 공개 범위·pull 권한은 별개다. 실제 토큰·비밀번호·kubeconfig는 이 저장소에 넣지 않는다.

관련 문서: [전체 전환 설계](../docs/msa-kubernetes-argocd-plan.md), [환경별 설정 기준](../environments/README.md)
