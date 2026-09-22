# 프로젝트 버그 검토 및 수정 — 2026-09-22

검토 대상은 `skn34-8`의 `0c9e6e8`을 기준으로 한 Core·Catalog·AI·Ops·Web·Mobile·Shared와 실행·배포 도구다.
아래 수정은 로컬 작업 트리에 반영했으며 아직 커밋·푸시·클러스터 배포하지 않았다.
기존 데이터·볼륨을 변경하거나 유료 API를 호출하지 않았다. 이 기록은 검토한 범위와 확인한 결과이며 무결함 보증이 아니다.

## 확인한 문제와 수정

| 영역 | 발생 조건과 영향 | 수정 |
| --- | --- | --- |
| 신규 비밀번호 | 한글 25자 등 72바이트 초과 입력이 72문자 검사를 통과해 BCrypt 신규 해시 생성에서 서버 오류 발생 | Core 가입·변경·재설정·개발 시드와 Shared/Web/Mobile 입력 검증에 UTF-8 72바이트 상한 적용. 로그인·탈퇴의 기존 해시 검증 호환성 유지 |
| 비밀번호 재설정 | 같은 일회용 토큰을 동시에 조회한 두 요청이 모두 비밀번호 변경 진행 가능 | 기존 Service transaction의 토큰 조회에 `FOR UPDATE` 추가. 실제 MySQL 동시성 회귀 테스트를 추가했으나 로컬에서는 컴파일만 확인 |
| 관심 공고 저장 | 공고 A 저장 중 B로 이동하거나 계정이 바뀌면 이전 응답이 새 화면 상태를 덮어씀. 연속 클릭 중복 요청 가능 | 요청 취소, 오래된 응답 무시, 계정 변경 시 상태 재조회, 동기적인 중복 실행 방지 |
| 가입 이메일 인증 | 발송·인증 응답 대기 중 이메일을 바꾸면 이전 주소의 응답으로 새 주소가 인증된 것처럼 표시됨 | 주소 변경·화면 종료 시 요청 취소와 상태 초기화, 발송·확인의 동시 실행 방지 |
| AI 공고별 근거 검색 | 전체 상위 청크가 한 공고에 몰리면 다른 공고의 근거가 모두 누락됨 | 허용된 청크 내에서 Qdrant 문서별 그룹 검색. 질문 임베딩은 한 번 유지 |
| 도우미 공고 ID | 일반 공고에서 허용되는 긴 ID·한글·콜론 등을 AI/Core/Shared의 더 짧은 ASCII 검증이 거부하거나 도구 응답이 잘라냄 | 기존 공통 식별자 계약인 제공처 64자·원본 ID 255 Unicode code point 보존. Python/Core URL 인코딩과 Shared 검증 일치 |
| 일회성 수집 계획 | 색인하지 않는 계획 모드도 AI 설정을 요구하고, 한 제공처만 선택해도 나머지 제공처 API 키까지 요구함 | AI 비용·모델 정책 검사는 `--apply`에 적용. 선택한 제공처 키만 확인·갱신하며 기존 비용 상한과 중복 실행 방지 유지 |
| Windows 검증 도구 | CP949 기본 환경에서 한글 소스 읽기 실패. 운영 Compose 테스트가 Docker CLI 플러그인 탐색에 필요한 Windows 환경변수를 제거함 | 소스·설정·출력에 UTF-8 명시, 테스트에서 Windows 시스템 경로 환경변수 보존. 애플리케이션 인증정보는 계속 제외 |

주요 수정 파일:

- [비밀번호 검증](../backend/core-service/src/main/kotlin/ai/govbiz/core/account/helper/PasswordValidationHelper.kt), [재설정 토큰 잠금](../backend/core-service/src/main/resources/mybatis/account/repository/AccountPasswordResetMapper.xml)
- [관심 공고 상태](../frontend/web/src/presentation/shared/support-program/useSupportProgramSaveViewModel.ts), [이메일 인증 상태](../frontend/web/src/presentation/features/auth/viewmodel/useSignupViewModel.ts)
- [공고별 근거 검색](../backend/ai-service/app/support_program_evidence/service.py), [AI 공고 ID](../backend/ai-service/app/assistant_agent/models.py), [Core 카드 검증](../backend/core-service/src/main/kotlin/ai/govbiz/core/assistant/service/AssistantMessageService.kt), [Shared 카드 검증](../frontend/packages/shared/src/data/models/AssistantAnswerDto.ts)
- [수집 계획](../infrastructure/gitops/scripts/catalog_once.py), [Catalog 경계 검사](../infrastructure/scripts/verify-catalog-separation.py)

기존 호출 계층은 유지했다. 신규 비밀번호는 `화면 → Shared UseCase → Core Controller → Service → Repository/MyBatis → MySQL` 흐름에서 검증한다.
재설정은 Service transaction이 토큰 잠금·비밀번호 저장·토큰 및 세션 폐기를 묶는다.
근거 검색은 기존 `AI API → Evidence Service → 질문 임베딩 → Qdrant`에서 검색 방식만 문서별 그룹으로 바꿨다.

## 실행한 검증

| 영역 | 실제 결과 |
| --- | --- |
| Core | JDK 21 선택 8클래스 65개 통과. 전체 테스트 소스 컴파일, Mapper XML 파싱·잠금 구문 확인 |
| Catalog | JDK 21 선택 10클래스 135개 통과. 제공처 페이지 완전성·실패 시 스냅샷 보존·색인 공개·내부 인증 포함 |
| AI | 무료 `tests` 전체를 두 실행으로 나눠 1,347개 통과. 이후 ID 계약 수정 관련 도우미 106개 통과. 106개는 앞선 실행과 중복되므로 합산하지 않음 |
| Web·Shared·Mobile | Web 126개, Shared 11개, Mobile 3개 통과. 타입 검사 및 수정 파일 oxlint 통과 |
| Ops | 잠금 버전 Ruff 0.16.8로 14개 파일 check 및 format check 통과 |
| GitOps·릴리스 | GitOps 161개·release 53개·codebuild 23개 무료 테스트 통과. repository/MSA·Helm 오프라인 정책 검사 통과 |
| Windows 실행 설정 | Compose 모델 검사, Catalog `--config-only` 실제 실행 통과. 인코딩 회귀 1개, 운영 Compose 설정 테스트 14개 통과 |
| 변경 정합성 | 서비스 간 ID 계약과 프런트 요청 수명 처리를 교차 검토. `git diff --check` 통과 |

AI 근거 검색, 도우미 ID, 신규 비밀번호, 프런트 인증·저장 문제는 기존 코드에서 실패하는 회귀 테스트를 확인했다.
프런트 요청 경합 회귀 6개는 수정 전 실패·수정 후 통과를 확인했다.
Mobile 첫 콜드 실행에서는 기존 테스트 하나가 5초 제한을 초과했으며 동일 명령 재실행 시 3개 모두 통과했다.
Windows JDK Unix socket 오류는 테스트 프로세스에만 긴 `jdk.net.unixdomain.tmpdir`을 지정하여 TCP 대체 경로로 검사했다.
운영 Compose 테스트는 테스트 프로세스의 PATH에 Git Bash의 `usr/bin`을 추가해 기존 `sh` 검증도 수행했다.

## 재실행 명령

Core와 Catalog는 해당 서비스 디렉터리에서 JDK 21로 실행했다.

```powershell
# backend/core-service
.\gradlew.bat test --tests '*AssistantMessageAgentServiceTest' --tests '*AssistantMessageServiceTest' --tests '*AccountAuthControllerTest' --tests '*PasswordByteLimitTest' --tests '*AccountSignupServiceTest' --tests '*AccountProfileServiceTest' --tests '*AccountPasswordResetServiceTest' --tests '*AccountDevLoginServiceTest' --no-daemon

# backend/catalog-service
.\gradlew.bat test --tests '*BizInfoClientTest' --tests '*KStartupClientTest' --tests '*MsitClientTest' --tests '*CnTradeNoticeClientTest' --tests '*SupportProgramIndexSyncServiceTest' --tests '*BizInfoSupportProgramCatalogSyncServiceTest' --tests '*KStartupSupportProgramCatalogSyncServiceTest' --tests '*MsitSupportProgramCatalogSyncServiceTest' --tests '*CnTradeNoticeSupportProgramCatalogSyncServiceTest' --tests '*CatalogInternalAuthFilterTest' --no-daemon
```

AI는 WSL의 잠금 의존성 환경(Python 3.11.16)에서 아래를 실행했다. 두 번째 명령은 첫 번째에서 통과한 경로만 제외한다.

```bash
# backend/ai-service
uv run --locked --extra dev python -m pytest tests/support_program_evidence tests/assistant_agent/test_saved_programs.py
uv run --locked --extra dev python -m pytest tests --ignore=tests/support_program_evidence --ignore=tests/assistant_agent/test_saved_programs.py
# 마지막 ID 수정 후
uv run --locked --extra dev python -m pytest tests/assistant_agent
```

프런트엔드는 저장소 루트에서 실행했다.

```powershell
pnpm.cmd --dir frontend/web test src/presentation/features/auth/viewmodel/useSignupViewModel.test.tsx src/presentation/shared/support-program/useSupportProgramSaveViewModel.test.tsx src/App.savedPrograms.test.tsx src/App.accountScreens.test.tsx src/domain/usecases/AccountProfileUseCases.test.ts
pnpm.cmd --dir frontend/web test src/data/api/__tests__/assistantApi.test.ts src/presentation/shared/assistant/AssistantWidget.test.tsx
pnpm.cmd --dir frontend/packages/shared test src/domain/usecases/SignUpUseCase.test.ts
pnpm.cmd --dir frontend/mobile test --runTestsByPath src/screens/AccountScreen.test.tsx
pnpm.cmd --dir frontend/web exec tsc -b
pnpm.cmd --dir frontend/packages/shared typecheck
pnpm.cmd --dir frontend/mobile typecheck
```

인프라의 무료 테스트는 각 Python 환경에서 저장소 루트를 기준으로 실행했다.

```bash
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_*.py'
python -B -m unittest discover -s infrastructure/release -p 'test_*.py'
python -B -m unittest discover -s infrastructure/codebuild -p 'test_*.py'
python -B -m unittest discover -s infrastructure/scripts -p 'test_catalog_separation_config.py'
python -B -m unittest discover -s infrastructure/scripts -p 'test_production_config.py'
python -B infrastructure/scripts/check-compose.py
python -B infrastructure/scripts/verify-catalog-separation.py --config-only
git diff --check
```

## 남은 검증과 한계

현재 Docker 엔진에 연결되지 않아 실제 MySQL 8.4·Qdrant 서버·컨테이너 연동을 실행하지 않았다.
특히 새 재설정 동시성 테스트는 컴파일만 확인했으며 실행 통과로 보지 않는다. AI Qdrant 검증은 인메모리 모드였다.
Ops는 실행 의존성 환경도 없어 Django 런타임·MySQL 테스트를 실행하지 못했다.
인프라 통합 테스트 최초 실행에서 환경 의존 16개가 건너뛰어졌고 WSL의 Docker CLI 설정 검사 오류는 Windows에서 관련 14개를 별도 실행해 확인했다.
따라서 인프라 전체 통합 테스트 통과로 표현하지 않는다.

실제 OAuth·SMTP·외부 문서 도구·유료 OpenAI 품질 평가, 모바일 실기기, 전체 클린 빌드·모바일 export는 이번 검증에 포함하지 않았다.
Kubernetes/Helm 검사는 오프라인이며 실제 클러스터 배포나 Argo CD 동기화 완료를 의미하지 않는다.

기존 커밋의 CI 성공은 이번 수정 검증을 대신하지 않는다. 현재 수정은 아직 푸시되지 않았으므로 신규 변경의 원격 CI는 대기 상태다.
변경 경로는 기존 `ci.yml`, `catalog-ci.yml`, `infra-ci.yml` 검증 대상에 포함된다.
푸시 후 최신 커밋에 대한 전체 테스트·MySQL 통합·컨테이너 검증이 실제 통과해야 전체 검증 완료로 판단할 수 있다.
