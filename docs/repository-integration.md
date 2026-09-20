# 교육기관 제출용 단일 저장소 통합

## 기준과 보존 범위

`SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`의 `main`에서 앱과 GitOps 설정을 함께 관리한다.
두 소스 저장소의 **추적된 파일 스냅샷**을 가져온 것이며, 두 Git 이력을 merge한 것은 아니다.
사용자 요청에 따라 대상의 기존 초기 커밋을 새로운 루트 커밋 하나로 교체한다.

| 출처 | 기준 커밋 | 통합 후 위치 |
| --- | --- | --- |
| `GovBiz-Team/GovBiz` | `d65218082b4d57747d6e862a100a95b7c8dd27d7` | 저장소 루트 |
| `GovBiz-Team/GovBiz-infra` | `e6b002571a8410c25a48aadd97e5df802f91bec0` | `infrastructure/gitops/` |
| 대상의 이전 Django 골격 | `611232de21f69689c4024f3935b8d693b03b7777` | 이미 발전시켜 통합한 `backend/ops-service/` 사용 |

원본 `GovBiz-Team/GovBiz`, `GovBiz-Team/GovBiz-infra`, `GovBiz-Team/GovBiz-ops`는 삭제하거나
이력을 재작성하지 않는다. 기존 `.env`, 토큰, kubeconfig, 데이터 볼륨, node_modules와 빌드 산출물을
복사하지 않는다. 기존 Mac Kubernetes와 AWS/Vercel 설정도 변경하지 않는다.

## 무엇이 같은 저장소에 들어오나

- 웹·모바일·공통 계약: `frontend/`
- 독립 서비스: `backend/{core-service,catalog-service,ai-service,ops-service}/`
- 통합 개발 Compose: 루트 `compose.yaml`
- Kubernetes·Helm·Argo CD·환경별 values·검증 도구: `infrastructure/gitops/`
- 앱 CI와 Infra CI: 루트 `.github/workflows/`

GitOps 내부 상대 경로는 `infrastructure/gitops/`를 기준으로 유지한다. 예를 들어 저장소 루트에서
`python3 -B infrastructure/gitops/scripts/check_repository.py`를 실행할 수 있다.
GitHub Actions는 루트 `.github/workflows/`만 읽으므로 예전 Infra CI도 그곳으로 옮겼다.
Argo CD의 repository URL·`main` revision·chart 경로는 통합 저장소에 맞춘다.

소스를 합쳐도 네 서비스의 프로세스, Dockerfile, Helm release와 DB 소유권은 합치지 않는다.
이 작업은 새 MSA 업무 분리나 운영 배포 완료가 아니라 **소스·배포 설정 관리 단위의 통합**이다.

## 교육기관 원본과 개인 포크

개발 결과는 이 교육기관 저장소에 PR로 제출한다. 팀원은 자신의 계정으로 포크하고 자기 PC에 clone한다.
새 포크는 이 저장소 하나만 받으면 앱과 GitOps 파일을 모두 얻는다.

기존 초기 Django 저장소를 이미 clone했다면 이력 교체 후 단순 `git pull`로 이어 붙이지 않는다.
미커밋 코드와 `.env`를 별도로 보관한 뒤 **새 디렉터리에 다시 clone**한다. 기존 폴더나 볼륨을 삭제할 필요는 없다.
이미 포크한 사람도 기존 작업을 보존한 다음 원본의 새 `main`과 포크 이력을 맞춰야 하며,
로컬 변경을 확인하지 않고 reset·force-push하지 않는다.

## GHCR와 로컬 개발은 어디까지 준비됐나

교육기관의 GHCR은 사용하지 않는다. 이 통합본의 이미지 발행·digest promotion 워크플로는
이전 저장소 전용 인증·증빙을 그대로 재사용하지 않도록 잠갔다. **기존 GovBiz-Team 저장소의 자동 발행을 중지한 것이 아니다.**

개인 포크의 GHCR을 사용하는 계획은 가능하지만, 다음 연결까지 자동으로 완료된 것은 아니다.

1. 각 포크의 Actions 활성화·발행 권한과 개인 GHCR 이미지 경로 설정.
2. CI 출처·브랜치·동일 커밋 검증 및 digest 갱신을 그 포크 기준으로 연결.
3. 각 PC의 Kubernetes에 자기 계정의 `read:packages` 인증을 안전하게 등록.
4. Argo CD가 자기 포크의 chart·values를 읽도록 설정하고 실제 동기화 검증.

토큰과 Kubernetes Secret은 Git에 넣지 않는다. 원본의 개인용 이미지 digest나 Mac 설정을
포크 팀원의 인증·배포 완료 증거로 취급하지 않는다. 관련 제한은
[이미지 발행 안내](msa-image-release.md)와 [GitOps 안내](../infrastructure/gitops/README.md)를 따른다.

**이미지를 내려받아 실행하는 것만으로 PC에서 수정한 코드가 컨테이너에 자동 반영되지는 않는다.**
로컬 코드 개발의 기본 진입점은 [통합 Compose 안내](ops-monorepo-migration.md)다.
Kubernetes에서 팀원별 소스 동기화·hot reload까지 제공하는 흐름과 Windows/WSL2에서의
종단 간 실행은 후속 작업이다. 현재 Mac 검증 기록을 Windows 검증 완료로 표시하지 않는다.

## 확인 범위

이동한 인프라의 단위 테스트, 저장소 경계·문서 링크, Helm/Kustomize·Argo 설정과
통합 CI 경로를 검증한다. 서비스 업무 소스와 DB migration은 이 통합을 위해 수정하지 않는다.
실제 private GHCR 발행, 팀원 인증 등록, 클러스터 생성·배포, 유료 AI 호출은 이 작업에 포함하지 않는다.
과거 아키텍처 이미지와 날짜가 붙은 검증 문서는 당시 두 저장소 기준의 기록으로 보존한다.

### 통합본 로컬 확인 — 2026-09-20

- 원본 앱 추적 파일 2,312개 누락 없음. 서비스 업무 소스·DB migration·의존성 잠금 파일은 원본과 동일.
- 원본 인프라 파일도 모두 포함. 두 workflow만 루트 `.github/workflows/`로 이동.
- GitOps 단위 테스트 84개 통과, 경계·문서 링크·Kustomize·Helm·Argo 정책 검사 통과.
- 서비스별 Helm strict lint 4개와 로컬 데이터 Chart strict lint 통과.
- 릴리스 안전장치 테스트 19개, 기존 CodeBuild 안전장치 테스트 23개 통과.
- 기존 인프라 스크립트 테스트 93개 중 77개 통과. 16개는 별도 활성화가 필요한 실제 MySQL 시드 테스트여서 미실행.
- 통합 Compose 정적 검사, Actions `actionlint`, 변경 문서 링크, 전체 스냅샷의 공백 검사 통과.

서비스 업무 테스트·컨테이너 clean build는 이 경로 통합의 로컬 검사에서 다시 실행하지 않았으며
원격 앱 CI가 별도로 수행한다. 새 저장소의 실제 GitOps 배포·Windows 실행 성공으로 해석하지 않는다.
