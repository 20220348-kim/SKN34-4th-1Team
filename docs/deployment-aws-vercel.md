# Vercel + AWS 운영 배포 준비

> 현재 운영 환경은 없습니다. 아래 AWS/Vercel 구성·배포 이력은 재구성 참고 자료이며 현재 가동 상태를 뜻하지 않습니다. 재배포 전 저장소·브랜치·대상 리소스와 비밀 설정을 다시 검토해야 합니다. 런타임 이름은 `core-service`·`ops-service`로 통일했습니다.

## 완료 범위와 전제

2026-09-13 확인: AWS 프로젝트는 `govbiz`, 리전은 **시드니 `ap-southeast-2`**, 계정은 무료 플랜/$100 크레딧이다.
**운영 설정을 준비한 단계이지 클라우드 배포 완료가 아니다.** AWS 자원 생성·ECR 게시·Vercel 배포·데이터 이전·유료 API 평가는 실행하지 않는다.

- [개발 Compose](../infrastructure/compose.yaml): 기존 파일 유지. 로컬 MySQL·Vite·검증 스텁 포함.
- [운영 Compose](../infrastructure/compose.prod.yaml): 독립된 `govbiz-prod` 프로젝트. Nginx/Core/AI/Nori/Qdrant/Redis/RabbitMQ만 실행.
  MySQL은 private RDS, 화면은 Vercel로 분리한다.
- [환경값 예시](../infrastructure/.env.production.example), [Nginx](../infrastructure/nginx/default.conf.template),
  [Vercel 설정](../frontend/web/vercel.json), [미들웨어](../frontend/web/middleware.ts), [사전 검사](../infrastructure/scripts/check-production.py).

개발·운영 Compose를 여러 `-f`로 합치거나 같은 프로젝트 이름으로 실행하지 않는다.
운영은 소스 bind mount/로컬 빌드 없이 릴리스 이미지를 실행한다. restart 정책·메모리 상한·로그 회전을 포함한다.
메모리 상한 합계 약 6.9 GiB는 측정된 사용량이나 EC2 권장 사양이 아니다. OS·Docker·캐시 여유가 별도로 필요하다.

## 요청 흐름과 보안

`브라우저 → Vercel middleware/external rewrite → CloudFront → VPC origin → Nginx → Core`

Vercel middleware는 AI를 실행하지 않고 `/api`의 목적지와 전달 헤더만 정한다.
대화 기록 API의 계정 확인에 필요한 `X-Chat-Account`도 쿠키와 함께 전달한다. 이 헤더가 누락되면 빈 대화 목록도 조회 오류로 표시되며, Core는 전달된 이메일과 세션 계정의 일치 여부를 검증한다.
공식 `@vercel/functions`를 사용하며 Node.js 라우팅 실행·요청량은 Vercel 요금/제한의 적용 대상이다.

1. 고정 운영 Vercel origin과 Production 환경만 허용한다. Preview/다른 배포 별칭은 403, 설정 누락은 503이다.
2. Vercel의 `x-vercel-forwarded-for`에서 단일 IPv4/IPv6만 채택한다. 브라우저가 준 전달 헤더를 신뢰하지 않는다.
3. Cookie·Origin·Content-Type 등을 보존하고 서버 전용 `GOVBIZ_PROXY_SECRET` 및 IP를
   `X-Govbiz-Proxy-Secret`, `X-Govbiz-Client-IP` 요청 헤더에 넣는다. 비밀값은 VITE 변수/브라우저 번들/일반 응답에 넣지 않는다.
4. CloudFront는 이 헤더·쿠키·쿼리·메서드·body를 보존해야 한다. Nginx는 공유 비밀값 없는 직접 CloudFront 접근을 403으로 거부한다.
5. Nginx가 `X-Forwarded-For`와 HTTPS 여부를 새로 쓰고 프록시 비밀값을 제거한다.
   Core는 Tomcat native 전달 헤더 처리에서 **Nginx `172.30.254.2` 한 주소만** 신뢰한다.
   기존 `request.remoteAddr` 기반 로그인/검색 제한에 사용자 IP가 전달된다. 같은 공인 IP를 쓰는 사용자는 IP별 한도를 공유한다.
6. 실제 회원 인증·권한·Origin 검사는 기존 Core가 수행한다. 프록시 비밀값은 회원 인증의 대체물이 아니다.

Docker `proxy` CIDR `172.30.254.0/28`이 VPC/기존 망과 겹치면 subnet·Nginx IP·Core 신뢰 IP 정규식을 함께 바꿔 검증한다.
Core/AI/검색 엔진/큐에는 host ports가 없다. Elasticsearch는 인증을 끈 격리망 구성으로, 신뢰하지 못하는 컨테이너와 공유하지 않는다.
Redis/Qdrant/RabbitMQ 비밀값은 각각 다르다. 컨테이너 내부 TLS·상호 인증을 구현한 구성은 아니다.

Nginx·Vercel은 API 응답의 캐시를 끄며 CloudFront도 CachingDisabled가 필수다.
`/api` 접두사, 여러 Set-Cookie, Secure/HttpOnly/SameSite=Lax/host-only 쿠키를 보존한다.
Nginx 접근 로그는 쿼리·쿠키·비밀 헤더를 제외하고 error log는 crit로 제한한다.
AWS/Vercel 외부 로그에도 비밀 헤더·OAuth code·쿠키를 기록하지 않도록 설정해야 한다.

## 서버를 만들기 전 사용자 결정

1. **예산/가동 시간:** EC2·RDS·EBS·NAT Gateway·공인 IPv4·CloudFront·ECR·로그·전송량을 합산한다.
   크레딧을 제외한 월 운영비·하루 가동 시간·발표 후 종료일을 정하고 [AWS 계산기](https://calculator.aws/)에서 시드니 견적을 만든다.
   $100으로 전체 구성이 6개월 유지된다고 가정하지 않는다. AWS 크레딧은 OpenAI 비용에 사용할 수 없다.
2. 선택한 EC2/RDS 사양·기능이 무료 플랜에서 가능한지 확인한다. 유료 전환·고급 기능 활성화·구조 변경은 별도 결정이다.
3. Vercel에서 Git 저장소를 연결하고 Root Directory를 `frontend/web`로 선택한다. 공유 패키지를 읽을 수 있게
   **Include source files outside of the Root Directory in the Build Step**을 켠다. 루트 `pnpm-lock.yaml`을 사용하며
   설치 명령은 `frontend/web/vercel.json`의 웹 workspace 필터를 따른다. 실제 발급된 `*.vercel.app` 주소를 사용한다.
   AWS 프로젝트 이름이 `govbiz`여도 같은 Vercel 주소가 보장되지는 않는다.
4. 저장소 공개 범위·개인/조직 소유 여부와 Vercel 요금제 제약을 확인한다. 임의로 저장소를 공개하거나 유료 전환하지 않는다.

## AWS 구성 — 아직 실행하지 않은 절차

[기존 예정 아키텍처](assets/architecture/README-aws.md)의 단일 EC2 안을 유지한다. Terraform/CD 구현은 포함하지 않는다.

- VPC: EC2 private subnet, NAT/EIP public subnet, IGW, 외부 API/ECR/SSM용 outbound 라우팅.
  CloudFront VPC origin 관리형 ENI에 필요한 private IPv4 여유도 확보한다.
- EC2: 공인 IP 없이 SSM으로 관리. ECR pull/SSM 인스턴스 역할을 설정한다.
  Nginx의 **EC2 사설 IPv4:80**에 CloudFront 서비스 관리 보안 그룹만 허용한다.
  Core 8080·AI 8000·ES 9200·Qdrant 6333/6334·Redis 6379·RabbitMQ 5672/15672는 외부에 열지 않는다.
- RDS MySQL 8.4: Public access 비활성, DB subnet group 두 AZ 이상, EC2 앱 보안 그룹에서 3306만 허용.
  utf8mb4 `govbiz` DB와 해당 DB 전용 앱 계정을 준비한다. master/root 계정을 앱에 넣지 않는다.
  현재 Flyway가 기동 시 migration을 실행하므로 앱 계정에는 해당 DB의 필요한 DDL/DML 권한이 필요하다.
- EBS: 컨테이너 실행 전에 Docker data-root의 영속 디스크 mount를 확인한다. named volume은 백업이 아니다.
  RDS 자동 백업, EBS/검색/큐의 일관된 백업과 복구 시험은 별도로 수행한다.
- ECR: Core/AI/Nori를 대상 EC2 CPU 아키텍처로 빌드·게시하고 고정 commit tag/digest를 지정한다.
  Nori 이미지는 반드시 `infrastructure/elasticsearch/Dockerfile`로 빌드한다. `latest`는 사용하지 않는다.

### CloudFront

별도 도메인/ACM 없이 기본 `https://<distribution>.cloudfront.net` 주소를 사용한다.

| 항목 | 필수 설정 |
|---|---|
| Origin | private EC2 Nginx VPC origin HTTP 80, Origin path 비움 |
| 연결 시도 | 1회, 시간 초과 후 GET 검색 중복 실행 방지 |
| 동작/메서드 | `/api/*`, GET·HEAD·OPTIONS·PUT·POST·PATCH·DELETE 모두 |
| Viewer protocol | HTTPS Only |
| Cache policy | Managed-CachingDisabled, TTL 0 |
| Origin request policy | AllViewerExceptHostHeader 또는 동등한 cookie/query/필수 header 전달 정책 |
| 오류 처리 | 설정 가능한 오류의 Error Caching Minimum TTL 0, HTML/200 치환 금지 |
| 응답 대기 | Nginx 100초보다 긴 origin response timeout 목표 110초, 계정 쿼터 확인 필요 |

Vercel 외부 프록시 제한은 120초다. CloudFront 기본 30초에서는 기존 AI 요청이 먼저 끊길 수 있다.
110초가 허용되는지 확인하고 필요한 쿼터를 확보하기 전에는 장시간 AI 배포 완료로 판정하지 않는다.
Response completion timeout도 read timeout보다 짧지 않게 하고 Vercel 제한을 고려한다.
Nginx 100초는 읽기 사이의 timeout이지 절대 총시간 제한이 아니다. 요청 body 상한은 2 MiB로,
기존 대화 snapshot의 2,000,000 byte 상한과 요청 JSON wrapper를 수용한다. 장문 대화 저장도 실사용 시험에 포함한다.

## 비밀값·RDS 인증서·Vercel 환경변수

실제 환경 파일 예시는 EC2 `/opt/govbiz/.env.production`이며 권한은 **600**이다.
개발 `.env`를 복사하지 말고 운영 예시를 채운다. 실제 환경 파일과 인증서는 Git 제외다.
`docker compose config`는 비밀값을 출력하므로 사전 검사 또는 `config --quiet`를 사용한다.
프록시/JWT/Redis/RabbitMQ/Qdrant 비밀값은 각각 `openssl rand -hex 32`로 생성한다.
Docker 관리자에게 컨테이너 환경이 보이므로 Docker/SSM 권한을 제한한다.

RDS는 Connector/J `sslMode=VERIFY_IDENTITY`로 인증서·호스트명을 확인한다.
`RDS_HOST`에는 실제 AWS endpoint를 지정하고 공개 RDS 루트 CA만 담은 PKCS12 truststore를 read-only mount한다.
이 설정은 DB 연결에만 적용하며 공고 HTTPS 호출의 JVM 기본 신뢰 저장소는 덮어쓰지 않는다.

인증서 준비:

1. [AWS RDS 안내](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)에서 시드니 `ap-southeast-2-bundle.pem`을 받는다.
2. PEM 인증서를 각각 분리하고 `openssl x509 -in 인증서.pem -noout -subject -issuer -dates`로 확인한다.
   **루트 CA만** 신뢰 저장소에 넣고 중간 CA는 넣지 않는다.
3. 확인한 루트마다 JDK 21의 아래 명령으로 서로 다른 alias를 사용해 추가한다.

```bash
keytool -importcert -noprompt -alias 확인한루트이름 -file 루트CA.pem \
  -keystore rds-truststore.p12 -storetype PKCS12 -storepass changeit
keytool -list -keystore rds-truststore.p12 -storetype PKCS12 -storepass changeit
```

4. `/opt/govbiz/certs/rds-truststore.p12`에 두고 Core 비루트 사용자가 읽을 수 있게 한다.
   `RDS_TRUSTSTORE_PATH`는 이 파일의 절대 경로다. `changeit`은 공개 CA 파일 비밀번호이며 DB 비밀번호가 아니다.
   개인키를 넣지 않는다. 실제 RDS TLS 연결 검증은 RDS 생성 후 수행해야 한다.

Vercel **Production** 환경변수:

| 이름 | 값 |
|---|---|
| `VITE_CORE_API_BASE_URL` | `/` (브라우저 공개 값) |
| `VITE_ASSISTANT_AI_ENABLED` | 도우미 자유 질문 AI 호출 스위치. `true`일 때만 모델을 호출하며 비우면 꺼짐 |
| `VITE_KAKAO_CHANNEL_ID` | 도우미 "담당자에게 문의"가 여는 카카오톡 채널 공개 ID(`_`로 시작, 브라우저 공개 값). 비우면 문의 항목 없음 |
| `GOVBIZ_FRONTEND_ORIGIN` | 실제 `https://<project>.vercel.app`, 끝 / 없음 |
| `GOVBIZ_API_ORIGIN` | 실제 `https://<distribution>.cloudfront.net`, 끝 / 및 `/api` 없음 |
| `GOVBIZ_PROXY_SECRET` | EC2와 같은 64자리 공유 비밀값, Sensitive 처리 |

`VERCEL_ENV`는 Vercel 시스템 변수다. 직접 production으로 위조하지 않는다. Preview에 운영 비밀값을 넣지 않는다.
Node 24.x/pnpm 11.22.x, Vite, `pnpm build`, output `dist`를 사용한다.
초기 backend 변수 없이 화면을 배포해 Vercel 주소만 확인할 수 있지만 API는 503인 준비 상태다.
OpenAI·DB·JWT·Redis·RabbitMQ·Qdrant 비밀값은 Vercel이 아닌 EC2에만 둔다.
`VITE_DEV_PROXY_TARGET`은 Vercel 운영 프록시가 아니다.

### 도우미 LLM과 카카오 문의 활성화

- Vercel **Production**에 `VITE_ASSISTANT_AI_ENABLED=true`와 `VITE_KAKAO_CHANNEL_ID`(채널 공개 ID)를
  설정한 뒤 재배포한다. 개발 Compose의 `ASSISTANT_AI_ENABLED`/`KAKAO_CHANNEL_ID` 이름만 Vercel에 넣어서는 반영되지 않는다.
- EC2 환경 파일에 `ASSISTANT_AGENT_ENABLED=true`, 32자 이상의 `ASSISTANT_TOOLS_TOKEN`을 설정한다.
  운영 Compose가 같은 토큰을 Core와 AI에 전달하고, AI의 도구 주소는 `http://core-service:8080`을 사용한다.
  공유 토큰은 Vercel, `VITE_*`, Git, 브라우저에 넣지 않는다.
- 호출 흐름은 `브라우저 → 운영 프록시 → Core → AI 도우미 → OpenAI`다. 로그인 사용자 데이터가 필요한 경우에만
  AI가 공유 토큰과 사용자별 서명 토큰으로 Core 내부의 읽기 전용 도구를 호출한다.
- 켜진 뒤 자유 질문에는 LLM 비용이 발생한다. 이 설정으로 자동 수집이나 백그라운드 사전 색인을 켜지는 않는다.
  기존 호출 제한을 유지하고 별도 동의 없이 정기 작업을 활성화하지 않는다.
- 환경 파일 수정만으로는 컨테이너 환경이 바뀌지 않는다. 운영 Compose의 전달 항목을 확인하고 AI/Core만 재생성한다.
  기존 서버의 고정 IP·메일·비밀값을 보존한다. 백엔드 자동 배포는 이미지 값만 교체하므로 이 서버 설정은 유지된다.

Core CORS·OAuth 콜백/복귀 주소는 같은 고정 Vercel origin으로 설정한다.
Google/Kakao 콘솔에 `<운영 origin>/api/v1/auth/oauth/{google|kakao}/callback`을 별도 등록한다.
OAuth 자격증명이 없는 공급자는 사용할 수 없으며 이메일 회원가입/로그인은 별도로 검증한다.

### 계정 인증메일과 소셜 로그인 활성화

SMTP와 OAuth 비밀값은 EC2의 권한 600 환경 파일에만 저장한다. Git, Vercel `VITE_*`,
SSM Run Command 본문이나 로그에 넣지 않는다. 기존 운영 JWT·DB·프록시 비밀값은 유지한다.

- Google/Kakao client ID와 secret을 설정하고, 공급자 콘솔에 위 운영 콜백을 정확히 등록한다.
  카카오는 로그인과 OpenID Connect 및 앱에서 필요한 이메일 동의항목을 확인한다.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`를 설정한다. Gmail SMTP는
  `smtp.gmail.com:587`, 계정의 앱 비밀번호, `SMTP_AUTH=true`, `SMTP_STARTTLS_ENABLED=true`,
  `SMTP_SSL_ENABLED=false`를 사용한다. 일반 Google 로그인 비밀번호를 넣지 않는다.
- `ACCOUNT_EMAIL_VERIFICATION_FROM`과 `ACCOUNT_PASSWORD_RESET_FROM`에 허용된 발신 주소를 설정하고
  `ACCOUNT_EMAIL_VERIFICATION_MAIL_ENABLED=true`, `ACCOUNT_PASSWORD_RESET_MAIL_ENABLED=true`로 켠다.
  개발 로그인은 false, Secure 쿠키는 true, 복귀/재설정 URL은 운영 HTTPS origin을 유지한다.
  수집·색인·정기 리포트 스위치는 이 작업으로 켜지 않는다.
- 변경 전 환경 파일과 Compose를 비공개 경로에 백업하고 정적 검사를 통과한 뒤,
  `docker compose --env-file /opt/govbiz/.env.production -f /opt/govbiz/infrastructure/compose.prod.yaml up -d --no-deps --wait --wait-timeout 240 core-service`
  로 Core만 재생성한다. 서버에서 별도 적용한 네트워크/IP 설정을 덮어쓰지 않는다.
- health, OAuth 공급자 목록과 운영 콜백을 확인한다. SMTP 인증 성공만으로 메일 수신이나
  회원가입 검증이 완료된 것은 아니다. 승인된 테스트 수신자로 인증번호 수신·가입·로그인·재설정 및
  공급자 로그인/동의까지 별도로 검증한다.

## 최초 기동과 데이터 준비

아래는 **AWS 구성과 비용 승인을 마친 뒤 EC2에서** 실행한다. 지금 자원을 만들라는 뜻이 아니다.
EC2 셸에 개발 환경변수가 export되어 있으면 Compose 값을 덮어쓰므로 제거하고 실행한다.

```bash
python3 infrastructure/scripts/check-production.py --env-file /opt/govbiz/.env.production
docker compose --env-file /opt/govbiz/.env.production -f infrastructure/compose.prod.yaml pull
docker compose --env-file /opt/govbiz/.env.production -f infrastructure/compose.prod.yaml up -d --wait --wait-timeout 240
```

ECR pull 인증은 실제 주소/IAM 준비 후 수행한다. 사전 검사 통과는 이미지 존재·TLS 연결·실행 용량 보증이 아니다.
Flyway 실패 시 DB 삭제/migration 수정 대신 적용 이력·권한·연결을 확인한다.

기본값은 네 제공처 수집·색인 복구·다섯 큐 실행·정기 리포트/메일이 꺼져 있다.
**서버 health 정상과 검색/분석 준비 완료는 다르다.** 실제 공고 API 권한·OpenAI 호출 예산 확인 후 필요한
`*_SYNC_ENABLED`, `SUPPORT_PROGRAM_INDEX_ENABLED`, `*_QUEUE_ENABLED`를 true로 바꾸고 Core를 재생성한다.
카카오 연결 해제는 `ACCOUNT_OAUTH_UNLINK_ENABLED`와 `ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED`를 함께 켠다.
queue 스위치만 끄면 기존 DB 직접 실행 모드가 동작하므로 초기에는 기능 스위치도 false로 둔다.
이전 DB/큐를 복원했다면 켜는 즉시 대기 작업이 실행될 수 있으므로 기존 작업·외부 호출/연결 해제/메일 영향을 먼저 검토한다.
계정 인증·비밀번호 재설정 메일의 기본값도 false다. 위 활성화 절차로 SMTP/발신 주소를 준비한 뒤 켠다.

실배포 완료 기준:

- Vercel `/api/v1/health`, `/api/v1/health/ai-service` 정상. 직접 CloudFront 접근은 403, 내부 서비스 포트는 비공개.
- `/api/v1/support-programs/readiness`에서 사용하는 제공처의 실제 색인 준비를 확인.
- 회원가입·로그인·로그아웃·OAuth·대화 저장/삭제·새로고침 및 서로 다른 계정의 쿠키/응답 분리 확인.
- API에 CDN HIT/Age가 없어야 하며 위조 전달 IP로 요청 제한을 우회하지 못함.
- `/login`, `/app/chat` 직접 접근은 SPA, 없는 `/api/...`는 HTML 200이 아닌 API 오류.
- 유료 검색은 별도 승인한 질문/예산 안에서 실행하고 긴 응답의 timeout/중복 실행을 확인.

단일 EC2의 중단 가능 배포다. 고가용성·무중단·자동 롤백을 보장하지 않는다.
갱신 전 이전 이미지 digest·설정·백업을 기록하고 장애 시 스키마와 호환되는 이전 이미지/설정으로 재생성한다.
이미지 rollback은 Flyway rollback이 아니다. 비호환 migration 복구는 쓰기를 중단하고 별도 승인받는다.
운영에서 `down --volumes`/`prune`을 쓰지 않는다. ECR 게시·SSM 배포·승인·자동 health/rollback 파이프라인은 후속 작업이다.

## 로컬 무료 검증

```bash
python3 -B -m unittest discover -s infrastructure/scripts -p 'test_*.py'
python3 infrastructure/scripts/verify-production-proxy.py
./infrastructure/scripts/verify-compose.sh
```

첫 번째는 Compose 정적 검사와 기존 로컬 스텁·정리 보호 테스트다. Docker 자원은 생성하지 않지만 로컬 테스트 서버의 임시 포트를 사용한다.
두 번째는 임시 Nginx/가상 Core로 요청 계약을 검증하고 이 실행의 자원 ID만 제거한다.
세 번째는 기존 검증 전용 Compose와 가상 OpenAI/공고 API를 사용한다.
기존 개발 DB가 검증 기본 포트 `13306`을 사용 중이면 중지하지 말고
`VERIFY_COMPOSE_MYSQL_HOST_PORT=23306 ./infrastructure/scripts/verify-compose.sh`처럼 비어 있는 검증 포트를 지정한다.
Web/Core/Qdrant도 각각 `VERIFY_COMPOSE_WEB_HOST_PORT`, `VERIFY_COMPOSE_CORE_API_HOST_PORT`,
`VERIFY_COMPOSE_QDRANT_HOST_PORT`로 분리할 수 있다.
Frontend test/lint/build, Core JDK 21 clean build/Testcontainers, AI uv lock/pytest/build도 수행한다.
로컬 메모리가 부족하면 무거운 전체 테스트·Docker 빌드를 동시에 실행하지 않는다.
로컬 검증은 실제 Vercel/CloudFront 정책·RDS TLS·AWS 보안 그룹·유료 검색 품질의 검증을 대체하지 않는다.

2026-09-13 검증 결과:

- Frontend: Node 24/pnpm 11.22에서 `pnpm test --maxWorkers=1` 1,116건, lint, build 통과.
  로컬 병렬 실행의 시간 초과 이후 단일 worker로 전체를 재검증했다.
- Core: JDK 21 `./gradlew clean build --no-daemon`, 실제 MySQL Testcontainers를 포함한 1,305건 통과(건너뜀 0).
- AI: uv lock/sync/의존성 확인, 실제 테스트용 Qdrant를 포함한 pytest 1,003건, 패키지 build 통과. 모델 호출은 테스트 대역을 사용했다.
- Infrastructure: 설정/정리 보호 테스트 32건, 실제 Nginx 프록시 계약·2MB 본문/초과 차단, 기존 Compose 전체 통합 검증 통과.
  전체 통합 검증은 개발 DB 포트 충돌을 별도 포트로 해소했다. 이후 Core 재시작 직후 복원 요청이 한 차례 10초를 초과했으나,
  검사 조건을 완화하지 않은 재실행에서 결과 복원·계정 소유권·Redis/RabbitMQ/Qdrant/AI 장애 및 복구까지 통과했다.
- Vercel 설정 스키마·로컬 문서 링크·`git diff --check` 확인. 실제 Vercel 실행·AWS 배포는 미검증이다.

공식 참고: [Vercel 미들웨어](https://vercel.com/docs/routing-middleware/getting-started),
[전달 헤더](https://vercel.com/docs/headers/request-headers), [캐시](https://vercel.com/docs/routing/rewrites),
[프록시 제한](https://vercel.com/docs/limits),
[CloudFront VPC origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html),
[origin timeout](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html),
[Spring 신뢰 프록시](https://docs.spring.io/spring-boot/how-to/webserver.html),
[Connector/J TLS](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-security.html).
