# Mac GitOps 연결 검증 — 2026-09-20 KST

> 원본 GovBiz-Team 저장소와 당시 개인 Mac의 **과거 검증 기록**입니다.
> 통합본의 개인 GHCR 연결은 아직 미구현이고 발행·승격·portfolio 자동 sync는 잠겨 있습니다.
> 아래 이력을 새 교육기관 저장소나 팀원 PC의 배포 성공으로 해석하지 않습니다.
> 현재 상태는 [개인 fork 전환 안내](portfolio-gitops.md)를 따릅니다.

대상은 AWS가 아니라 Mac Docker Desktop의 `govbiz-portfolio` kind 클러스터다.
기존 개발 컨테이너 7개는 사용자 승인으로 중지했고 데이터·볼륨은 삭제하지 않았다.
전용 kubeconfig는 `.local/portfolio/kubeconfig`이며 기본 kubectl context 목록은 변경하지 않았다.

## 최초 비공개 배포

- GovBiz 검증 소스: `dc02dbc2f373a3472f9871d65c81a4ea822f1a07`.
- [비공개 이미지 발행](https://github.com/GovBiz-Team/GovBiz/actions/runs/35495417542): 네 publish job 성공.
- 초기 infra 설정: `3cadadf6859483692524caf65592d8487e48f085`.
- GHCR 전용 classic PAT는 `read:packages`만 있는 것을 확인하고 `ghcr-pull` Secret으로 전달했다.
  토큰 원문은 이 문서·Git·출력에 기록하지 않는다.
- 앱 네 이미지는 kind에 local load하지 않았다. kubelet의 GHCR pull과 실제 기동을 확인했다.
- Argo CD Core 3.5.3의 네 Application 모두 `Synced/Healthy`.
- 클러스터 내부에서 Core `/api/v1/health`, Catalog `/readiness`, AI `/internal/v1/health`,
  Ops `/api/v1/health/ready`가 모두 HTTP 200.

| 서비스 | 최초 이미지 digest | 최초 Pod UID |
| --- | --- | --- |
| Core | `sha256:a29bfaf32372a37297f5205cd36bd9ae399c8b53992bf2d346b698f5088da681` | `d9d4747c-39bd-4da0-a069-ed9f8466210c` |
| Catalog | `sha256:128d4e3a8967fa0df79d2eecef5e63f44e2824bed31c3ccdcd960e3eec4d2e54` | `320d2c47-6698-40f1-98dd-c1490259f82e` |
| AI | `sha256:ad4105aad6f39adb7de933e163441cf43d3a15165df285a85ecf70d2481ecfad` | `20f349a5-c730-4a64-8ac7-ff296e7324a9` |
| Ops | `sha256:af3d40164ffbb9ebd3d389c258f898eb8cd536a4723804d442a7ba7d3868cae6` | `a44c5c80-5048-40f2-ae08-a2cb3baa75ac` |

## 새 이미지의 GitOps 반영

업무 로직 대신 Ops README의 배포 안내만 수정해 서비스별 변경 감지와 실제 교체 경로를 확인했다.

1. 앱 소스 `00f1b10dc636c3446b35fbd37a1ff25ce60adfd9`에서
   [GovBiz CI](https://github.com/GovBiz-Team/GovBiz/actions/runs/35496945611),
   [Catalog CI](https://github.com/GovBiz-Team/GovBiz/actions/runs/35496945742),
   [Ops CI](https://github.com/GovBiz-Team/GovBiz/actions/runs/35496945713)가 모두 통과했다.
2. CI 완료 이벤트가 시작한 [이미지 발행](https://github.com/GovBiz-Team/GovBiz/actions/runs/35497774038)에서
   네 publish job이 성공했다. Ops만 새 digest가 생겼고 다른 세 이미지는 재사용됐다.
3. [Portfolio image promotion](https://github.com/GovBiz-Team/GovBiz-infra/actions/runs/35497874924)은
   최초 연결 확인을 위해 **workflow_dispatch로 시작했다**. 이후 artifact 검증·74개 테스트·배포 설정 검사와
   [digest 갱신 커밋](https://github.com/GovBiz-Team/GovBiz-infra/commit/7120ae8f43df2c28945cf5286fac68cb7285555a)은
   workflow가 수행했다. 이 실행은 schedule 이벤트가 실행됐다는 증거가 아니다.
4. Mac Argo CD가 별도 수동 refresh/sync 없이 위 Git 변경을 확인해 Ops Deployment를 갱신했다.
   네 Application 모두 해당 커밋에서 `Synced/Healthy`였고, 네 health endpoint도 다시 HTTP 200이었다.

Ops의 새 digest는 `sha256:2175a1e43baf437eb28ab871db76c536a19956ef643fd6fda69e89749fa2b4d1`,
새 Pod UID는 `70d81bc2-83a1-4cfb-a7da-a8f51b62b238`이다. Core·Catalog·AI의 digest와 Pod UID는
위 최초 표와 동일했다. 새 Ops Pod도 비공개 GHCR에서 pull했으며 재시작 횟수는 0이었다.

`MSA_RELEASE_ENABLED=true`, `MSA_PROMOTION_ENABLED=true`이며 infra workflow의 10분 주기 schedule을
활성화했다. 최초 검증 시점까지 schedule 이벤트 실행은 관측하지 못했으므로, 주기 실행의 실제 발동과
GitHub 지연 여부는 Actions에서 별도로 확인한다. 배포 선택·push·Argo 자동 반영 자체는 위 실행으로 확인했다.

통합 CI의 첫 시도는 외부 모델 다운로드 체크섬 불일치로 실패했다. 고정 URL의 파일을 별도로 검증하니
원래 SHA-256과 일치했고, 코드·체크섬·테스트를 완화하지 않은 동일 커밋의 실패 job 재실행이 통과했다.

## 정적 검증과 범위

- infra 단위·렌더링 정책 테스트 74개 통과, skip 없음.
- repository 경계·문서 링크, Kustomize, Helm MSA/portfolio 정책 검사 통과.
- `git diff --check` 통과.
- 독립 Core/Catalog/Ops MySQL과 Elasticsearch/Qdrant/Redis를 새 PVC에서 실행했다.
- 데이터 수집·메일·유료 LLM 호출·기존 운영 데이터 이전은 하지 않았다.
- Ops 관리자 기능, NetworkPolicy 집행, 의존성 전체 readiness, 부하·무중단·클라우드 운영은
  이 배포 연결 검증으로 완료됐다고 간주하지 않는다.

실행·중지·토큰 교체 방법은 [portfolio GitOps](portfolio-gitops.md)를 따른다.

## 로컬 웹 연결과 무료 데모 검증

후속 단계에서 Mac의 Vite portfolio 모드를 Kubernetes Core의 loopback port-forward에 연결했다.
`http://localhost:5173/?mode=filter`의 실제 브라우저 화면에서 `[데모]` 공고 8건 표시를 확인했다.
웹 자체를 Kubernetes에 배포한 것은 아니며 AWS·Vercel 설정은 바꾸지 않았다.

- `.env*` 자동 로딩·상속 VITE 값 노출 차단, API 상대 주소·도우미 AI 비활성·개발 로그인 버튼 숨김 확인.
- 웹 `pnpm test --maxWorkers=2`: 100개 파일, 1,244개 테스트 통과. `pnpm lint`, `pnpm build` 통과.
  Mac 클러스터와 함께 실행하므로 테스트 worker 수만 제한했고 timeout·검증은 완화하지 않았다.
- infra 테스트 77개 통과(skip 없음), repository·Kustomize·Helm MSA/portfolio 검사 통과.
- 앱 배포 도구 테스트 93개 실행: 77개 통과, 기존 opt-in Docker MySQL 테스트 16개 미실행.
  이번 데모 도구 테스트 6개는 통과했으며, 실제 입력·재실행은 전용 클러스터의 MySQL 8.4에서 확인했다.
- 공고 8건은 Catalog DB에서 기존 인증 snapshot API로 Core에 전달했다. Core DB를 직접 채워
  projection을 우회하지 않았다. 임시 링크가 웹의 공식 도메인 검증에 거절되는 것을 발견해
  데모 링크를 제공처 홈페이지로 수정하고 새 generation/revision으로 발행했다. 검증 규칙은 유지했다.
- 일반 회원 2개와 가상 기업·프로필·모집글 각 2건, 계정별 관심 공고 1건을 추가했다.
  실제 HTTP 로그인 200·HttpOnly 쿠키·계정/기업/관심 공고 조회·로그아웃 204·이후 401을 두 계정 모두 확인했다.
- `check_portfolio_http.py`: 웹 HTML·Core health·공고 total=8·익명 세션 401 통과.
  공개 모집글 API total=2도 확인했다. 로그인 UI 직접 조작·신규 회원가입 검증과는 구분한다.
- 두 계정은 모두 USER다. 비밀번호는 각각 무작위이며 Git 제외 경로 `.local/portfolio/demo-accounts.json`에
  0600으로만 저장했다. 재실행으로 비밀번호·권한을 변경하지 않았다.
- 네 Application은 계속 `Synced/Healthy`이고 기존 Compose 데이터·볼륨은 그대로다.

이 단계에도 실제 외부 공고 수집·사업자 확인·SMTP·OAuth·OpenAI 호출은 수행하지 않았다.
실제 공고나 AI 품질 검증이 아니다. 10분 schedule의 실제 이벤트는 여전히 관측하지 못했으며
이전 수동 시작 promotion을 schedule 검증으로 바꾸어 보고하지 않는다.
