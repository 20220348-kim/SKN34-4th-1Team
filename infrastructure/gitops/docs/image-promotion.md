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

전용 loopback 클러스터·소유권과 dev 모드를 확인하고, 로컬 연결 기록 및 현재 Ops Deployment를 읽는다.
Secret 값·환경변수 값은 보고서에 출력하지 않는다. 다음 충돌은 종료 코드 1과
`reason: runtime_transition_required`, `runtimePreflight.status: BLOCKED`로 반환한다.

| 차단 코드 | 필요한 확인 |
|---|---|
| `local_integration_profile` | 기본 Argo values에 포함되지 않은 개인 연동 설정의 보존 방법 |
| `local_development_images` | 개발 이미지 override의 명시적인 정리·전환 |
| `connected_or_unverified_ops` | Ops 활성화·브리지 기록 또는 Prefect 연결과 최초 migration 절차 |
| `ops_container_layout_differs` | 기본 계획에 없는 `ops-sync` 등 컨테이너 구성의 보존 방법 |

활성화 기록이 없어도 실제 `PREFECT_API_URL`이 비활성 기본값과 다르거나 확인 불가이면 차단한다.
검사 전후 Deployment 식별자·설정·로컬 기록이 달라지거나 소유권·조회에 실패하면
`runtimePreflight.status: UNKNOWN`으로 실패하고 계획을 출력하지 않는다. 파일 삭제나 연결 해제는 하지 않는다.

충돌이 없을 때의 `NO_LOCAL_OVERRIDES`는 **이 검사 범위에서 기본 구성과 충돌하는 기록이 없다는 뜻**이다.
그 뒤에도 동일한 소스 CI·공개 발행 검증을 통과해야 계획이 생성된다. Docker·Compose 컨테이너 상태,
Secret 존재·키·DB schema, 모든 서비스의 설정 차이, 관리자 인증이나 Argo 기동을 검증하지 않으며
`existingRuntimeVerified=false`를 유지한다. 실제 적용 전에는 전체 전환 절차가 필요하다.

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
