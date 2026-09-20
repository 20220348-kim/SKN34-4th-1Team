# GovBiz 기술 README

[메인 README](../README.md) · [3차 프로젝트 소개](third-project/README.md) · [전체 문서 목록](README.md)

정부지원사업 검색부터 신청 준비와 기업 간 협업까지 돕는 AI 웹 서비스입니다.
기업마당·K-Startup 등 공식 공고를 기반으로 지원사업 추천, 원문 근거 확인, 신청 정보 정리와 협업 모집·제안을 지원합니다.

## 주요 기능

- AI 대화 검색: 기업 조건과 지원 목적을 대화로 반영하고, 추천 공고·관련도 점수·추천 이유 표시
- 필터 검색: 키워드·지역·분야·제공처·접수 상태와 K-Startup 전용 조건으로 공고 조회
- 공고 상세·원문 질문: 신청 기간·접수 상태 확인, 기업마당 공식 원문 기반 답변과 근거 인용
- 신청 문서 준비: 네 제공처의 공식 첨부를 백그라운드 분석하고 작업 상태·결과를 다시 확인, AI와 정리한 입력을 사용자가 확인해 저장하고 지원 형식의 문서를 생성·다운로드
- 중복 지원·수혜 검토: 선택한 공고의 공식 첨부와 참여 정보를 근거로 백그라운드 분석, 진행 상태·결과·근거 이력 확인
- 기업 맞춤 리포트: 저장된 기업 정보 기반 지원사업 추천, 웹 미리보기와 정기 이메일 수신 설정
- 파트너 관리: 공고별 협업 모집글 작성·수정·마감, 참여 제안과 수락·거절·철회
- 관심 공고·대화 기록: 로그인 계정별 저장·다시 보기·삭제, 관심 공고 일정 달력과 신청 준비·중복 검토 연동, 비회원 검색 결과의 로그인 후 복원
- 계정·기업 프로필: 이메일 회원가입·카카오/Google 로그인, 비밀번호 관리, 사업자 조회·기업 등록과 협업 정보 관리
- 관리자 회원·기업 관리: 계정 검색·상세 조회, 정지·정지 해제와 강제 로그아웃

소셜 로그인·정기 메일은 별도 연동 설정이 필요합니다. 신청 문서 생성은 지원하는 HWP·HWPX·PDF 구조에 한해 제공하며,
HWP 편집에는 별도 Windows 브리지 연동이 필요합니다. [문서 생성 범위와 제약](application-document-mcp-architecture.md)을 확인하세요.

검색 관련도와 신청 자격 확인은 구분해 표시합니다. 최근 개선과 검증 범위는
[검색 품질 개선 기록](search-relevance-v5-fix.md)을 참고하세요.

기술 구성: React · TypeScript · Kotlin · Spring Boot · MyBatis · FastAPI · LangChain · OpenAI · MySQL · Elasticsearch/Nori · Qdrant · Redis · RabbitMQ

## 빠른 시작

처음 설치하는 개발 환경의 실행 방법입니다. Docker·Docker Compose와 공공데이터포털·OpenAI API 키가 필요합니다.
저장소 루트에서 실행하며, 기존 `.env`가 있으면 유지합니다.

```bash
test -f .env || cp .env.example .env
# .env에 DATA_GO_KR_SERVICE_KEY와 OPENAI_API_KEY 입력
docker compose --env-file .env --file infrastructure/compose.yaml up --build
```

[http://127.0.0.1:5173](http://127.0.0.1:5173)에서 접속합니다.
첫 실행은 공고 수집·색인 완료까지 기다려야 하며, 임베딩·AI 답변에는 OpenAI 사용 비용이 발생합니다.
이 구성은 로컬 개발용입니다. 환경변수·중지·키 없는 통합 검증은 [실행 안내](../infrastructure/README.md)를 참고하세요.

Vercel + AWS 구성은 [배포 구성도](assets/architecture/README-aws-deployed.md)와
[CodeBuild 배포 절차](deployment-codebuild.md)를 참고하세요. 최초 환경 준비는
[운영 배포 준비 안내](deployment-aws-vercel.md)에서 확인하며, 개발용과 운영용 Compose를 분리합니다.

기존 환경은 [백엔드 갱신 절차](../infrastructure/README.md#백엔드-변경-반영과-화면api-버전-불일치)에 따라
설정·대기 작업을 확인한 뒤 업데이트하세요. 큐를 켜면 기존 예약 작업이 실행될 수 있으며, 갱신 후에는 검색 준비 상태도 확인해야 합니다.

## 상세 문서

| 문서 | 내용 |
|---|---|
| [아키텍처 README](architecture/README.md) | 서비스 구성, 계층·DI·MVVM·Flux·Facade·Agent 설계 |
| [호출·데이터 흐름](architecture.md) | 검색·동기화·RAG·장애 처리의 실행 순서 |
| [기술 구성](technology.md) | 기술 스택·버전과 MySQL·Elasticsearch·Qdrant·Redis·RabbitMQ의 역할 |
| [Elasticsearch 적용 상세](elasticsearch-lexical-search.md) | 한국어 키워드 검색·벡터 검색 결합, 색인·운영 설정 |
| [Redis 적용 상세](redis-search-result-restoration.md) | 로그인 후 검색 결과 복원과 저장·장애 처리 |
| [RabbitMQ 정기 리포트](rabbitmq-daily-report-generation.md) · [메일 발송](rabbitmq-daily-report-delivery.md) | 생성·발송 큐 분리와 중복 방지·장애 대응 |
| [RabbitMQ 중복 검토 분석](rabbitmq-combination-review.md) | 분석 작업 큐, 진행 상태·이력 복원·운영 설정 |
| [RabbitMQ 공식 문서 분석](rabbitmq-application-form-discovery.md) | 문항 추출 작업·결과 복원·관리자 큐 운영 조회 |
| [RabbitMQ 카카오 연결 해제](rabbitmq-account-oauth-unlink.md) | 탈퇴 작업 보관·재가입 충돌 방지·운영 확인 |
| [구현 현황](implementation-status.md) | 완료 단계·검증 결과·현재 한계·다음 작업 |
| [검색 평가 결과](../evaluation/support-program-search/runs/support-program-catalog-20260906-v1/README.md) | 고정 실데이터·AI-only 판정·전후 비교·재현 방법 |
| [실행·검증](../infrastructure/README.md) | Compose·환경변수·통합 검증 |
| [전체 문서 목록](README.md) | API 계약·요청 제한·서비스별 개발·확장 안내 |

서비스별 개발: [Frontend](../frontend/web/README.md) · [Core API](../backend/core-service/README.md) · [AI Service](../backend/ai-service/README.md)

추천과 AI-only 평가 결과는 실제 신청 자격이나 전체 검색 정확도를 보장하지 않습니다.
현재 지원 범위와 배포 제약은 [구현 현황](implementation-status.md)에서 확인하세요.
