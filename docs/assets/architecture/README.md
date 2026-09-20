# GovBiz 아키텍처 이미지

주요 서비스 연결을 기술 로고와 함께 정리한 문서용 이미지입니다.
**로컬 구성 기록(2026-09-12)**, **초기 배포 예정안(2026-09-13)**,
**Vercel + AWS 배포 구성(2026-09-16 정리)**, **현재 Mac Kubernetes 구성(2026-09-20)**을 별도 파일로 관리합니다.
이미지 제작은 앱 실행 코드나 배포 설정을 변경하지 않습니다.

## 현재 Mac Kubernetes · 비공개 GHCR · Argo CD

![GovBiz 현재 로컬 Kubernetes 구성](govbiz-kubernetes-architecture.png)

- [현재 구성 PNG](govbiz-kubernetes-architecture.png) · [SVG 원본](govbiz-kubernetes-architecture.svg)
- [요청·배포 경로와 검증 범위](README-kubernetes.md)
- [생성 스크립트](build-kubernetes.mjs) · [로고 출처·해시](kubernetes-logo-sources.json)

Mac의 Vite 웹 → port-forward → Core, 독립 Catalog·AI·Ops와 DB,
비공개 GHCR·infra digest 갱신·Argo CD 자동 반영을 표시합니다.
10분 schedule 실제 발동 미확인과 유료 AI·수집 비활성을 구분하며 클라우드 운영 완료로 표현하지 않습니다.

## Vercel + AWS 배포 구성 — 과거 기록

- [배포 구성 PNG](govbiz-aws-architecture-deployed.png): 5,640 × 3,800.
- [배포 구성 SVG](govbiz-aws-architecture-deployed.svg): 수정 가능한 벡터 원본.
- [배포 경로·근거·확인 범위·재생성 방법](README-aws-deployed.md).

`govbiz.vercel.app → Vercel 서버 미들웨어 → CloudFront VPC origin → 비공개 EC2`와 RDS를 표시합니다.
백엔드 자동 배포 설정은 GitHub Actions/OIDC 예정 경로가 아니라 **CodeBuild → ECR → SSM → EC2**입니다.
기존 배포 확인 기록과 저장소 설정 기준이며, 작성 시 만료된 AWS 세션으로 실시간 상태는 재조회하지 못했습니다.

## Vercel + AWS 초기 배포 예정안

- [Vercel + AWS PNG](govbiz-aws-architecture.png): 5,640 × 3,800.
- [Vercel + AWS SVG](govbiz-aws-architecture.svg): 수정 가능한 2,820 × 1,900 벡터 원본.
- [설계 범위·주의사항·재생성 방법](README-aws.md).
- [AWS 이미지 생성 스크립트](build-aws.mjs) · [사용 로고 출처·해시](aws-logo-sources.json).

별도 도메인을 구매하지 않고 Vercel 기본 주소로 화면과 `/api`를 함께 사용하는 제안입니다.
Vercel external rewrites → CloudFront 기본 HTTPS 주소 → VPC origin → 비공개 EC2 Nginx로 API를 전달합니다.
외부 API 호출용 NAT·IGW와 비공개 RDS MySQL·ECR 이미지 저장·SSM 배포 경로도 표시합니다.
CloudFront·NAT 등 운영 비용이 발생하는 배포 예정안이며 실제 설정을 적용한 것은 아닙니다.
기존 로컬 구성 이미지와 생성 스크립트는 보존합니다.

## 로컬 구성 기록

![GovBiz 시스템 아키텍처](govbiz-architecture.png)

## 제공 파일

- [PNG](govbiz-architecture.png): 4,200 × 3,040. 발표 자료와 GitHub 문서에 바로 사용할 수 있습니다.
- [SVG](govbiz-architecture.svg): 2,100 × 1,520의 벡터 원본. 확대해도 선명하며 텍스트·배치 수정이 가능합니다.
- [생성 스크립트](build.mjs): 로고와 배치를 조합하고 PNG를 렌더링합니다.
- [로고 출처·SHA-256 목록](logo-sources.json): 다운로드한 로고 파일의 출처와 무결성 정보입니다.

SVG 안에 로고를 데이터 URI로 포함했으므로 외부 로고 서버 연결 없이 볼 수 있습니다.
한글 폰트는 Arial, Apple SD Gothic Neo, Noto Sans KR, Malgun Gothic 순으로 대체합니다.
다른 OS에서 SVG의 글자 폭이 달라질 수 있어 발표에는 확인 완료된 PNG를 권장합니다.

## 로컬 구성 이미지의 기준과 한계

- [Compose](../../../infrastructure/compose.yaml): React/Vite, Core, AI Service, MySQL, Elasticsearch, Redis, Qdrant, RabbitMQ 구성.
- [CI](../../../.github/workflows/ci.yml): Git push·PR → GitHub Actions의 테스트·빌드·컨테이너 통합 검증.
- Docker 개발 환경의 실행·갱신은 수동입니다. CI에서 운영 환경으로 자동 배포하는 화살표는 넣지 않았습니다.
- Redis는 비회원 검색 결과·조건의 30분 보관과 로그인 후 복원에 사용합니다. AI 검색 캐시나 회원 세션 DB로 표시하지 않았습니다.
- Elasticsearch는 **Core에서 직접 호출**하는 Nori·BM25 키워드 검색 색인입니다.
  Qdrant는 **Core → FastAPI → Qdrant** 경로의 의미 검색과 근거 벡터 검색을 담당합니다.
  Core가 키워드·의미 검색 후보를 RRF로 결합한 뒤 기존 AI 랭킹으로 전달합니다.
  MySQL은 원본이며 두 검색 엔진은 재생성 가능한 파생 색인입니다.
  [Elasticsearch 적용 상세](../../elasticsearch-lexical-search.md)의 실제 구현을 기준으로 표시했습니다.
  그림의 `:9200`은 컨테이너 내부 포트이며 Compose에서 호스트에 공개하지 않습니다.
- RabbitMQ와 Core 내부 리포트 소비자는 현재 저장소에 포함되어 있어 기존 미커밋 표시를 제거했습니다.
  별도 Worker 서버가 아니라 Core 내부 소비자임을 표시합니다.
- 그림은 코드·설정의 구조를 설명하며 현재 실행·배포 상태를 보증하지 않습니다.
  이번 이미지 갱신으로 컨테이너를 실행하거나 색인 복구·DB migration·리포트 작업을 시작하지 않았습니다.
- 공고 제공처는 설정에 따라 활성화됩니다. OAuth·SMTP·Bizno 등 보조 외부 연동은 주요 흐름의 가독성을 위해 생략했습니다.
- AWS·Netlify·Cloudflare·MongoDB는 현재 구성으로 확인되지 않아 넣지 않았습니다.
- 화살표는 서비스 간 요청·응답/데이터 교환 관계이며, 각각이 별도 배포 서버라는 의미는 아닙니다.
- 브라우저 로고는 클라이언트 사용 예시입니다. 세 브라우저의 호환성 테스트 완료를 의미하지 않습니다.

## 로고 출처

로고를 AI로 다시 그리지 않고 배포된 원본 파일을 비율을 유지해 배치했습니다.
로고 자체의 색·경로·형태는 변경하지 않았습니다.

- Git, GitHub, GitHub Actions, Docker, React, TypeScript, Vite, Kotlin, FastAPI, Python,
  MySQL, Elasticsearch, Redis, RabbitMQ, Chrome, Firefox, Safari, pnpm, Gradle, pytest:
  [Devicon v2.17.0](https://github.com/devicons/devicon/tree/v2.17.0).
  [동봉 MIT 라이선스](DEVICON-LICENSE).
- Spring Boot: [Spring 공식 프로젝트 아이콘](https://spring.io/img/projects/spring-boot.svg).
- Qdrant: [공식 브랜드 리소스](https://qdrant.tech/brand-resources/)의 컬러 브랜드마크.
- MyBatis: [공식 로고](https://mybatis.org/images/mybatis-logo.png).
- OpenAI: [Simple Icons 14.15.0](https://www.npmjs.com/package/simple-icons/v/14.15.0)의 OpenAI 로고.
  [동봉 라이선스](SIMPLE-ICONS-LICENSE), [OpenAI 브랜드 안내](https://openai.com/brand/).

로고·브랜드의 권리는 각 소유자에게 있습니다. 프로젝트의 사용 기술을 식별하기 위한 것이며 후원·제휴를 뜻하지 않습니다.
공개 발표·배포 시 각 브랜드의 사용 조건도 확인해야 합니다. 세부 다운로드 URL은 `logo-sources.json`에 있습니다.

## 수정·재생성

저장소 루트에서 실행합니다. 기본 명령은 로컬 아이콘만 읽고 SVG와 출처 목록을 생성합니다.

```bash
node docs/assets/architecture/build.mjs
```

아이콘을 다시 받으려는 경우에만 `--download-icons`를 사용합니다. 공개 로고 URL 외의 서비스나 유료 AI API를 호출하지 않습니다.
이 옵션은 `icons/`의 동일 이름 로고와 라이선스 파일을 다시 받으므로 변경한 로고가 있으면 먼저 보존하세요.

PNG 렌더링에는 별도 도구 환경의 Playwright와 Chrome/Chromium이 필요합니다. 프로젝트의 production 의존성에는 추가하지 않았습니다.

```bash
# 기존 도구 환경의 node_modules와 실제 Chrome 실행 파일 경로를 지정합니다.
GOVBIZ_DIAGRAM_NODE_MODULES=/path/to/tooling/node_modules \
GOVBIZ_DIAGRAM_CHROME=/path/to/chrome \
node docs/assets/architecture/build.mjs --render
```

Playwright가 기본 경로에서 해석되거나 Chromium이 설치되어 있다면 해당 환경변수는 생략할 수 있습니다.
렌더러는 네트워크 요청을 차단하고 내장된 로고만 로드합니다. 모든 로고의 로딩과 글자의 최대 폭·캔버스 경계를 검사합니다.
생성 후 PNG를 열어 연결선·레이블·한국어 글자와 상태 표시를 육안으로 확인하세요.

이번 제작에서는 24개 로고 로딩, 텍스트 경계, 4,200 × 3,040 PNG 렌더링과 육안 확인을 완료했습니다.
문서용 자산만 추가했으므로 애플리케이션 전체 테스트나 유료 API 평가는 실행하지 않았습니다.
