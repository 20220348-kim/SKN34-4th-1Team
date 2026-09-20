# MSA 이미지 발행과 GitOps 연결 경계

## 통합 저장소의 현재 상태

애플리케이션과 배포 설정은 `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`의 `main`에서 함께 관리합니다.
이전에 별도였던 GitOps 파일은 `infrastructure/gitops/`에 있고, 모든 GitHub Actions는 루트
`.github/workflows/`에서 실행합니다.

| 작업 | 이 통합 저장소의 동작 |
| --- | --- |
| Web·Mobile·Core·AI·Catalog·Ops 테스트 | push 및 해당 PR에서 실행 |
| Helm·Kustomize·Argo 설정과 안전장치 테스트 | 루트 `infra-ci.yml`에서 실행 |
| GHCR 이미지 발행 | **이관 잠금으로 실행하지 않음** |
| 이미지 digest 자동 커밋 | **이관 잠금으로 실행하지 않음** |
| 실제 클러스터 연결·배포 | 저장소 통합 작업에서는 실행하지 않음 |

교육기관의 GHCR은 사용하지 않습니다. `msa-images.yml`과 `msa-promotion.yml`은 기존 구현을
보존하되 자동 트리거를 제거했고, job에 `if: false` 기반 잠금을 두었습니다. 수동 실행이나
`MSA_RELEASE_ENABLED`·`MSA_PROMOTION_ENABLED` 변수 설정만으로도 발행·쓰기는 시작되지 않습니다.
`infrastructure/release/test_release.py`는 이 잠금과 GitOps CI의 위치를 검사합니다.

**이 상태는 새로 통합한 교육기관 저장소에만 해당합니다.** 원본 `GovBiz-Team/GovBiz`와
`GovBiz-Team/GovBiz-infra`의 Actions 설정·패키지 공개 범위·실행 중인 Mac Kubernetes는 변경하지 않았습니다.

## 개인 fork의 비공개 GHCR을 연결하기 전에

보존된 발행 도구는 아직 `GovBiz-Team/GovBiz`·`develop`·`ghcr.io/govbiz-team/`을 엄격하게 검증합니다.
이전 receipt도 그 저장소의 소스 SHA와 CI 이력에 연결되어 있습니다. 새 fork에 파일이 복사되었다고
개인 계정의 이미지 발행과 pull 인증이 자동 설정되는 것은 아닙니다.

다음 항목을 개인 fork 기준으로 함께 변경·검증한 뒤에만 이관 잠금을 해제해야 합니다.

1. 발행 gate의 저장소·대상 브랜치·동일 SHA의 필수 CI 조건과 GHCR 패키지 소유자를 일치시킵니다.
2. 동일 저장소 안의 `infrastructure/gitops/environments/portfolio/`로 digest를 반영하도록
   receipt 검증과 Git 커밋 범위를 연결합니다. 앱 코드 변경과 digest-only 변경의 재실행도 확인합니다.
3. 개인 GHCR 패키지를 Private으로 유지하고, 로컬 Kubernetes에 읽기 전용 pull 인증을 설정합니다.
4. 해당 fork의 URL·브랜치·chart 경로를 바라보는 Argo CD를 별도 로컬 클러스터에서 검증합니다.

이번 통합은 Windows 로컬 Kubernetes, 개발 코드 hot reload, 개인 fork별 GHCR 생성까지 완료했다는 뜻이 아닙니다.
특히 이미지를 내려받아 실행하는 것만으로 PC에서 수정한 소스가 실행 중인 컨테이너에 반영되지는 않습니다.

## 보존된 발행 구현

이전 검증 흐름은 `develop push → 같은 SHA의 세 CI 성공 → 서비스별 Git archive → 비공개 GHCR → digest receipt`입니다.
이후 별도 infra 저장소가 검증된 receipt를 확인해 values를 커밋하고 Argo CD가 반영했습니다.
이전 환경에 관한 상세 기록은 [GitOps 안내](../infrastructure/gitops/docs/portfolio-gitops.md)를 참고합니다.

| 서비스 | 이전 이미지 저장소 — 새 교육기관 이미지가 아님 |
| --- | --- |
| Core | `ghcr.io/govbiz-team/govbiz-core-service` |
| Catalog | `ghcr.io/govbiz-team/govbiz-catalog-service` |
| AI | `ghcr.io/govbiz-team/govbiz-ai-service` |
| Ops | `ghcr.io/govbiz-team/govbiz-ops-service` |

2026-09-20의 [최초 발행 run](https://github.com/GovBiz-Team/GovBiz/actions/runs/35457860821)과
[비공개 발행 run](https://github.com/GovBiz-Team/GovBiz/actions/runs/35495417542)은 **이전 저장소의 검증 기록**입니다.
통합 저장소의 발행 성공 증거로 사용하지 않습니다. 소스 코드의 공개 범위와 이미지 패키지의 공개 범위는 별개입니다.

보존한 안전장치는 다음과 같습니다.

- PR·다른 저장소·다른 브랜치·실패하거나 누락된 CI는 후보에서 제외합니다. 같은 SHA의 최신 실행을 검사합니다.
- 서비스 tree·발행 도구 tree·플랫폼으로 입력 키를 만들고 기존 이미지의 source·입력 키 label·플랫폼을 확인합니다.
- 추적된 소스만 `git archive`로 빌드해 미추적 `.env`·캐시를 제외합니다. 이미 추적된 비밀값까지 정화하지는 않습니다.
- 인증 토큰은 stdin과 임시 Docker 설정만 사용합니다. 사용자의 기존 Docker 로그인을 덮어쓰지 않습니다.
- 서비스별 일부 실패 시 이미지를 자동 삭제하거나 배포하지 않습니다. 인증·네트워크 오류를 이미지 없음으로 숨기지 않습니다.
- 배포 버전은 mutable tag가 아닌 `repository@sha256:...` digest로 고정합니다.
- receipt는 서명된 provenance가 아닙니다. 정확한 저장소·성공한 전체 workflow run·소스 SHA인지 확인합니다.

이미지에는 실행 코드와 의존성이 포함되지만 운영 비밀값은 런타임 Secret으로만 주입합니다.
GitHub Actions의 단기 `GITHUB_TOKEN`을 상시 클러스터의 pull 인증으로 복사하지 않습니다.
GHCR 권한이 없는 조직의 제한을 우회하기 위해 광범위 PAT를 추가하지 않습니다.

## 무료 오프라인 검증

저장소 루트에서 실행합니다.

```bash
python3 -B -m unittest discover -s infrastructure/release -p 'test_*.py'
python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_*.py'
```

CI 경계·기존 이미지 검증·오류 거절·Git archive의 미추적 파일 제외·실패 후 정리 등을 테스트합니다.
오프라인 테스트는 실제 GHCR 업로드·인증된 pull·Kubernetes 배포 성공을 대신하지 않습니다.

공식 참고: [workflow_run 보안과 트리거](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[GHCR 인증·공개 범위·digest pull](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
