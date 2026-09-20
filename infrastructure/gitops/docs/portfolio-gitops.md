# 통합 저장소의 개인 fork GitOps 전환 상태

이전 GovBiz-Team 저장소와 Mac의 `govbiz-portfolio`에서 검증한 상시 배포를
교육기관 통합 저장소로 **자동 이전한 상태는 아닙니다**. 기존 환경의 결과는
[2026-09-20 기록](portfolio-validation-20260920.md)에 보존합니다.
코드만 통합하며 기존 클러스터·토큰·원본 저장소 설정에는 접근하지 않습니다.

## 이번 통합에서 바뀐 것

- Argo Git 소스: `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`, `main`.
- Chart 경로: `infrastructure/gitops/charts/govbiz-service`. values는 Chart 기준 상대 경로 유지.
- 제출본 portfolio 자동 sync·self-heal·prune는 꺼져 있습니다. 수동 sync도 아직 실행하지 않습니다.
- `environments/portfolio`의 `ghcr.io/govbiz-team/...` digest·receipt는 기존 이미지의 이력입니다.
  교육기관이나 다른 팀원의 비공개 이미지 접근 권한을 가정하지 않습니다.
- `scripts/portfolio_cluster.py`는 기존 개인 계정·Mac 전용 함수와 테스트를 보존하지만 CLI는 잠겼습니다.
  prepare·activate·status 모두 토큰 읽기·Kubernetes 접근 전에 종료합니다.
- 루트 이미지 발행·승격 workflow와 이전 승격 CLI도 잠겼습니다. 변수만으로 재개되지 않습니다.

## 팀원별 fork 경로를 마무리하려면

1. 개인 fork 이름·브랜치를 CI, receipt 검증, Argo source에 일관되게 연결합니다.
2. Actions가 **본인 비공개 GHCR**에만 발행하도록 namespace·권한·패키지 연결을 설정합니다.
3. digest를 **같은 개인 fork**의 `infrastructure/gitops/environments/<개인 환경>`에 기록합니다.
4. PC의 전용 Kubernetes namespace에 자기 패키지 읽기 인증을 Git 밖에서 주입합니다.
5. Argo CD는 자기 fork·자기 클러스터만 동기화하게 하고 이미지 교체·실패·rollback을 검증합니다.
6. Windows Docker Desktop/WSL2의 설치·재시작·중지·토큰 만료·데이터 보존을 실제 확인합니다.

개인별 인증은 필요하지만 동일 workflow·설치 스크립트를 재사용하도록 만드는 작업이 남았습니다.
교육기관 GHCR을 사용하거나 팀원에게 기존 개인 토큰을 공유하지 않습니다.

## 지금 사용할 수 있는 검증

[로컬 MSA smoke](msa-local.md)는 GHCR 없이 로컬 빌드 이미지를 새 kind에 적재합니다.
종료 시 테스트 클러스터를 정리하므로 상시 개발 환경은 아닙니다.
프론트 `dev:k8s`와 loopback port-forward는 재사용할 수 있지만 백엔드 코드 저장 자동 반영은
별도 개발용 동기화/재빌드 경로가 필요하며 이 통합 작업에 포함하지 않았습니다.

공식 참고: [GHCR 인증](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[Kubernetes private image pull](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/).
