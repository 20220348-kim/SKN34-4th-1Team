# Argo CD 구성 경계

## 통합 저장소 기준

공통 [fork_cluster.py](../scripts/fork_cluster.py)는 로컬 `origin`의 실제 개인 포크와 기본 브랜치를 읽어
네 Application과 제한된 AppProject를 생성합니다. Chart 경로는
`infrastructure/gitops/charts/govbiz-service`, values는 `../../environments/fork/<서비스>.yaml`입니다.
`gitops` 명령 전에는 Argo Application을 만들지 않습니다. 초기화한 전용 kind의 kubeconfig·node·소유권 표식을 확인하고,
이전 `govbiz-portfolio`나 다른 계정 환경을 인수하지 않습니다. [실행 절차](../docs/portfolio-gitops.md)를 따릅니다.

이 디렉터리에 보존한 `local/`과 `portfolio/`는 별도의 과거/격리 검증 경로입니다. 그 YAML의 `repoURL`은 교육기관
통합 저장소이고 최초 sync는 수동입니다. portfolio의 이전 GovBiz-Team 이미지와 잠긴 `portfolio_cluster.py`를
신규 개인 포크의 설정으로 사용하지 않습니다. 파일 변경만으로 기존 실행 클러스터에 적용되지는 않습니다.

상태: **로컬용 Application 4개와 AppProject 정의를 구현했다.** `local/`에서
Core·Catalog·AI·Ops의 Helm 배포를 별도로 관리한다. 최초 sync는 수동이며 운영에 연결하지 않는다.
이전 원본 저장소에서는 Argo CD Core 3.5.3을 임시 kind에 설치해 원격 Git A → B → A 동기화와 AI만의 Pod 교체·복귀를
검증했다. 해당 [과거 실행 기록](../docs/msa-validation-20260920.md)은 새 팀원 계정·Windows 검증을 뜻하지 않는다.
Core 설치는 웹 UI 없이 동기화 엔진을 검증하는 방식이다. 테스트 중에만 자동 동기화를 켰으며,
`local/` Application의 최초 sync는 계속 수동이다. 이 임시 검증은 상시 운영 환경이 아니다.

별도의 `portfolio/`는 이전 Mac 유지형 환경에서 가져온 템플릿이다. `environments/portfolio`의
과거 GHCR digest를 보존하며 Secret·DB·PVC는 관리하지 않는다. 새 fork용 설정 완료 전 적용하지 않는다.

## 이 디렉터리에 들어갈 내용

- AppProject: 허용하는 소스 저장소, 대상 클러스터·namespace, 배포 리소스 종류
- Application: 서비스별 환경 경로, 추적할 승인된 revision, 대상 namespace와 동기화 정책
- 로컬 검증 후 운영 연결로 전환하는 부트스트랩·권한·복구 절차

과거 로컬 검증 Application은 `../environments/local-msa/`, 새 개인 포크 Application은 검증된 `../environments/fork/`를 읽는다.
둘 다 `../charts/govbiz-service`를 사용한다. 대상 namespace는 `govbiz-msa`이며 Deployment·Service만 허용한다. 기존 Ops Kustomize
예제의 `govbiz-local`과 분리하고 Secret·PVC·클러스터 관리 권한을 앱에 주지 않는다.

## 연결 전 통과 조건

1. 대상 로컬 클러스터와 전용 kubeconfig를 확인하고 기존 운영 컨텍스트를 사용하지 않는다.
2. 최소 서비스의 불변 이미지 digest, 상태 확인, 자원 제한, 격리된 검증 데이터를 준비한다.
3. manifests의 렌더링·스키마·정책 검증을 통과하고 읽을 Git 경로·revision을 원격에 확정한다.
4. 새 포크에서는 `gitops` 명령으로 자동 sync/self-heal을 명시적으로 활성화한다. prune는 끈다. 네 앱의 Synced/Healthy를 따로 확인한다.
5. 이미지 변경이 지정 서비스에만 적용되는지, 기존 버전 복귀·권한 제한·장애 복구를 확인한다.
6. 운영으로 전환할 때 같은 환경·서비스의 기존 SSM 등 배포 주체를 정리한다. 두 도구가 같은 대상을 갱신하지 않는다.

Argo CD는 Docker 이미지를 빌드하지 않고 GHCR의 최신 태그를 자동으로 선택하지 않는다.
이미지 발행·fork digest 선택은 별도 workflow가 담당한다. 개인 포크의 최초 opt-in 후에도
**upstream에 병합된 소스가 본인 원격 fork 기본 브랜치로 동기화되고 네 CI를 통과해야** 발행한다.
교육기관 GHCR에는 발행하지 않으며 개인 미병합 코드 push나 로컬 pull만으로도 발행하지 않는다.
다른 운영 환경은 별도로 승인하며 임의 환경을 자동 갱신하지 않는다.
프론트를 Vercel에 유지한다면 해당 배포는 이 디렉터리의 관리 대상이 아니다.

Git 저장소 읽기 자격 증명과 GHCR 이미지 공개 범위·pull 권한은 별개다. 실제 토큰·비밀번호·kubeconfig는 이 저장소에 넣지 않는다.

## 로컬 개발과 충돌 방지

기본 `up`은 개발 모드로 Helm을 로컬 렌더링해 적용하고 Argo가 서비스들을 관리하지 않는다.
`dev.py --watch`는 바뀐 소스만 로컬 빌드·kind에 적재한다. GitOps로 바꾸려면 watcher 종료와 `dev.py --restore`,
clean/pushed 설정·개인 release·읽기 인증 확인을 먼저 마친다. 반대로 `fork_cluster.py dev`는 자동 sync를 끄고,
진행 중인 operation이 없을 때만 Application을 orphan 삭제한다. 서비스·DB는 보존하고 Argo tracking만 제거한다.
실행 중인 sync가 있으면 작업이 끝날 때까지 멈추므로 컨트롤러와 로컬 watcher가 동시에 이미지를 바꾸지 않는다.

관련 문서: [전체 전환 설계](../docs/msa-kubernetes-argocd-plan.md), [환경별 설정 기준](../environments/README.md)
