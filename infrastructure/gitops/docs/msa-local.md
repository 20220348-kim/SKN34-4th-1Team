# 로컬 MSA·Helm·GitOps 검증

통합 후 이 문서의 상대 경로는 `infrastructure/gitops/` 기준입니다. 앱과 manifest는 같은
교육기관 저장소의 `main`에 있습니다. 이전 실행 기록은 원본 저장소에서의 결과이며,
통합 경로의 실제 클러스터 재검증·팀원 Windows 검증은 별도입니다.

이 단계는 Core·Catalog·AI·Ops의 **독립 실행·배포 기반**이다. 모든 Core 업무를 분리하거나
Ops 관리자 인증·LLMOps 업무, AWS 운영·고가용성까지 완성했다는 뜻은 아니다.

## 배포 구성

- `charts/govbiz-service`: 서비스 하나당 Deployment·ClusterIP Service. 네 서비스는 각자 별도 릴리스다.
- `environments/local-msa/*.yaml`: 서비스별 이미지·환경 설정·자원·probe·자기 Secret의 참조.
- `charts/govbiz-local-data`: 로컬 검증 전용 Core/Catalog/Ops MySQL과 Elasticsearch/Qdrant/Redis.
  명시적인 `allowDisposableData=true`가 필요하며 운영 DB 차트로 사용하지 않는다.
- `argocd/local/`: 네 Application과 저장소·namespace·리소스 종류를 제한한 AppProject.
  처음에는 수동 sync이며 원격에 해당 경로가 존재하기 전에 적용하지 않는다.

기존 Ops Kustomize 예제는 `govbiz-local`, 새 Helm 검증은 `govbiz-msa` namespace다.
동일 Deployment를 두 도구가 동시에 관리하지 않는다. 상태 저장소·Secret·namespace는
서비스 Application에서 관리하지 않으므로 앱 삭제·prune가 데이터를 삭제하지 않는다.
PVC는 StatefulSet 삭제/축소 시 Retain이지만 **kind 클러스터 삭제는 그 안의 테스트 데이터도 삭제한다.**

## 실행 전 조건

Python 3.13 + `scripts/requirements.txt`, Helm 4.3.0, kubectl 1.36.4, kind 0.33.0,
Docker Engine을 사용한다. 새 cluster와 임시 kubeconfig를 만들며 현재 kubeconfig는 변경하지 않는다.
16GB PC에서는 기존 전체 Compose와 동시에 실행하지 않는다. 기존 GovBiz 컨테이너를 중지할 때는
사용자 승인과 복구 계획이 필요하며 `down -v`, volume prune 등으로 개발 데이터를 지우지 않는다.

**통합 저장소 루트**에서 이미지를 순차 빌드한다. 기존 태그는 덮어쓰지 않는다.

```bash
python infrastructure/scripts/build-msa-images.py \
  --tag msa-20260920-001 --output /tmp/govbiz-msa-images.json
```

그 다음 **같은 저장소의 `infrastructure/gitops/`**에서 실행한다.
출력 JSON 경로는 아직 없는 새 파일을 지정한다.

```bash
cd infrastructure/gitops
python -m pip install -r scripts/requirements.txt
python -B scripts/check_msa.py
python -B scripts/smoke_msa.py \
  --images /tmp/govbiz-msa-images.json --report /tmp/govbiz-msa-report.json
```

도구가 PATH에 없다면 `--helm /검증된/helm`, `--kind /검증된/kind`를 지정한다.
이 검증은 실제 앱 이미지와 MySQL·Elasticsearch·Qdrant를 사용하되 공공 API·OpenAI는
로컬 HTTP 스텁만 사용한다. 사용자 `.env`, SMTP, 기존 데이터는 읽지 않는다.
테스트 Secret은 실행 시 생성하고 Git·결과 보고서에 값을 남기지 않는다.

## 검증 시나리오와 한계

1. Kubernetes API 서버의 strict dry-run과 실제 네 서비스 기동.
2. Catalog 내부 토큰 거절, 4개 제공처 42개 fixture 공고의 Core HTTP projection.
3. Core DB 자격 증명으로 Catalog DB 접근 시 실제 인증 거절.
4. AI 설정만 바꿨다가 복귀했을 때 다른 서비스 Pod UID 유지.
   이는 **설정 롤아웃**이며 새 AI 코드·이미지 버전을 검증한 것으로 표현하지 않는다.
5. Catalog 중단 시 Core의 이전 공개 공고 조회 유지.
6. Ops 테스트 테이블의 한글 데이터 dump·삭제·복원, DB Pod 재생성 후 PVC 유지.
   전체 운영 DB·시점 복구(PITR) 검증은 아니다.

Core·AI의 현재 readiness는 process health를 사용한다. Catalog와 Ops는 별도 DB readiness가 있다.
Core 의존성 readiness, 실제 CNI의 NetworkPolicy 집행, 모든 내부 API 인증, Ops 관리자 인증·업무,
장기 유료 작업의 Pod 종료/중복 실행, 부하·HPA·클라우드 배포는 아직 별도 작업이다.
replicas=1 및 Recreate는 중복 writer를 피하기 위한 초기 제한이며 잠깐의 중단을 허용한다.
로컬 Kubernetes에서 검증했다고 무중단·자동 수평 확장·실제 AI 품질을 보장하지 않는다.

## GitOps 연결 경계

Application은 `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/main`의
`infrastructure/gitops/` 아래 해당 서비스 값만 읽는다. Secret은 별도 주입하며
클러스터 생성·데이터 저장소 초기화를 Argo 앱 sync에 숨기지 않는다.
GHCR 이미지 공개 범위·pull 권한과 Git 저장소 읽기 권한은 별개다. `localMode=false`인 서비스는 이미지 digest가 필수다.
로컬 `local-k8s` 태그와 `imagePullPolicy: Never`는 검증 클러스터에 이미지를 미리 넣는 용도이며,
클라우드 운영 또는 CI에서 자동 이미지 발행이 완료된 구성이 아니다.

실제 Git fetch·자동 동기화를 함께 검사하려면, 로컬 검증이 통과한 구성을 먼저 GitHub에 올린 뒤
아래 옵션을 추가한다. 첫 SHA는 기준 통합 커밋, 두 번째 SHA는 **AI values의 비밀이 아닌 설정만**
바꾼 커밋이어야 한다. 각각 40자리 SHA를 쓰며 두 revision 모두 원격에 있어야 한다.

```bash
python -B scripts/smoke_msa.py \
  --images /tmp/govbiz-msa-images.json --report /tmp/govbiz-msa-gitops-report.json \
  --gitops-revisions "$BASE_SHA" "$AI_ONLY_SHA"
```

이 옵션은 새 임시 클러스터에 공식 Argo CD Core v3.5.3을 설치하고 기준 revision을 수동 동기화한다.
그 다음 자동 동기화를 켜 두 번째 revision → 기준 revision으로 변경하며 AI Pod만 교체되는지 확인한다.
리소스 추적은 annotation을 사용해 Argo Application 이름이 Helm의 Service selector를 덮어쓰지 않도록 한다.
검증 후 Argo CD를 포함한 임시 클러스터를 삭제한다. 기존 AWS·Kubernetes 컨텍스트에는 접근하지 않는다.
고정 Git revision의 reconciliation 검증이며, 브랜치 push webhook·이미지 발행 CI·상시 자동 배포를
완성했다는 의미는 아니다. 검증에 사용한 AI 설정 변경은 이후 Git에서도 되돌릴 수 있다.

아직 변경을 커밋하지 않은 대화형 검증에서는 `--gitops-revisions` 대신 `--gitops-interactive`를
사용할 수 있다. 로컬 실행 검사를 모두 통과한 뒤에만 SHA 입력을 기다리므로, 그 시점에 검토한
변경을 커밋·푸시하고 두 SHA를 입력하면 같은 클러스터에서 GitOps 검증을 이어 간다.
터미널 전용 옵션이며 중단하려면 Ctrl-C를 누른다. 종료 시 자신이 만든 클러스터만 정리한다.

Argo CD 공식 문서: [Helm 사용](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/),
[프로젝트 권한](https://argo-cd.readthedocs.io/en/stable/user-guide/projects/),
[Core 설치 방식](https://argo-cd.readthedocs.io/en/stable/operator-manual/core/).
