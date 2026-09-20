# 네 서비스 로컬 MSA 검증 — 2026-09-20

> 원본 GovBiz/GovBiz-infra와 당시 로컬 Mac에서 수행한 **과거 검증 기록**입니다.
> 아래 SHA·경로·이미지·결과는 원래 값을 보존하며 통합 저장소·개인 fork·Windows 재검증 결과가 아닙니다.
> 현재 경로는 [통합 GitOps 안내](../README.md)를 따릅니다.

범위는 로컬 Compose와 임시 kind 클러스터다. AWS·실제 환경 파일·기존 데이터 볼륨·유료 API는
사용하지 않았다. 기존 GovBiz 개발 컨테이너만 사용자 승인으로 중지했으며 검증 종료 시 복구한다.

최종 실행 결과는 `status=passed`다. 검증 후 임시 kind 클러스터·그 안의 테스트 데이터를 삭제했고,
기존 GovBiz 컨테이너 7개를 다시 시작했다. 기존 개발 볼륨과 관련 없는 컨테이너는 변경하지 않았다.

## 도구와 이미지

- Kubernetes 1.36.4, kind 0.33.0, Helm 4.3.0, MySQL 8.4.
- 새 클러스터: `govbiz-msa-smoke-65bae80ef6`. 개인 kubeconfig와 다른 별도 임시 kubeconfig 사용.
- 앱 이미지 태그: `msa-20260920-001`. GovBiz `8b2644b3f6d29184180c972adb9dbe1b2fce05ab`
  기반 작업 트리에서 빌드했다(`dirty=true`). 이번 변경은 Compose·검증 도구·문서이며 서비스 업무 코드는 변경하지 않았다.
- 원격 이미지 업로드 없음. 공공 제공처와 OpenAI는 로컬 HTTP 스텁으로 대체했다.

검증 시 확인한 Docker 이미지 ID(원격 ECR 릴리스 digest가 아님):

| 서비스 | 이미지 ID |
| --- | --- |
| Core | `sha256:98dc2d0368c4528a4ebff4ee905f3e7ac2036fa94e5da9816bd3f13021cba7a3` |
| Catalog | `sha256:9f11ee1b70156aff70dda3d994541844cba93d1cc90033ed0304ad3c036329a2` |
| AI | `sha256:2bbd1adcebeb6c32ca5787512b5f33db5832bb868e09fc97de0b0f28d9bc499e` |
| Ops | `sha256:c9c582c69ccb55ac269ab640215f4189a401a5e26459264fa61238dfc0a056d9` |

## 통과한 검증

| 범위 | 결과 |
| --- | --- |
| Core | JDK 21 `clean build`, 1,512개 테스트 통과·건너뜀 없음 |
| Catalog | JDK 21 `clean build`, 286개 테스트 통과·건너뜀 없음 |
| AI | `uv run --locked --extra dev python -m pytest`, 실제 임시 Qdrant를 포함한 1,345개 통과 |
| 앱 검증 도구 | 87개 중 71개 통과, 별도 opt-in 데모 DB 검증 16개 미실행 |
| Infra | 50개 단위 테스트, 네 서비스·로컬 저장소 Helm strict lint, Kustomize·구성·문서 링크 검사 통과 |
| Compose 실제 연동 | 네 제공처 snapshot·checkpoint, DB 분리, 실제 색인과 스텁 임베딩 검색, 제공처 실패·Catalog 중단 시 Core 데이터와 검색 보존 |
| Kubernetes admission·기동 | 서버 strict dry-run, Core·Catalog·AI·Ops 및 MySQL 3개·ES·Qdrant·Redis 정상 준비 |
| 내부 계약·데이터 경계 | 토큰 누락/불일치 401, 4개 제공처 공고 42개 HTTP 복제, Core DB 계정의 Catalog DB 접근 1045 거절 |
| 독립 설정 배포 | AI 설정만 변경·복귀할 때 Core·Catalog·Ops Pod UID 유지 |
| 장애 격리 | Catalog 중단 동안 Core 공고 데이터와 공개 조회 유지, 이후 Catalog 복구 |
| 데이터 복구 | Ops의 임시 한글 테스트 테이블 dump·삭제·복원, DB Pod 교체 후 PVC 데이터 유지 |

첫 Compose 실행은 콜드 MySQL 초기화가 개발용 healthcheck 예산을 넘어 실패했다.
DB 자체는 정상 준비됨을 확인한 뒤, **임시 검증 overlay만** CLI timeout에 맞춰 대기하도록 수정하고
전체 Compose 시나리오를 다시 실행해 통과했다. 실제 개발·운영 healthcheck 값을 완화하지 않았다.
Kubernetes Qdrant는 non-root 실행에 맞게 스냅샷 경로를 자신의 PVC 안으로 지정했다.

## GitOps 상태

공식 Argo CD Core **v3.5.3**을 같은 임시 클러스터에 설치해 아래 흐름을 실제로 통과했다.
설치 manifest SHA-256은 `1a87025d8eb2eae621653fd312fb9ca51df1b4b3b6992a030e3a9ef38e45c448`이다.

| 순서 | 원격 GovBiz-infra revision | 결과 |
| --- | --- | --- |
| 최초 수동 동기화 A | `35f429c83fac39d1823c902e467772f7ed90ec23` | 네 Application 모두 Synced/Healthy |
| 자동 동기화 B | `0e29a51f2959eb94b74d87509c49785c101011a0` | AI 환경 설정 표식만 변경, AI Pod만 교체 |
| 자동 복귀 A | `35f429c83fac39d1823c902e467772f7ed90ec23` | 네 Application 모두 Synced/Healthy, AI Pod만 다시 교체 |

B는 `environments/local-msa/ai-service.yaml`의 비밀이 아닌 표식 한 줄만 변경했다.
검증 후 표식은 Git에서도 제거했다. 다른 세 서비스의 Pod UID는 B 반영·A 복귀 동안 유지됐다.
각 Application은 GitHub에서 고정 SHA의 Helm 설정을 가져왔으며 로컬 values를 주입해 대체하지 않았다.
이미지는 앞서 검증한 로컬 빌드를 노드에 적재해 사용했다. 기존 Docker 태그를 덮어쓰지 않았다.

이 검증은 **Git revision reconciliation** 증거다. 브랜치 push webhook, 새 코드의 이미지 발행·ECR 업로드,
상시 클러스터 자동 배포까지 검증한 것은 아니다. Core 구성에는 웹 UI·OIDC가 없으며,
체크인된 최초 sync 정책은 수동이다. 테스트에서만 자동 sync·self-heal을 켜고 prune는 끈 상태로 확인했다.
[실행 안내](msa-local.md#gitops-연결-경계)에서 같은 검증을 재현할 수 있다.

## 해석 제한

- AI 롤아웃은 **환경 설정 변경**이며 새 AI 코드·이미지 버전 검증이 아니다.
- Ops 데이터 복원은 새 테스트 테이블에 한정한다. 운영 전체 DB 백업·PITR 검증이 아니다.
- 모든 내부 API 인증·NetworkPolicy 집행, Core·AI 의존성 readiness, 부하/HPA와 무중단 배포는 미검증이다.
- Ops 관리자 인증·LLMOps 업무, 이미지 발행 CI·ECR·상시 클러스터 자동 배포, AWS 운영은 미구현이다.
- 스텁 테스트를 실제 공공 API 연동·유료 AI 품질 평가로 해석하지 않는다.
- replicas=1·Recreate 정책은 writer 중복을 피하기 위한 초기 제약이며 짧은 중단을 허용한다.
