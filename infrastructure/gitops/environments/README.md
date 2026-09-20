# 환경별 배포 상태

상태: **`local-msa/`에 Core·Catalog·AI·Ops의 독립 Helm values를 구현했다.**
템플릿은 `../charts/`에 있으며, `../argocd/local/`의 Application이 각 values를 참조한다.
기존 `services/ops-service/base`·`local/ops-service`·`local/ops-mysql`은 Ops 단독 Kustomize 검증용으로 유지한다.
클라우드 운영 클러스터·`prod` overlay는 없으며 EKS를 생성하지 않는다.
`portfolio/`는 이전 Mac 유지형 kind의 비공개 GHCR digest를 보존한 템플릿이다. `localMode: false`는
로컬 mutable tag를 금지한다는 의미이며 클라우드 운영을 뜻하지 않는다.
`portfolio/`를 새 팀원에게 직접 적용하지 않는다. 과거 portfolio 자동 sync는 잠긴 채 유지한다.
새 `fork/`는 **개인 포크에서 upstream 병합 소스 동기화와 CI 검증을 마친 뒤** 본인 비공개 GHCR의 네 image digest를
승격 workflow가 기록하는 경로다. 첫 발행 전에는 디렉터리/가짜 digest를 만들지 않는다.
[개인 fork 시작·모드 전환](../docs/portfolio-gitops.md)의 공통 CLI가 이를 읽는다. 기존 `govbiz-portfolio`는 인수하지 않는다.

애플리케이션 코드·Dockerfile·테스트·로컬 Compose는 같은 저장소 루트에서 관리한다.
향후 이 디렉터리는 승인된 각 환경의 원하는 실행 상태를 관리한다.
소스 폴더명과 Deployment·Service·컨테이너는 각 서비스명을 따른다.
[서비스명·배포 식별자 대응 표](../README.md#서비스명과-배포-식별자)를 참고한다.

## 배포 설정에 기록할 것

| 항목 | 기준 |
| --- | --- |
| 이미지 | 서비스별 GHCR 저장소와 고정 digest; 변경되지 않은 서비스 버전은 유지 |
| 추적 정보 | 서비스 소스 SHA·이미지 digest·설정 revision의 대응 관계 |
| 실행 설정 | replica, CPU·메모리, startup/readiness/liveness, 종료 유예 |
| 네트워크 | 내부 Service, 외부 라우팅·TLS, 접근 정책 |
| 비밀·데이터 | 비밀 저장소 참조, 소유 DB·스토리지·백업 정책; 실제 비밀값은 제외 |
| 복구 조건 | 이전 승인 digest, API·DB migration 호환성, 데이터 복구 제한 |

Ops 단독 검증은 Kustomize, 네 서비스 전체 검증은 Helm을 사용하며 DB 설정은 로컬 검증에만 둔다.
같은 대상 리소스에 두 방식을 동시에 적용하지 않는다.
local의 `govbiz-ops-service:local-k8s`는 registry에서 다운로드하는 운영 릴리스가 아니라,
smoke가 검증한 로컬 고유 이미지 태그로 교체하고 kind에 적재하는 자리다.
운영에서는 위 표처럼 승인된 digest를 기록해야 하며 로컬 태그를 그대로 복사하지 않는다.
개발 환경과 운영 환경을 이름만 다르게 복사하거나 임의의 도메인·계정·클러스터 값을 넣지 않는다.

## 변경 흐름과 안전장치

아래 흐름을 공통 workflow와 CLI로 구현했다. 개인 포크마다 Actions·발행/승격 변수·읽기 토큰을 최초 준비해야 하며,
코드를 클론하는 것만으로 계정 설정이나 실제 배포 검증까지 끝난 것은 아니다.

1. 교육기관 upstream PR 병합 후 본인 원격 fork의 기본 브랜치를 동기화한다. 개인 미병합 작업 코드는 발행하지 않는다.
2. 네 CI 통과와 upstream 소스 일치를 검증한 뒤 본인 비공개 GHCR에 이미지를 발행한다.
3. 같은 fork의 `environments/fork` values와 `release.json`만 검증·갱신한다.
4. 명시적 GitOps 모드에서 Argo CD가 본인 fork·본인 kind에 자동 sync/self-heal한다. prune는 끈다.

개발 모드에서는 같은 이미지로 시작한 뒤 `dev.py --watch`가 로컬 저장을 감지해 변경 서비스만 재빌드/적재한다.
Argo Application을 두지 않으므로 self-heal이 개인 작업을 덮어쓰지 않는다. 로컬 재빌드는 GHCR 업로드가 아니다.

`latest` 태그 갱신이나 submodule 커밋 갱신을 배포 버전 관리로 대신하지 않는다.
이미지 되돌리기는 DB 데이터 되돌리기가 아니며, 파괴적 migration은 별도 승인·복구 절차가 필요하다.
같은 환경·서비스를 수동 명령, SSM, Argo CD가 경쟁해서 변경하는 다중 배포 주체를 만들지 않는다.

현재 운영 환경은 없으며, EC2 Compose·CodeBuild·SSM 재배포용 설정은 같은 저장소의 `infrastructure/`에 그대로 둔다.
새 Kubernetes 경로의 검증과 운영 전환을 승인하기 전에는 이를 대체하거나 자동 실행하지 않는다.

관련 문서: [포크 개발 환경](../../../docs/local-fork-development.md), [Argo CD 경계](../argocd/README.md), [로컬 검증](../docs/kubernetes-local.md)

전체 실행 방법·범위는 [로컬 MSA·Helm·GitOps 안내](../docs/msa-local.md)를 따른다.
