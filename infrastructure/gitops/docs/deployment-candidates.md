# 전체 배포 후보와 수동 승인

소스는 개인 포크 기본 브랜치(보통 `main`), 승인된 서비스 배포 입력은 같은 포크의
`deploy/fork`로 구분한다. 자동화는 `candidates/fork/<source SHA>-<run>-<attempt>`에
후보를 만들고 PR을 연다. **리뷰 승인 후 사람이 수동 병합**하며 bot은 소스·배포 브랜치에 직접 push하지 않는다.
이 문서는 구현과 설정 절차다. 원격 브랜치·Ruleset·리뷰 담당자·실제 Argo 전환을 자동 설정하지 않는다.

## 후보에 포함되는 것

| 입력 | 기록 위치 (`infrastructure/gitops/` 기준) |
| --- | --- |
| 같은 소스 SHA의 서비스 Chart 전체 | `charts/govbiz-service/` |
| 네 서비스의 개인 GHCR digest·실행 설정 | `environments/fork/*.yaml`, `release.json` |
| 발행 artifact에서 검증한 네 receipt | `receipts/*.json` |
| Helm 4.3.0, Kubernetes 1.36.4로 렌더링한 Deployment·Service·Ops PreSync Job | `rendered/*.json` |
| 제한된 AppProject와 네 Application 선언 | `argocd/fork/applications.yaml` |
| 소스·기존 배포 SHA, CI run/attempt, publisher, 파일 hash와 전체 hash | `deployment.json` |

배포 브랜치에는 실행용 Python·workflow를 복사하지 않는다. 소스 Git blob으로 후보를 다시 구성하고
모든 파일의 바이트를 비교한다. 파일을 고치고 자체 hash를 다시 계산해도 통과하지 않는다.
이미지를 재사용하는 Chart-only·values-only 변경도 새 소스 CI와 새 전체 후보를 거친다.
미추적 파일, symlink, 외부 Chart dependency, 무료 실행 정책 위반, 렌더링된 이미지 불일치는 거절한다.
비밀값은 후보에 넣지 않고 기존 Secret 참조만 사용한다. 이미 소스에 커밋된 비밀값을 정화하는 도구는 아니다.

새 후보 `govbiz-deployment-v2`는 Ops migration Job과 제한된 Job 권한·재시도 정책을 포함한다.
실제 렌더링의 Job 이미지·설정·명령·보안 계약을 검사한다.
과거 v1은 원본 소스로 재구성해 읽을 수 있지만 새 승인에는 v2가 필요하다.
[Ops migration 실행·복구 경계](ops-migration.md)를 따른다.

이 범위는 네 서비스의 배포 입력이다. 로컬 데이터 Chart·kind 저장소·백업·전체 LLMOps 운영 구성이나
실제 migration 성공까지 검증하지 않는다. 네 Application의 rollout도 원자적이지 않다.

## 원격 활성화 순서

1. 이전 `MSA_PROMOTION_ENABLED`를 `false`로 두고 기존 Argo의 대상 ref·revision·설정과 복구 지점을 기록한다.
   기존 클러스터는 자동 이전하지 않는다. 전환 전에 기존 소스 브랜치 자동 sync를 운영자가 관리해야 한다.
2. 이 구현을 교육기관 원본에 병합하고 개인 포크 기본 브랜치에 동기화한다.
   이후 보호된 소스 브랜치의 동기화는 필수 검사와 리뷰를 거치는 PR로 수행한다.
3. 저장소 루트에서 Python 3.13과 GitOps requirements를 준비하고 다음을 실행한다.

   ```bash
   python -B infrastructure/gitops/scripts/deployment.py bootstrap
   ```

   이 명령은 **로컬 Git 객체에 빈 초기 커밋만** 만들고 push 명령을 출력한다. checkout·index·현재 브랜치를
   바꾸거나 원격에 쓰지 않는다. 관리자는 출력된 정확한 커밋을 확인한 뒤 최초 `deploy/fork`를 생성한다.
   빈 브랜치는 배포 가능한 release가 아니다. 이미 있는 배포 브랜치를 초기화하거나 force-push하지 않는다.
4. 개인 포크의 두 브랜치에 다음 **활성 Ruleset**을 설정한다. disabled/evaluate 규칙은 인정하지 않는다.

   | 규칙 | 소스 기본 브랜치 | `deploy/fork` |
   | --- | --- | --- |
   | PR, 승인 수 1 이상 | 필수 | 필수 |
   | 새 push 시 이전 승인 해제, 마지막 push에 대한 별도 승인, 대화 해결 | 필수 | 필수 |
   | strict/up-to-date required checks | 필수 | 필수 |
   | required context | `release/gate.py`의 5개 workflow·16개 job 이름 전체 | `govbiz/deployment-candidate` |
   | 삭제·force-push 차단 | 필수 | 필수 |

   source의 `.github/workflows/`, `infrastructure/release/`, `infrastructure/gitops/`에 대한 CODEOWNERS와
   실제 리뷰 가능 담당자를 지정한다. 작성자가 자기 PR을 승인할 수 없으므로 별도 리뷰어가 필요하다.
   배포 snapshot은 `.github/CODEOWNERS`를 포함하지 않는다. 배포 PR의 필수 리뷰는 위 Ruleset과 지정된 운영 담당자가 맡는다.
   관리자·GitHub Actions·기타 앱의 bypass를 별도로 점검하고 직접 쓰기를 허용하지 않는다.
   도구는 [활성 branch rules API](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28#get-rules-for-a-branch)로
   적용 규칙을 검사하지만 **bypass actor 전체와 CODEOWNERS 승인 권한까지 증명하지 않는다**.
5. Actions가 PR을 만들 수 있도록 저장소 정책을 설정한다. 발행기와 별개로 후보 생성 job에는
   `contents: write`, `pull-requests: write`, `actions: write`가 필요하다. 검사기는 contents/actions/PR을 읽고
   `statuses: write`로 정확한 후보 SHA의 결과만 게시한다. 자동 승인·자동 merge 권한으로 해석하지 않는다.
6. GHCR 패키지 준비, 같은 최신 소스 SHA의 필수 CI 및 이미지 발행을 확인한 다음
   `MSA_PROMOTION_ENABLED=true`로 후보 생성을 활성화한다. 기존 `msa-release` 환경 승인과 배포 PR 승인은 별도다.

필수 CI 다섯 개의 PR 경로 필터를 제거했으므로 문서·설정 PR에서도 필요한 상태 검사가 생성된다.
워크플로 이름이나 matrix job을 바꾸면 `gate.py`와 Ruleset의 required context도 함께 갱신해야 한다.
보호 설정 실패를 피하려고 필수 검사를 삭제하거나 bot bypass를 추가하지 않는다.

## 후보 검토와 수동 병합

`Fork image promotion`은 현재 소스 SHA, upstream 병합 상태, CI 실행·재실행, publisher와 네 artifact,
활성 Ruleset, 현재 배포 base를 확인하고 후보 artifact와 PR을 만든다. 준비 실패 시 기존 배포는 유지한다.

`GITHUB_TOKEN`으로 생성한 PR은 PR workflow 실행을 자동으로 유발하지 않는다.
따라서 생성기는 **소스 기본 브랜치의** `Deployment candidate validation`을 명시적으로 dispatch한다.
[GitHub 이벤트 제한](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
때문에 필요한 연결이며 후보의 workflow·스크립트를 실행하지 않는다.
검사기는 PR 번호와 정확한 head SHA·저장소·base를 확인하고 `govbiz/deployment-candidate` 상태를
`pending`에서 `success` 또는 `failure`로 바꾼다. 취소/runner 장애로 pending이면 병합하지 않는다.
후보는 검토된 base 바로 위의 단일 snapshot 커밋이어야 한다.

검토자는 아래를 확인한 뒤 수동 병합한다.

- source SHA의 필수 16개 job, CI run/attempt와 publisher receipt가 후보와 일치하는지
- 이미지뿐 아니라 Chart·values·렌더링 diff와 Secret 참조가 의도한 변경인지
- 현재 배포 base가 같은지, 이전/새 서비스 혼합 실행 중 API·DB 호환성이 유지되는지
- 정확한 후보 head의 required status와 마지막 변경에 대한 리뷰 승인이 유효한지

후보 파일을 수동 수정하거나 오래된 후보를 rebase/merge-update하지 않는다. 소스에서 수정·검증 후 새 후보를 만든다.
검사 시 소스나 배포 base가 바뀌었거나 CI가 재실행되어 증거가 달라지면 거절한다.
**검사 성공 뒤 소스 main이 전진하는 사건과 수동 merge는 서로 다른 ref이므로 원자적으로 잠기지 않는다.**
병합 직전에 소스가 바뀌었으면 후보를 새로 만들고, 같은 후보의 검사 재실행은 다음처럼 명시한다.

```bash
gh workflow run deployment-ci.yml --ref main -f pr_number=<PR번호> -f candidate_sha=<40자리후보SHA>
```

기본 브랜치가 다르면 `--ref`를 그 이름으로 바꾼다. 새 head는 이전 SHA의 성공 상태를 상속하지 않는다.
PR 생성 후 dispatch가 실패하면 확인된 `candidateCreated=true`는 보존하고 `checkDispatched=false`로 기록한다. Actions 실패와 열린 PR을 함께 확인한다.
`msa-promotion-result`의 `candidateCreated=true`는 후보 PR 생성 사실이며 `deploymentUpdated=false`,
`clusterVerified=false`다. PR 생성·검사·merge·Argo Synced/Healthy를 구분한다.

## 클러스터 전환과 복구

첫 승인 PR이 `deploy/fork`에 병합된 뒤 깨끗하고 원격과 일치하는 소스 checkout에서
`fork_cluster.py gitops`를 명시적으로 실행한다. 활성 Ruleset과 승인 브랜치 snapshot을 다시 검사하고
snapshot에 기록된 AppProject·Application을 적용한다. 네 Application은 `deploy/fork`만 읽는다.
새 소스 main의 Chart·values는 다음 배포 PR이 승인될 때까지 이 GitOps 입력을 바꾸지 않는다.
GHCR 기반 `up`도 승인된 렌더링 결과를 사용한다. `up --local-images`의 개발 경로는 유지한다.

기존 `integrations.json`이 있으면 GitOps 전환은 클러스터 변경 전에 멈춘다. 파일을 자동 삭제하거나
실제 연동을 조용히 비활성화하지 않는다. 현재 무료 실행 후보는 유료 API·수집·메일을 허용하지 않으며,
연동 설정을 Git에서 검토하고 별도 실행 정책을 개발한 뒤 이전해야 한다.
`connected_runtime.py`도 `deploy/fork` Application의 `valuesObject`를 수정하기 전에 차단한다.
로컬 프로필 파일이 없어도 실제 Application에 남은 override·다중 source·예상 밖의 소유권은 전환 전에 거절한다.
Argo [parameter override](https://argo-cd.readthedocs.io/en/stable/user-guide/parameters/)가 Git 설정과 다른
실행 입력을 만드는 경로를 막기 위한 제약이다. 클러스터 관리자 수동 변경을 RBAC로 차단한 증거는 별도다.

승인된 과거 release는 main이 전진하거나 Actions artifact가 만료되어도 묶여 있는 receipt·소스 Git blob·렌더링으로
검사할 수 있다. 해당 Git 커밋과 이미지 digest의 보존은 필요하다. Argo 설치 중 배포 ref가 바뀌면 전환을 다시 시도한다.
실제 Argo Helm 버전·렌더링 일치, Synced/Healthy, 네 서비스 준비 및 오류·복구 시나리오는 클러스터에서 별도 검증한다.
이미지 rollback으로 DB schema/data가 복구된다고 간주하지 않는다.

## 로컬 검증과 완료 기준

Python 3.13, Git, Helm 4.3.0 및 `scripts/requirements.txt` 설치 후:

```bash
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_deployment.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_sync_images.py'
python -B -m unittest discover -s infrastructure/release -p 'test_outcome.py'
git diff --check
```

`Infra CI/helm-gitops`가 새 후보 테스트와 실제 Helm 렌더링을 수행한다. 로컬 오프라인 통과는 원격 보호 적용이나
실제 배포 성공이 아니다. 최신 변경 SHA의 필수 CI, 원격 API 및 거절 사례, 승인된 revision만 읽는 Argo 검증까지
확인해야 [G1 완료 기준](../../../docs/gitops-strategy-review-20260929.md#g1--승인된-전체-배포-상태와-원격-통제-구축)을 충족한다.

2026-09-29 로컬 선택 검증: 후보 20개, receipt/workflow 24개, 결과 보고 16개, release/gate 41개,
기존 Argo·초기화·프로필 회귀 3개로 중복 제외 104개가 통과했다. 실제 Helm 4.3.0 오프라인 렌더링도 포함한다.
새 Python 코드의 Ruff·포맷, 기존 수정 코드의 오류 검사, 5개 workflow YAML·40개 Bash 블록의 구문,
저장소 경계·문서 링크와 `git diff --check`를 확인했다. 네이티브 Windows의 기존 POSIX 잠금 경로는
전체 클러스터 도구 검증으로 보고하지 않는다. 해당 전체 테스트는 Ubuntu Infra CI에 맡긴다.
최신 변경 SHA의 CI, 원격 보호 적용과 실제 클러스터 전환은 각각 별도 결과로 확인해야 한다.
