# GovBiz Vercel + AWS 배포 구성도

2026-09-16에 **기존 배포 확인 기록과 저장소의 운영 설정**을 바탕으로 정리한 포트폴리오 운영 구성입니다.
2026-09-13의 [초기 배포 예정안](README-aws.md)은 비교·이력용으로 보존합니다.
이 그림을 만드는 작업은 서버·데이터·환경변수·배포 트리거를 변경하지 않습니다.

![GovBiz Vercel + AWS 배포 완료 구성](govbiz-aws-architecture-deployed.png)

## 파일

- [PNG](govbiz-aws-architecture-deployed.png): 5,640 × 3,800, 발표·GitHub 첨부용.
- [SVG](govbiz-aws-architecture-deployed.svg): 2,820 × 1,900, 수정 가능한 벡터 원본.
- [생성 스크립트](build-aws.mjs): `--deployed`로 배포 구성 버전을 생성합니다.
- [로고 출처·해시](aws-logo-sources.json): 기존 예정안과 같은 로고를 재사용합니다.
  CodeBuild는 텍스트로 표시하며 별도 로고를 임의로 그리지 않습니다.

## 실제 배포 기록을 반영한 요청 경로

1. 사용자는 `https://govbiz.vercel.app`에서 React·TypeScript 화면에 접근합니다.
2. 같은 주소의 `/api/*` 요청을 Vercel 서버 미들웨어가 처리합니다. 서버 전용 프록시 인증 헤더를
   추가하고 `https://d1zikccbaq81k1.cloudfront.net`으로 외부 rewrite합니다. 비밀값은 그림에 넣지 않습니다.
3. CloudFront VPC origin이 프라이빗 서브넷의 `govbiz-app` EC2에 연결합니다.
   Nginx의 내부 HTTP `:80`을 거쳐 Core API `:8080`으로 전달하며, API는 캐시하지 않는 구성입니다.
4. Core API는 비공개 RDS MySQL 8.4의 원본 데이터, Elasticsearch 키워드 색인,
   Redis 로그인 복원 정보, RabbitMQ 작업 큐와 통신합니다.
5. Core → FastAPI `:8000` → Qdrant / OpenAI 경로로 의미 검색·임베딩·LLM 기능을 실행합니다.
   OpenAI와 공고 제공처로 나가는 인터넷 요청은 NAT Gateway → Internet Gateway를 사용합니다.
6. EC2의 40 GiB EBS에는 Elasticsearch·Qdrant·Redis·RabbitMQ의 영속 데이터를 둡니다.
   MySQL은 EC2의 로컬 MySQL 컨테이너가 아니라 RDS이며, 기존 연결 확인에서 TLS 사용이 확인됐습니다.

실선은 서비스 통신이고 주황 점선은 배포 경로입니다. CloudFront 인바운드가 NAT를 통과하는 것은 아닙니다.
AWS 리전은 시드니(`ap-southeast-2`)이며 CloudFront는 글로벌 서비스입니다.

## 예정안과 달라진 배포 경로

- **프론트엔드**: GitHub 연동 → Vercel 빌드·배포. GitHub Actions CI와 별개 경로입니다.
- **GitHub Actions**: push / PR의 테스트·빌드 검증을 담당합니다. 이 그림에서 ECR·SSM 배포 실행자는 아닙니다.
- **백엔드**: `ilil1/SKN34-3rd-1Team`의 `main` push → CodeConnections 소스 연결 →
  `govbiz-backend-deploy` CodeBuild 검증 → ECR 이미지 게시 → SSM → EC2의 Core / AI 이미지 교체입니다.
- upstream에 PR을 올리는 것만으로 이 저장소의 배포가 시작되는 것은 아닙니다.
  PR 병합이나 fork 동기화로 **배포 대상 저장소의 main에 새 커밋이 들어오는 것**이 트리거 조건입니다.
- 이미지는 commit 태그와 digest로 식별합니다. 운영 환경 파일·Compose·비밀값 전체를 자동으로 덮어쓰는 방식이 아닙니다.
  자세한 동작과 실패 시 복구 시도는 [CodeBuild 배포 문서](../../deployment-codebuild.md)를 따릅니다.
- 예정안의 GitHub OIDC 방식 대신 AWS 서비스 역할과 CodeConnections를 사용합니다.
  CodePipeline이나 별도 GitHub self-hosted runner를 사용하는 구성으로 표시하지 않습니다.

## 근거와 확인 범위

- 기존 배포 과정에서 EC2 생성·SSM 접속, NAT 및 라우팅, Compose 서비스 기동, CloudFront VPC origin,
  Vercel 화면 표시, RDS TLS 연결과 운영 데모 입력을 확인한 기록을 반영했습니다.
- 소스 근거: [운영 Compose](../../../infrastructure/compose.prod.yaml),
  [Vercel 미들웨어](../../../frontend/web/middleware.ts), [Vercel 설정](../../../frontend/web/vercel.json),
  [CodeBuild buildspec](../../../infrastructure/codebuild/backend.yml),
  [이미지 게시·SSM 호출](../../../infrastructure/codebuild/release.py),
  [호스트 이미지 교체](../../../infrastructure/codebuild/deploy_host.py).
- **이번 문서 작성 시 AWS CLI 세션이 만료돼 현재 리소스 상태·webhook 활성 여부·최근 배포 성공을 재조회하지 못했습니다.**
  배포된 토폴로지와 저장소의 배포 설정을 설명하는 기록이며 실시간 상태 대시보드는 아닙니다.
- 단일 EC2이므로 고가용성·무중단 배포를 보장하지 않습니다. 컨테이너 교체 시 중단될 수 있고,
  이전 이미지 복구와 이미 적용된 DB migration 복구는 다릅니다.
- OAuth 공급자 등록, 백업 복구 시험, 부하·보안 검증의 완료를 주장하지 않습니다.
  SMTP·OAuth·Bizno 등 보조 연동과 세부 IAM·보안 그룹 규칙은 가독성을 위해 생략했습니다.
- 원본 로고·라이선스 및 사용 조건은 [기존 출처 설명](README-aws.md#실제-아이콘-출처)을 따릅니다.

## 재생성 및 검증

저장소 루트에서 실행합니다. 기본 모드의 예정안과 로컬 개발 구성도는 바꾸지 않습니다.

```bash
node docs/assets/architecture/build-aws.mjs --deployed

GOVBIZ_DIAGRAM_NODE_MODULES=/path/to/tooling/node_modules \
GOVBIZ_DIAGRAM_CHROME=/path/to/chrome \
node docs/assets/architecture/build-aws.mjs --deployed --render
```

기존 Playwright·Chrome 렌더러로 로고 로딩·글자 폭·캔버스 경계를 검사한 뒤 PNG를 육안 확인합니다.
렌더링 중 외부 네트워크 요청은 차단합니다. 이미지·문서 생성만으로 AWS 배포나 유료 AI 호출을 실행하지 않습니다.
