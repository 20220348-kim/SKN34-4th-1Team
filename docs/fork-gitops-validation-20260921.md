# 개인 포크 비공개 GHCR → Mac GitOps 검증

2026-09-21, Intel Mac / Docker `linux/amd64`에서 `ilil1/SKN34-4th-1Team` 포크로 확인한 기록입니다.
다른 팀원의 권한 설정이나 실제 Windows/WSL2 실행까지 완료했다는 의미는 아닙니다.

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

이후 흐름은 **원본 PR 병합 → 자기 포크 원격 기본 브랜치 동기화 → 네 CI 통과 → 비공개 이미지 발행 →
digest 자동 커밋 → 실행 중인 Argo CD 배포**입니다. 로컬 `git pull`만으로 원격 CI를 시작하지 않으며,
이미 GitOps 모드인 Argo의 원격 Git 감지에는 PC 작업 트리의 `git pull`이 필요하지 않습니다.
