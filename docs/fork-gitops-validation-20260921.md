# 개인 포크 비공개 GHCR → Mac GitOps 검증

2026-09-21, Intel Mac / Docker `linux/amd64`에서 `ilil1/SKN34-4th-1Team` 포크로 확인한 기록입니다.
다른 팀원의 권한 설정이나 실제 Windows/WSL2 실행까지 완료했다는 의미는 아닙니다.

아래 Mac 검증은 당시 구성의 이력입니다. 현재는 필수 CI가 다섯 개이고 배포 PR·digest 자동 커밋은
제거됐으므로, 이 문서의 과거 Argo 성공을 현재 Windows 환경의 배포 완료 근거로 사용하지 않습니다.
현재 연결 범위는 [이미지 발행과 배포의 경계](../infrastructure/gitops/docs/image-promotion.md)를 따릅니다.

## 실제 확인한 경로

1. 앱 코드 없는 빈 패키지 네 개를 일회용 `write:packages` PAT로 처음부터 Private로 생성했습니다.
2. 각 패키지를 정확한 개인 포크에 연결하고, 공개 저장소 권한 상속은 끈 채 해당 포크 Actions에만
   Write를 부여했습니다. 앱 이미지 발행 후에도 네 패키지의 Private·소유자·포크 연결을 재검사했습니다.
3. 원본에 병합·동기화된 `82c1d24a35ffb6ed7f85d5ba86e90e2254bfa712`의 네 CI 통과를 확인한 후
   두 발행 변수를 활성화했습니다. 첫 이미지 실행은 수동으로 시작했으며 동일한 gate 검증을 통과했습니다.
   - [네 이미지 발행 성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/35517317583)
   - [후속 digest 승격 자동 실행 성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/35517573133)
   - [자동 digest 커밋 b98ebc5](https://github.com/ilil1/SKN34-4th-1Team/commit/b98ebc51252bd02ae1df55f9e10abe3c2efee6df)
4. 새 전용 kind 클러스터 `govbiz-f218b0ac1c`에서 본인 소유 `read:packages` 전용 인증으로
   네 서비스의 정확한 digest를 실제 pull했습니다. Kubernetes의 `Successfully pulled image` 이벤트와
   Deployment·Pod의 실행 이미지, Ready 상태를 함께 검사했습니다.
5. 네 Argo Application이 자기 포크 `main`의 `b98ebc5`를 읽고 모두 **Synced / Healthy**가 됐습니다.
   자동 sync와 self-heal은 켜고 prune은 끈 상태입니다. AppProject는 해당 포크와 `govbiz-msa`의
   Deployment·Service만 관리하도록 제한했습니다. Secret·DB·PVC는 서비스 자동 sync 대상이 아닙니다.
6. Ops의 `progressDeadlineSeconds`를 600 → 601로만 바꿔 Argo가 자동으로 600으로 복구하는 것을
   확인했습니다. 네 서비스의 Pod UID·이미지·Pod template은 바뀌지 않았습니다.

초기 AI 이미지 약 974MB를 준비하는 데 대기 포함 12분가량이 걸려 첫 `up`의 progress deadline을
초과했습니다. 실패를 성공으로 처리하거나 클러스터를 재생성하지 않았습니다. 실제 pull·Ready 확인 후
같은 `up`을 재실행해 기존 Secret·DB·이미지 캐시를 보존하고 초기화를 완료했습니다.

## 인증 및 기존 환경

- 일회용 쓰기 토큰은 GitHub에서 폐기했으며 HTTP 401로 재확인했습니다. 해당 로컬 파일도 제거했습니다.
- 읽기 토큰의 임시 복사본도 제거했습니다. 새 클러스터의 `ghcr-pull` Secret은 유지합니다.
- Git·CI 설정·검증 기록에 토큰 원문을 저장하지 않았습니다. 반복 발행은 Actions `GITHUB_TOKEN`입니다.
- 기존 `govbiz-portfolio`는 사용자 승인에 따라 중지하고 컨테이너·데이터·볼륨은 보존했습니다.
- 새 클러스터는 상시 유지하며 Docker가 실행 중일 때 동작합니다. 유료 AI·메일·외부 공고 수집은 비활성입니다.

상세 로컬 증거는 Git ignore 대상인 `infrastructure/gitops/.local/fork/registry-gitops-proof.json`에
남깁니다. 토큰이나 Secret 값은 포함하지 않습니다.

## 검증 한계

- 새 초기 준비 도구를 포함한 release 단위 테스트 **51개**가 통과했습니다.
- 실제 개인 GHCR 발행·승격·다운로드·Git revision 동기화·자동 복구를 확인했습니다. 이후의 새로운
  교육기관 PR 병합 이벤트를 추가로 만들어 재검증한 것은 아닙니다. 자동 트리거는 기존 workflow 설정입니다.
- Windows/WSL2 실기기, ARM, 클라우드 상시 운영·고가용성·부하·유료 AI 품질은 이 기록의 검증 대상이 아닙니다.
- 다른 팀원도 [자기 비공개 패키지 최초 준비](private-ghcr-setup.md)와 자기 PC의 읽기 인증이 필요합니다.

당시 흐름은 **원본 PR 병합 → 자기 포크 원격 기본 브랜치 동기화 → 네 CI 통과 → 비공개 이미지 발행 →
digest 자동 커밋 → 실행 중인 Argo CD 배포**입니다. 로컬 `git pull`만으로 원격 CI를 시작하지 않으며,
이미 GitOps 모드인 Argo의 원격 Git 감지에는 PC 작업 트리의 `git pull`이 필요하지 않습니다.

## GHCR 발행 차단 원인 재확인 — 2026-10-05

기본 브랜치 `117fb9dcc1c6fe7a69429d44c4c2a2c3cd1eaac5`의
[사전 점검 실행 37327000880](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/37327000880)에서
`msa-package-preflight` 보고서를 내려받아 네 서비스의 실제 GitHub 패키지 메타데이터를 확인했습니다.

| 서비스 | 저장소 연결 | 소유자 | 실제 공개 범위 | 기대 공개 범위 | 결과 |
| --- | --- | --- | --- | --- | --- |
| Core | 일치 | 일치 | public | private | 정책 불일치 |
| Catalog | 일치 | 일치 | public | private | 정책 불일치 |
| AI | 일치 | 일치 | public | private | 정책 불일치 |
| Ops | 일치 | 일치 | public | private | 정책 불일치 |

조회 당시 포크의 `MSA_PACKAGE_VISIBILITY` 저장소 변수는 없고 `msa-release` 환경 변수에도
재정의가 없어 기본값 `private`이 적용됐습니다. `MSA_RELEASE_ENABLED=true`,
`MSA_PROMOTION_ENABLED=false`였습니다. 패키지 사전 점검 실패로 발행 job은 건너뛰었고,
보고서의 `upload: not_attempted`, `receiptWritten: false`, `clusterVerified: false`를 확인했습니다.

이 실행의 차단 원인은 공개 범위 정책 불일치입니다. 로컬 GitHub CLI의 `read:packages` 부족과
Actions의 실제 검사 결과를 혼동하지 않습니다. 공개 패키지를 언제 누가 변경했는지는 이 조회로
확인하지 않았으며, Actions의 실제 업로드 권한이나 새 이미지 발행 성공도 아직 입증하지 않았습니다.
후속 조치는 [이미 공개된 패키지의 정책 정합성 확인](public-ghcr-transition.md)을 따릅니다.

### 공개 발행 정책 적용 및 재검증

사용자가 공개 이미지 발행을 선택한 뒤, 같은 포크의 저장소 변수
`MSA_PACKAGE_VISIBILITY=public`을 적용하고 GitHub API로 저장된 값을 재확인했습니다.
기존 `MSA_RELEASE_ENABLED=true`, `MSA_PROMOTION_ENABLED=false`는 유지했습니다.
패키지 공개 범위 자체나 접근 권한·토큰·클러스터는 변경하지 않았습니다.

같은 기본 브랜치 SHA에서 [재검증 실행 37327996428](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/37327996428)을
수동 실행한 결과, 네 패키지의 소유자·저장소 연결·공개 범위가 모두 일치하고
`packagePolicyVerified: true`, `packagePreflightResult: success`를 확인했습니다.
따라서 이 실행에서는 공개 범위 불일치 차단이 해소됐습니다.

이때 전체 결과는 `state: blocked`, `publicationResult: skipped`,
`reason: ci_run_not_successful_or_untrusted:ci.yml`이었습니다. 같은 SHA의 필수 CI가 진행 중이어서
기존 CI gate가 실제 발행을 막았으며 `imagesVerified: false`, `clusterVerified: false`를 유지했습니다.
사전 점검 성공을 네 이미지의 실제 업로드·receipt 발급·배포 성공으로 기록하지 않습니다.
