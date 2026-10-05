# 별도 배포 브랜치·PR 제거

2026-09-29 사용자 요청으로 `deploy/fork`와 별도 배포 후보 PR 절차를 제거했다.
개발 변경은 기존 `skn-* → main` PR 흐름을 사용한다. 리뷰 승인 없이 병합하는 사용자 결정을 유지한다.
필수 CI 워크플로와 이미지 발행 검증은 유지하지만, 원격의 CI 병합 차단 설정과는 구분한다.

## 적용한 변경

- 개인 포크 `ilil1/SKN34-4th-1Team`의 빈 `deploy/fork` 브랜치와 전용 Ruleset을 삭제했다.
- `Fork image promotion`과 `Deployment candidate validation` 워크플로를 원격에서 비활성화하고 소스에서 제거했다.
- Actions의 PR 생성·승인 허용을 끄고 기본 토큰 권한은 `read`로 유지했다.
- `deployment.py`의 PR 생성·검사 dispatch·초기 브랜치 생성 CLI를 제거했다. 예전 명령은 원격 변경 없이 오류로 종료한다.
- 필수 CI 워크플로와 이미지 발행 검증은 유지했다. 원격 규칙의 현재 적용 범위는 아래를 따른다.

2026-10-05 원격 API 재확인 결과 `main`의 활성 규칙은 삭제·강제 푸시 방지뿐이며,
필수 상태 검사와 PR 경유 강제는 설정돼 있지 않았다. 별도의 기존 branch protection 상태 검사 조회도
`404 Branch not protected`였다. 따라서 CI 통과 전 병합이 차단된 상태로 보고하지 않는다.
이 문서 수정은 원격 규칙을 적용하거나 변경한 작업이 아니다.

`MSA_PROMOTION_ENABLED=false`를 유지한다. 이 변수를 켜거나 별도 배포 브랜치를 다시 만드는 절차는 없다.
소스 변경의 커밋·푸시·병합은 아직 별도이며, 원격 비활성화는 즉시 적용했다.

## 남아 있는 범위

이미지 발행 성공을 자동 배포 완료로 취급하지 않는다. 이미지 발행 후 Argo까지 자동으로 연결하는 대체 경로는
이번 제거 작업에서 추가하지 않았다. GitOps가 `main`을 무조건 추적하도록 바꾸지도 않았다.
과거 snapshot을 읽고 검증하는 코드와 오프라인 Helm·정책 테스트는 보존한다.

후속 개발에서 GHCR 기반 `fork_cluster.py up`은 현재 소스의 CI·발행·receipt를 직접 검증하도록 복구했다.
[GHCR 초기화 방법](image-promotion.md)을 따른다. 별도 브랜치·PR·추가 승인 없이 실행하며 로컬 작업 파일은 보존한다.
기존 배포 snapshot을 요구하는 새 `gitops` 전환의 대체 경로는 아직 없다.
[소스 이미지 빌드와 `up --local-images`](../../../docs/windows-kubernetes-setup.md)도 유지한다.
기존 클러스터·Argo Application·데이터·볼륨은 변경하지 않았다.
