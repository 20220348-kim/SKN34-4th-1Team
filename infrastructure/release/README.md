# MSA 이미지 발행

교육기관 원본에 병합된 소스를 **이미 준비된 개인 포크의 GHCR 패키지**에 발행합니다. 기본값은 비공개이며 교육기관 GHCR은 사용하지
않으며, `ilil1` 등 개인 계정명을 코드에서 수정할 필요가 없습니다. CI는 실행 저장소 정보,
로컬 도구는 Git `origin`을 사용합니다. 기존 EC2/SSM 배포나 GovBiz-Team 저장소는 변경하지 않습니다.

[최초 준비 도구와 설정 안내](../../docs/private-ghcr-setup.md)를 제공합니다. 일회용 쓰기 PAT로 빈
비공개 패키지만 만들고, 권한 검증 후에 자동 발행을 켭니다. 준비 전에는 두 발행 변수를 `false`로
유지합니다. Actions 변수와 읽기 토큰만으로 최초 준비가 완성되지는 않습니다.
공개를 선택할 때는 [공개 GHCR 전환 안내](../../docs/public-ghcr-transition.md)를 따릅니다.
`MSA_PACKAGE_VISIBILITY=public`은 공개 패키지 발행을 허용하는 명시적 설정이며,
GitHub의 공개 범위를 자동으로 변경하거나 원본 병합·CI 검증을 우회하지 않습니다.

## 각 포크의 선행 조건

1. 자기 포크의 **Actions** 탭에서 워크플로 실행을 허용합니다.
2. 자기 포크의 **Settings → Secrets and variables → Actions → Variables**에서 다음 두
   repository variable을 각각 `false`로 유지합니다. Secret이나 PAT를 넣는 칸이 아닙니다.
   - `MSA_RELEASE_ENABLED=false`: 비공개 패키지 준비 전 이미지 발행 중지
   - `MSA_PROMOTION_ENABLED=false`: 제거한 배포 PR 자동화 비활성 유지
3. 네 서비스 패키지가 **Private·본인 소유·정확한 자기 포크 연결** 상태로 먼저 존재해야 합니다.
   `bootstrap_packages.py create`로 앱 코드 없는 초기화 패키지를 만들고, GitHub UI에서 포크를
   연결하되 권한 상속은 끈 채 정확한 포크의 Actions에만 Write를 부여합니다. `verify`로 다시 검사합니다.
   준비가 확인되지 않으면 다음 발행 활성화 단계로 넘어가지 않습니다.
4. 준비된 패키지에 해당 포크 Actions가 새 버전을 쓸 권한까지 확인한 후, 사용자가 명시적으로
   발행을 허용할 때에만 `MSA_RELEASE_ENABLED=true`로 변경합니다. `MSA_PROMOTION_ENABLED=false`는 유지합니다.
   `Settings → Environments → msa-release`에 별도 승인자를 지정했다면 릴리스마다 그 승인이
   필요합니다. 워크플로가 요청하는 `packages: write`를 조직·저장소 정책이 거부하면 관리자에게 문의합니다.
5. PC에서 준비된 이미지를 받을 때는 본인 계정의 **classic PAT, `read:packages`만** 준비합니다.
   [숨김 입력·클러스터 초기화](../../docs/local-fork-development.md)를 따르며 토큰을 Git·채팅에 넣지 않습니다.

발행기는 기존 패키지의 소유자·연결 저장소·기대 공개 범위를 빌드 전, 새 태그 업로드 직전·직후에 확인합니다.
패키지가 없거나 접근할 수 없는 경우에도 자동 생성하지 않고 업로드 전에 중단합니다.
기대 공개 범위와 다르거나 다른 저장소에 연결된 패키지는 거부하며, 공개 범위를 자동 변경하지 않습니다.

공개 포크에서 `GITHUB_TOKEN`으로 새 패키지를 생성하면 저장소의 공개 범위를 상속할 수 있으므로
"새 패키지는 항상 비공개"라고 가정하지 않습니다.
[GitHub 공식 설명](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions#default-permissions-and-access-settings-for-packages-modified-through-workflows)

PC의 읽기 인증과 CI의 임시 `GITHUB_TOKEN`은 별개입니다. **기존 비공개 패키지의 반복 발행**에는
별도 발행용 PAT나 다른 저장소 쓰기 토큰을 등록하지 않습니다. 최초 빈 패키지를 만드는 일회용
`write:packages` PAT는 초기 준비 후 폐기합니다. `read:packages` 토큰으로는 패키지를 생성할 수 없습니다.

## 발행되는 시점

병합 보호는 [리뷰 0명·필수 CI 규칙](../../docs/merge-protection.md)을 따른다.
발행 가드와 병합 규칙은 `ci_policy.py`의 기존 16개 작업·종합 판정 5개를 공유한다.
원격 ruleset 적용과 우회 권한 확인은 코드 변경이나 발행 성공으로 대신하지 않는다.

**작업 브랜치에 push하는 것만으로는 발행하지 않습니다.**
아래 경로는 비공개 패키지 준비·검증과 `MSA_RELEASE_ENABLED=true` 설정 뒤에만 실행됩니다.

1. 교육기관 원본 `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`에 PR을 올리고 병합합니다.
2. 자기 포크의 원격 기본 브랜치에 원본의 최신 병합본을 동기화합니다.
3. 같은 소스의 앱·Catalog·Ops·Infra·LLMOps CI와 각 필수 job이 모두 통과하면 이미지 발행이 진행됩니다.
4. 발행 결과와 네 이미지 receipt를 확인합니다. 별도 배포 PR이나 배포 브랜치는 만들지 않습니다.
   Argo 자동 배포로 이어지는 대체 경로는 이번 제거 작업에 포함하지 않았습니다.
   [배포 PR 제거 기록](../gitops/docs/deployment-candidates.md)을 확인하세요.

`git pull`은 내 PC만 바꿉니다. GitHub의 **Sync fork**로 원격 포크를 먼저 동기화하거나,
로컬에서 원본 변경을 반영한 뒤 자기 포크에도 push해야 CI가 시작됩니다. 충돌이 있으면 기존 작업을
보존하고 해결하며, 자동 reset·force-push하지 않습니다. 본인이 작성한 미병합 코드나 원본보다
오래된 소스는 배포 후보로 삼지 않습니다. 자동 생성한 개인 digest 파일만 원본과 달라도 됩니다.

포크를 만든 것만으로 기존 커밋의 push CI가 생기지는 않습니다. 이 기능을 포함한 코드가 먼저
원본에 병합되고 포크에 동기화돼야 하며, 필요한 다섯 CI 실행이 없는 경우 발행을 건너뜁니다.
수동 `MSA image candidates` 실행도 이 검증을 우회하지 않습니다.
최신 실행·재실행의 필수 job이 누락되거나 건너뛰어진 경우 workflow가 성공이어도 차단합니다.
발행·승격 직전에도 같은 조건을 다시 검사하며, LLMOps CI는 문서 변경·빈 커밋을 포함한 모든 push에서 실행됩니다.
새 포크가 이미 원본 최신 상태라 동기화할 변경도 없다면, [최초 CI 실행 안내](../../docs/msa-image-release.md)에
따라 깨끗한 기본 브랜치에서 내용 변경 없는 초기 실행 커밋을 한 번 만들 수 있습니다.
이 경우에도 원본과 소스가 같아야 하며, 미병합 코드를 발행하는 예외는 아닙니다.

로컬 개발 감시 도구는 이 발행 경로와 별개로 **저장한 서비스만 PC에서 재빌드**합니다.
세부 검증·권한·실패 시 동작은 [이미지 릴리스 안내](../../docs/msa-image-release.md)를 참고하세요.

## 발행·승격 결과 확인

`MSA image candidates`는 선행 job의 성공·실패·건너뛰기에도
읽기 전용 `outcome` job을 실행한다. Actions Summary와 JSON artifact의
`schema=msa-release-outcome-v1` 기록을 확인한다. workflow의 초록색 표시만으로 발행·배포를 판단하지 않는다.

| artifact | 확인할 사실 |
|---|---|
| `msa-publication-result` | gate·발행 matrix 결과, `sourceSha`, `triggerSha`, 차단 사유, `imagesVerified` |
| `msa-publication-<service>` | 서비스별 새 업로드·재사용·receipt 생성 여부. 발행 도구가 실행된 경우 생성 |
| 과거 `msa-promotion-result` | 제거한 배포 PR 자동화의 이전 기록. 새로 생성하지 않음 |

- `imagesVerified=true`는 gate와 네 서비스 발행 job이 모두 성공했다는 뜻이다. 새 업로드 횟수는
  이 집계에서 추정하지 않고 서비스별 기록을 본다.
- 서비스별 `state=published`는 새 업로드와 검증 receipt 생성 완료, `state=reused`는 이미 검증된
  이미지 재사용이다. `upload=confirmed`여도 후속 검증이 실패하면 `receiptWritten=false`이며 승격 근거가 없다.
  `upload=attempted`는 push 응답을 확정하지 못한 상태다. 보고서 누락도 업로드 0회 증거가 아니다.
- `sourceSha`는 gate/후보 선택에서 확인한 소스다. 그 단계에 도달하지 못하면 null이며,
  이벤트의 `triggerSha`로 대신 승인하지 않는다. run ID와 attempt를 함께 기록한다.
- `reason`은 `disabled`, `event_not_eligible`, `source_not_current`, `upstream_not_merged`,
  `ci_run_missing:<workflow>`, `ci_jobs_not_successful_or_incomplete:<workflow>` 등으로 차단 위치를 구분한다.
- 과거 `candidateCreated`·`pushed` 보고서는 당시 계약으로만 해석한다. 해당 자동화는 제거했다.
  과거 후보 PR이나 push 기록은 현재 클러스터의 상태를 증명하지 않는다.
- 보고서는 배포 승인 자료가 아니다. 네 `msa-image-<service>` receipt의 출처·checksum·소스 검증은
  그대로 필수다. 승격기는 정해진 보고서 이름만 receipt 목록에서 제외하며, 미지의 artifact는 거절한다.
- `clusterVerified=false`는 이 도구가 실제 클러스터를 검증하지 않았다는 뜻이다. Argo CD 동기화와
  서비스 준비 완료는 별도 증거로 확인한다. 원격 보호 규칙과 실제 클러스터 전환은 별도 활성화 절차다.

결과 job의 `always()` 동작은 [GitHub job 의존성 규칙](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)을 따른다.
runner 시작 전 실패나 강제 종료 등으로 보고서가 없으면 검증 대기로 남기며 성공으로 추정하지 않는다.
