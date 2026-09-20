# Mac Kubernetes 무료 데모

`infrastructure/gitops/`의 **govbiz-portfolio** kind 클러스터 전용이다. 기존 Compose 데이터나 AWS/RDS를
복사하거나 수정하지 않는다. 자동 배포·앱 시작 때 실행하지 않는 수동 도구이며, Git에는 비밀번호를 넣지 않는다.

## 시연 데이터와 경계

| 대상 | 내용 |
| --- | --- |
| 공고 | `[데모]` 가상 공고 8건: 기업마당 분류 5건, K-Startup·과기정통부·충남 수출 분류 각 1건 |
| 계정 | `demo1@portfolio.govbiz.local`, `demo2@portfolio.govbiz.local`, 모두 `USER` |
| 기업·모집 | 가상 기업·파트너 프로필·모집글 각 2건 |
| 관심 공고 | 각 계정에 1건 |

실제 기관이 발행한 공고가 아니다. 제목·기관·설명에 데모를 표시하고, 공고 원문 링크에는 해당
제공처 **홈페이지**만 넣는다. 실제 공고 상세 URL을 만들어 내거나 공식 도메인 검증을 해제하지 않는다.
접수 기간은 입력일 전날부터 90일 뒤까지, 모집글은 입력일 60일 뒤까지다. 시간이 지나면 정상적으로
마감되며 재실행으로 기간이나 기존 데이터를 덮어쓰지 않는다.

관리자·공유 기본 비밀번호는 만들지 않는다. 두 계정의 비밀번호를 각각 무작위로 생성해 BCrypt
cost 12로 저장한다. 이메일·사업자 확인 상태는 **가상 시연용 fixture**이며 실제 메일 인증·국세청 조회를
통과했다는 의미가 아니다. 로그인·기업 화면 시연만을 위한 데이터다.

공고는 Catalog DB에만 입력한다. `Catalog → 인증된 snapshot API → Core projection → 웹`의 기존
경로로 전달되는지 기다린 다음 Core에 계정·기업·모집글을 넣는다. 실제 외부 수집·검색 색인 성공으로
기록하지 않으며 AI 검색·문서 생성·SMTP·OAuth 검증은 포함하지 않는다.

## 실행

Python 3.13, `kubectl`, `htpasswd`와 준비된 portfolio 클러스터가 필요하다. macOS의 `htpasswd`는
`/usr/sbin`에 있다. 아래 명령은 **통합 저장소 루트**에서 실행한다.
기존 Mac 검증 기록을 보존한 도구이며, 통합본에서 portfolio 클러스터를 자동 구성하지는 않는다.
[GitOps 연결 제한](../infrastructure/gitops/README.md)을 먼저 확인한다.

```bash
GOVBIZ_INFRA_DIR="$(cd infrastructure/gitops && pwd -P)"
python3 -B infrastructure/scripts/seed-portfolio-demo.py \
  --kubeconfig "$GOVBIZ_INFRA_DIR/.local/portfolio/kubeconfig" \
  --credentials-file "$GOVBIZ_INFRA_DIR/.local/portfolio/demo-accounts.json"

# 계획을 확인한 뒤 같은 명령에 --apply를 붙인다.
python3 -B infrastructure/scripts/seed-portfolio-demo.py \
  --kubeconfig "$GOVBIZ_INFRA_DIR/.local/portfolio/kubeconfig" \
  --credentials-file "$GOVBIZ_INFRA_DIR/.local/portfolio/demo-accounts.json" \
  --apply
```

최초 입력은 Catalog 공고와 Core 계정 등이 비어 있어야 한다. 전용 loopback cluster·노드명·DB 이름·
MySQL 8.4·외부 수집 비활성을 확인하고, DB별 transaction·빈 테이블 검사를 거친다. 다른 데이터가
있으면 중단한다. 기존 계정 삭제·권한 변경·비밀번호 변경을 하지 않는다.

비밀번호 파일은 기존 private 디렉터리 아래 소유자만 읽는 `0600`으로 생성한다. 위 경로는 infra의
Git 제외 디렉터리다. 값은 채팅·스크린샷·README에 올리지 않는다. 파일을 잃어버린 경우 자동 재설정하지 않는다.
중간 실패 후에는 파일을 유지한 채 상태를 확인하고 재실행한다. 같은 Catalog 식별자와 기존 데모만
확인되면 미완료 단계만 이어가며, 다른 계정·공고가 추가되면 덮어쓰지 않고 멈춘다.

## 확인

[웹 연결 안내](../frontend/web/README.md#mac-kubernetes-백엔드에-연결)에 따라 port-forward와
`pnpm dev:k8s`를 실행한다.

- `http://localhost:5173/?mode=filter`: 공고 8건과 제공처별 필터
- `http://localhost:5173/partners`: 가상 모집글 2건
- `http://localhost:5173/login`: 위 파일의 계정·비밀번호로 일반 로그인
- 로그인 후 기업·관심 공고, 로그아웃 후 인증 필요 화면의 차단

2026-09-20에는 실제 Mac MySQL 8.4에서 최초 입력과 비파괴 재실행, Catalog→Core 전달, 두 계정의
HTTP 로그인·HttpOnly 쿠키·기업·관심 공고 조회·로그아웃·이후 401을 확인했다. 실제 이메일·OAuth·
유료 AI 호출은 수행하지 않았다. 필터와 모집글은 무료 DB 조회이며 AI 기능이 꺼진 상태를 우회하지 않는다.
