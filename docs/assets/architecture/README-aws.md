# GovBiz Vercel + AWS 초기 배포 예정 구성도

> 이 문서는 2026-09-13의 예정안을 보존한 기록입니다. 이후 배포를 반영한 그림은
> [Vercel + AWS 배포 구성도](README-aws-deployed.md)에서 확인하세요. 아래의 미구축·미구현 설명은 당시 기준입니다.

2026-09-13 논의한 **Vercel 프론트엔드 + AWS 백엔드(EC2·Docker Compose·비공개 RDS MySQL)**
초기 배포안을 그린 문서용 자산입니다. **별도 도메인을 구매하지 않고 Vercel 기본 주소를 사용**하는 조건을 반영했습니다.
브라우저의 `/api` 요청을 Vercel에서 CloudFront 기본 HTTPS 주소로 중계하고, 비공개 EC2에 연결하는 제안입니다.
**실제 Vercel 프로젝트·AWS 자원·배포 파이프라인·보안 설정을 구축하거나 검증했다는 의미가 아닙니다.**
기존 [로컬 구성 기록](README.md#로컬-구성-기록)은 그대로 보존합니다.

후속 작업에서 [운영 Compose·Nginx·Vercel 미들웨어](../../deployment-aws-vercel.md)를 준비했습니다.
아래 그림은 여전히 **실제 클라우드 배포 전 목표 구성**입니다. 서버 설정 구현 범위는 위 배포 안내가 최신이며,
ECR 게시·SSM 자동 배포·실제 네트워크/TLS 검증은 아직 별도입니다. 확인된 계정 리전은 시드니입니다.

![GovBiz Vercel 프론트엔드와 AWS 백엔드 초기 배포 예정안](govbiz-aws-architecture.png)

## 파일

- [PNG](govbiz-aws-architecture.png): 5,640 × 3,800. 발표·GitHub 첨부용.
- [SVG](govbiz-aws-architecture.svg): 2,820 × 1,900. 수정 가능한 벡터 원본.
- [생성 스크립트](build-aws.mjs): 로컬 아이콘으로 SVG·PNG를 생성합니다.
- [로고 출처·SHA-256](aws-logo-sources.json): 실제 사용한 35개 로고의 원본 URL·해시입니다.

기존 링크를 유지하기 위해 파일명은 `govbiz-aws-architecture`로 유지합니다. 현재 내용은 Vercel + AWS 예정안입니다.

## 주요 연결

- **브라우저 ↔ Vercel**: Vercel이 React·TypeScript 정적 화면을 HTTPS로 제공합니다.
  화면과 API 요청 모두 `https://<project>.vercel.app`이라는 같은 origin을 사용합니다.
  `<project>`는 실제 배포 시 할당되는 프로젝트 주소를 뜻하며, 지금 만들어 놓은 주소가 아닙니다. Vite 개발 서버는 공개하지 않습니다.
- **Vercel `/api/*` → HTTPS → CloudFront**: external rewrites가 API 요청을
  `https://<distribution>.cloudfront.net/api/*`로 중계합니다. 브라우저 주소는 바뀌지 않습니다.
  `/api` 접두사를 유지하고 Vercel과 CloudFront **양쪽에서 API 캐시를 비활성화**합니다.
  CloudFront 기본 주소와 기본 인증서를 사용하므로 별도 API 도메인을 구매하지 않습니다.
- **CloudFront → VPC origin → Nginx → Core**: CloudFront에서 외부 HTTPS의 TLS를 종료하고,
  프라이빗 서브넷 EC2의 Nginx로 비공개 HTTP `:80` 연결합니다. 인터넷에 평문 HTTP origin을 공개하지 않는 안입니다.
  Nginx는 `/api/*` 프록시만 담당하며 React 정적 파일을 제공하지 않습니다.
  내부 구간까지 TLS라는 의미는 아니며, Vercel Functions에서 AI를 실행하는 구조도 아닙니다.
- **Core → Elasticsearch**: 현재 Nori·BM25 키워드 검색 엔진을 유지합니다. AWS OpenSearch로 바꾸는 제안이 아닙니다.
- **Core → FastAPI → Qdrant**: 의미 검색 경로를 유지합니다. Core가 키워드·의미 후보를 RRF로 결합합니다.
- **FastAPI → OpenAI**: 임베딩·LLM 호출은 기존 외부 API 경로입니다.
- **외부 API 요청의 네트워크 경로**: 비공개 EC2의 인터넷 요청은 퍼블릭 서브넷의 NAT Gateway(EIP)와
  VPC Internet Gateway를 경유합니다. 그림의 공고/OpenAI 화살표는 이 경로를 사용하는 논리적 호출 관계입니다.
  CloudFront에서 들어오는 VPC origin 요청이 NAT를 통과하는 구조는 아닙니다.
- **Core → RDS MySQL**: 공고·계정·대화 등의 원본 DB를 EC2 컨테이너에서 분리하는 제안입니다.
  RDS는 비공개 DB 서브넷 그룹에 두고 EC2 애플리케이션의 DB 접근만 보안 그룹으로 허용합니다.
- **Core → Redis / RabbitMQ**: Redis 로그인 복원과 리포트·중복 검토별 작업 큐를 유지합니다.
  큐 소비자는 별도 Worker 서버가 아니라 Core 내부에 있습니다.
- **EBS 영속 볼륨**: EC2에서 실행하는 Elasticsearch·Qdrant·Redis·RabbitMQ의 컨테이너 데이터를 보관합니다.
  볼륨이 있다는 것만으로 백업이나 복구가 완료되는 것은 아닙니다.

Elasticsearch·Qdrant·Redis·RabbitMQ는 이 안에서 직접 운영하는 컨테이너입니다.
ElastiCache·Amazon MQ·OpenSearch 등 관리형 서비스로 전환한 것으로 표시하지 않습니다.

## 배포 흐름 — 설정 준비, 클라우드 실행 전

### 프론트엔드

1. GitHub 저장소와 Vercel 프로젝트를 연결하고 작업 루트를 `frontend/web`로 지정합니다.
2. Vercel에서 React·Vite 빌드와 정적 파일 배포를 수행합니다. 프론트엔드 이미지를 ECR/EC2로 배포하지 않습니다.
3. 고정된 운영 `*.vercel.app` 주소를 정하고 `VITE_CORE_API_BASE_URL="/"`로 같은 origin의 `/api`를 사용하도록 구성합니다.
   현재 URL 조합 코드가 마지막 `/`를 제거하므로 각 API의 `/api/...` 경로가 그대로 유지되는 것을 배포 테스트로 확인합니다.
4. 서버 전용 routing middleware의 external rewrite로 `/api/:path*` → `https://<distribution>.cloudfront.net/api/:path*`를 중계합니다.
   SPA 화면 라우팅이 API 경로를 가로채지 않게 하고, 외부 rewrite 캐시를 명시적으로 끕니다.
5. 운영 배포 브랜치, 미리보기 환경, CI 검증 후 운영 반영 정책을 별도로 구성·검증합니다.

그림은 **GitHub → Vercel** Git 연동 배포 경로입니다. Vercel이 기존 GitHub Actions 전체 CI의 완료를
자동으로 기다리도록 설정했다는 의미가 아닙니다. 운영 브랜치 보호·필수 검사·배포 승인은 구현 전입니다.
OpenAI 키·DB 비밀번호 같은 비밀정보를 `VITE_*` 환경변수나 브라우저 번들에 넣지 않습니다.

### 백엔드

1. 기존 GitHub Actions의 프론트·Core·AI 테스트·빌드·통합 검증을 통과합니다.
2. 백엔드 배포용 이미지를 만들고 GitHub OIDC 임시 자격 증명을 사용해 ECR에 저장합니다.
3. 승인된 배포 단계에서 Systems Manager Run Command로 EC2 배포 스크립트를 실행합니다.
4. EC2가 인스턴스 역할로 ECR에 인증하고 고정한 이미지 버전을 가져와 Compose 서비스를 갱신합니다.
5. 상태를 확인하고 실패 시 이전 이미지 버전으로 되돌리는 절차를 구현합니다.

ECR은 이미지 저장소이며 자동 배포를 실행하지 않습니다. 그림에서 **이미지 pull**과 **배포 명령**을 구분합니다.
주황 점선은 추가할 프론트/백엔드 배포 경로입니다. 실선은 예정 배포 환경의 런타임 통신 관계이며 구축 완료 표시가 아닙니다.
Vercel 연결과 CI 이후의 이미지 게시·SSM 명령·승인·상태 확인·롤백은 이번 이미지 제작으로 구현하지 않았습니다.
이미지 롤백과 DB migration 복구는 별개이므로 스키마 변경의 호환성·백업도 별도로 준비해야 합니다.

## 보안·운영 전제와 생략 사항

- 단일 EC2 초기안입니다. EC2 장애의 영향을 서비스가 함께 받으며 고가용성·무중단 배포를 보장하지 않습니다.
- EC2는 공인 IP 없는 프라이빗 서브넷에 둡니다. CloudFront VPC origin과 관리형 ENI를 위한 IPv4 여유 주소,
  VPC에 연결된 IGW, CloudFront 서비스 관리 보안 그룹만 Nginx에 접근하도록 하는 설정이 필요합니다.
  IGW는 VPC origin의 선행 조건이지만 CloudFront 인바운드 트래픽이 IGW를 통과하는 것은 아닙니다.
- OpenAI·공고 API·ECR·SSM 등의 외부 연결을 위해 퍼블릭 NAT Gateway, EIP, IGW 및 라우팅을 별도로 구성합니다.
  도메인을 구매하지 않는다는 뜻이지 무료 배포라는 뜻이 아닙니다. **CloudFront·NAT Gateway 등 추가 구성과 운영 비용**이 있습니다.
  비용 최적화를 위한 다른 네트워크 구성은 이 그림에서 확정하지 않습니다.
- AI·검색 엔진·큐는 컨테이너 내부 통신으로 제한하고, RDS는 인터넷에 공개하지 않습니다.
- 브라우저는 CloudFront나 EC2 주소를 API base URL로 사용하지 않습니다. 같은 Vercel origin을 사용하므로
  현재 `SameSite=Lax`·host-only 쿠키를 불필요하게 `SameSite=None`으로 완화하지 않습니다.
  운영 쿠키의 `Secure`·`HttpOnly`, 요청 Cookie·Origin·쿼리·메서드 및 응답 Set-Cookie 전달을 모든 프록시에서 검증해야 합니다.
  기존 Origin 검증의 허용 목록에는 정확한 운영 Vercel origin을 등록하며 검증을 끄지 않습니다.
- OAuth 콜백과 로그인 후 복귀 주소는 고정된 운영 Vercel 주소로 맞춥니다. 프록시 경유 로그인·로그아웃·대화 저장/삭제,
  리다이렉트와 쿠키 유지가 실제로 동작하는지 확인합니다. 임의의 Vercel 미리보기 주소가 인증을 공유한다고 가정하지 않습니다.
- Vercel 외부 rewrite 캐시 비활성화와 CloudFront `CachingDisabled` 정책을 설정합니다.
  개인별 로그인·대화 결과가 CDN 캐시로 다른 사용자에게 재사용되면 안 됩니다.
  필요한 쿠키·헤더·쿼리 전달, 허용 HTTP 메서드와 원본 Host 처리는 별도로 구성합니다.
  장시간 AI 응답이 Vercel·CloudFront·Nginx 제한에 걸리지 않는지도 검증해야 합니다. CDN 추가가 AI 생성 자체를 빠르게 하지는 않습니다.
- SSM을 위한 Agent·IAM 역할·통신 경로, ECR 접근 권한과 GitHub OIDC 신뢰 정책을 별도로 구성해야 합니다.
  OIDC와 인스턴스 역할은 권한을 자동으로 부여하지 않습니다. 최소 권한·배포 브랜치/환경 제한이 필요합니다.
- 운영용 Nginx 이미지·비밀정보 주입·개발 로그인 비활성화·쿠키/OAuth/프록시 설정이 필요합니다.
  Nginx의 80 포트는 비공개 origin 통신용이며 인증서 발급을 위한 인터넷 공개 포트가 아닙니다.
- RDS 백업 보관 기간·복구 시험, EBS/검색 엔진/큐의 일관된 백업·복구, 로그·알림·비용 알림을 별도로 준비해야 합니다.
  RDS DB 서브넷 그룹의 여러 AZ 구성 세부와 RDS 고가용성 옵션은 이 개념도에 표현하지 않았습니다.
- ALB·S3·ECS는 초기안에 포함하지 않습니다. CloudFront는 프론트 정적 파일 저장소가 아니라 AWS API의 HTTPS 진입점입니다.
- OAuth·SMTP·Bizno 등 보조 외부 연동은 가독성을 위해 생략합니다. API 포트 공개만으로 해당 설정이 완성되지는 않습니다.
- 인스턴스 크기·비용·처리량은 부하 측정과 예산 결정 전이므로 확정하지 않았습니다.

## 실제 아이콘 출처

아이콘은 재생성하거나 모양·색상을 변경하지 않고 원본 비율을 유지했습니다.

- AWS Cloud·EC2·ECR·RDS·VPC·EBS·Systems Manager·CloudFront·NAT Gateway·Internet Gateway 10개:
  [AWS 공식 아키텍처 아이콘](https://aws.amazon.com/architecture/icons/)의 2026-07-31 패키지.
  `aws-logo-sources.json`에 ZIP URL과 내부 파일 경로를 기록했습니다.
  AWS 자산은 [Devicon 라이선스](DEVICON-LICENSE)의 적용 대상이 아닙니다. AWS 공식 사용 조건을 따릅니다.
- Nginx: [Devicon v2.17.0 원본](https://cdn.jsdelivr.net/gh/devicons/devicon@v2.17.0/icons/nginx/nginx-original.svg),
  [동봉 MIT 라이선스](DEVICON-LICENSE).
- Vercel: [Devicon v2.17.0 원본](https://cdn.jsdelivr.net/gh/devicons/devicon@v2.17.0/icons/vercel/vercel-original.svg),
  [동봉 MIT 라이선스](DEVICON-LICENSE). 삼각형 마크를 직접 그리지 않고 원본 파일을 사용했습니다.
- 나머지 로고는 [기존 이미지의 출처](README.md#로고-출처)와 `logo-sources.json`의 파일을 그대로 재사용합니다.

로고·브랜드의 권리는 각 소유자에게 있습니다. 기술을 식별하기 위한 사용이며 후원·제휴를 의미하지 않습니다.
SVG에는 아이콘이 내장되어 있어 표시 시 외부 네트워크가 필요하지 않습니다.

## 재생성 및 검증

저장소 루트에서 실행합니다. 기존 로컬 구성 이미지·출처 목록은 덮어쓰지 않습니다.

```bash
node docs/assets/architecture/build-aws.mjs

GOVBIZ_DIAGRAM_NODE_MODULES=/path/to/tooling/node_modules \
GOVBIZ_DIAGRAM_CHROME=/path/to/chrome \
node docs/assets/architecture/build-aws.mjs --render
```

PNG 렌더링은 별도 도구 환경의 Playwright와 Chrome을 사용하며 production 의존성은 추가하지 않습니다.
생성 스크립트는 AWS API나 AI API를 호출하지 않고, 렌더링 중 네트워크 요청도 차단합니다.
추가 아이콘을 다시 받아야 한다면 출처 목록의 공식 ZIP에서 기재된 파일만 추출합니다.
다운로드된 ZIP 전체를 저장소에 넣지 않습니다.

이미지 제작 검증:

- 생성 스크립트 문법 및 `git diff --check`.
- 원본 로고 해시, SVG 안전성, 35개 로고 로딩 및 실제 배치 여부.
- 글자 최대 폭·이동된 그룹을 포함한 실제 캔버스 경계, PNG 크기, 연결선·한국어 글자의 육안 확인.
- README 로컬 링크와 기존 로컬 구성도 보존 여부.

문서·그림만 변경하므로 애플리케이션 전체 테스트, 유료 AI 평가, Vercel/AWS 인프라 생성·배포는 실행하지 않습니다.

## 설계 참고

- [Vercel의 Git 연동 배포](https://vercel.com/docs/git)
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Vercel external rewrites와 캐시 비활성화](https://vercel.com/docs/routing/rewrites)
- [CloudFront 기본 주소·인증서](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html)
- [CloudFront VPC origins의 구성·보안 조건](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
- [VPC NAT Gateway의 인터넷 연결](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
- [AWS RDS의 공개·비공개 접근](https://docs.aws.amazon.com/AmazonRDS/latest/gettingstartedguide/security-public-private.html)
- [GitHub Actions를 통한 ECR 이미지 게시](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/build-and-push-docker-images-to-amazon-ecr-using-github-actions-and-terraform.html)
- [Systems Manager Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html)
- [ECR 이미지 가져오기](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-pull-ecr-image.html)
- [RDS 자동 백업](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html)
