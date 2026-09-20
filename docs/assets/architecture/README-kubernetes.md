# GovBiz Kubernetes · GitOps 아키텍처 — 통합 전 검증 기록

이 그림은 교육기관 단일 저장소 통합 **이전**의 GovBiz-Team 두 저장소·Mac 실행 결과를 보존한다.
현재 소스 위치·브랜치·개인 포크의 연결 상태는 [통합 안내](../../repository-integration.md)를 따른다.
그림에 표시된 자동 발행·동기화가 교육기관 저장소에서도 실행된다는 뜻은 아니다.

2026-09-20에 확인한 **Mac 유지형 portfolio 환경**을 표현한다. 기존
[AWS 배포 구성도](README-aws-deployed.md)의 로고·색상·영역 구분을 참고했지만 현재 토폴로지로 새로 그렸다.
AWS/Vercel 과거 파일은 수정하거나 삭제하지 않는다. 이 문서·그림 생성은 배포나 환경값 변경을 실행하지 않는다.

![GovBiz 현재 로컬 Kubernetes 구성](govbiz-kubernetes-architecture.png)

## 파일

- [PNG](govbiz-kubernetes-architecture.png): 5,640 × 4,000, 발표·GitHub 첨부용.
- [SVG](govbiz-kubernetes-architecture.svg): 2,820 × 2,000, 로고를 포함한 수정 가능한 벡터 원본.
- [생성 스크립트](build-kubernetes.mjs): 저장소의 로고만 읽어 SVG·PNG를 생성한다.
- [로고 출처·SHA-256](kubernetes-logo-sources.json): 사용한 17개 로고의 출처와 해시.

## 현재 요청·데이터 경로

1. Mac 브라우저 → `localhost:5173`의 React/Vite → `/api` 프록시 → `127.0.0.1:18080`
   port-forward → Kubernetes `core-service:8080`이다. 웹은 클러스터 밖의 Mac 프로세스이며
   Vercel이나 Kubernetes의 추가 Deployment가 아니다.
2. `govbiz-portfolio` kind 단일 노드에서 Core·Catalog·AI·Ops를 각각 독립 Deployment와 ClusterIP
   Service로 실행한다. 서비스 이름으로 통신하며 Eureka를 쓰지 않는다.
3. Core는 회원·기업·파트너·공고 조회를 담당하고, Catalog는 공고 원본·수집·색인을 소유한다.
   **Core → Catalog 내부 HTTP snapshot 조회 → 검증 → Core DB 조회용 복제** 경로다.
   그림의 양방향 선은 HTTP 요청·응답을 뜻하며 양방향 DB 동기화나 공유 DB를 뜻하지 않는다.
4. Core·Catalog·Ops는 독립 MySQL 8.4 사용자와 PVC를 사용한다. Ops에는 전용 DB와 health가
   있지만 관리자 인증·LLMOps 업무가 완성됐다는 뜻은 아니다.
5. Redis는 Core의 검색 결과·조건 복원, Elasticsearch는 Core 조회·Catalog 색인,
   Qdrant는 AI 벡터 저장을 위한 의존성이다. 현재 무료 데모에서는 외부 수집·색인·유료 AI가 꺼져 있다.
   Core→AI·Catalog→AI·AI→Qdrant는 설정된 경로로 표시하며 실제 유료 기능 검증과 구분한다.

공고 8건, 일반 회원 2개, 기업·모집글 각 2개는 가상 시연 데이터다.
[데모 데이터·계정 준비](../../portfolio-demo.md)와 [웹 실행](../../../frontend/web/README.md)을 따른다.
실제 공고 API·OpenAI·SMTP·OAuth·RabbitMQ 큐는 이번 시연에서 활성화하지 않았다.

## 이미지·GitOps 제어 경로

- `GovBiz-Team/GovBiz`의 `develop` 동일 SHA에서 세 CI 통과 → 네 서비스 이미지 빌드/재사용 → 비공개 GHCR.
- `GovBiz-infra`의 promotion workflow가 CI·release artifact를 검증하고 변경된 이미지 digest를
  `environments/portfolio`에 커밋한다. GHCR이 Git에 코드를 푸시하거나 Argo CD가 이미지를 빌드하지 않는다.
- Argo CD Core가 infra Git의 Helm chart·values를 읽어 네 Application을 자동 동기화한다.
  self-heal은 켜고 자동 prune는 끈 상태다. 데이터·Secret·클러스터 전체를 Argo가 관리하는 그림이 아니다.
- 이미지 다운로드는 **kubelet**이 `ghcr-pull` imagePullSecret의 읽기 전용 인증으로 수행한다.
  소스·Helm·digest는 Git, 이미지 본체는 GHCR, 비밀값은 Kubernetes Secret에 분리한다.

## 표시와 확인 범위

- 실선: 확인한 주요 요청·데이터 경로.
- 주황 점선: 이미지 게시/다운로드·GitOps 설정 반영. **모든 구간의 무인 실행을 보증하는 표시가 아니다.**
- 회색 점선: 코드·설정에 있는 연결이나 현재 데모에서 사용하지 않는 기능.
- `Synced / Healthy`는 확인 시점의 상태이지 모니터링 대시보드나 전체 업무 기능 완료 판정이 아니다.
- promotion은 **수동 시작 이후 검증·digest 커밋·Argo 자동 반영**을 확인했다. 10분 schedule은
  설정됐지만 실제 schedule 이벤트를 관측하지 못했으므로 별도 경고로 표시했다.
- 클라우드 상시 운영·고가용성·무중단·NetworkPolicy 집행·백업 복원·부하·실제 AI 품질 검증을
  완료했다고 주장하지 않는다. 기존 Compose 컨테이너는 중지하고 데이터·볼륨은 보존했다.
- 모바일 소스는 모노레포에 있지만 이 Mac 웹 시연 경로에서 앱을 실행하지 않는다.
- 현재 그림에는 과거 AWS의 EC2·RDS·ECR·SSM·CloudFront·NAT와 Vercel을 실행 노드로 넣지 않는다.

근거는 [portfolio 설정](https://github.com/GovBiz-Team/GovBiz-infra/tree/develop/environments/portfolio),
[Argo 설정](https://github.com/GovBiz-Team/GovBiz-infra/tree/develop/argocd/portfolio),
[실행 검증 기록](https://github.com/GovBiz-Team/GovBiz-infra/blob/develop/docs/portfolio-validation-20260920.md),
[이미지 릴리스](../../msa-image-release.md)다. 서비스 코드를 새로 분리하거나 인프라를 변경한 작업이 아니다.

## 재생성·검증

저장소 루트에서 실행한다. 기존 PNG·SVG 생성 스크립트는 바꾸지 않는다.

```bash
node docs/assets/architecture/build-kubernetes.mjs

GOVBIZ_DIAGRAM_NODE_MODULES=/path/to/tooling/node_modules \
GOVBIZ_DIAGRAM_CHROME=/path/to/chrome \
node docs/assets/architecture/build-kubernetes.mjs --render
```

렌더링은 기존 그림과 같은 Playwright/Chrome을 사용하며, 외부 네트워크를 차단한 상태에서
로고 로딩·글자 폭·캔버스 경계를 검사한다. 앱 의존성·잠금 파일에 새 패키지를 추가하지 않는다.
최종 PNG에서 한글·연결선·텍스트 겹침을 육안 확인한다.

로고는 기존 파일을 재사용하며 Kubernetes·Argo CD·Helm·Django만
[Devicon v2.17.0](https://github.com/devicons/devicon/tree/v2.17.0/icons) 원본을 추가했다.
[동봉 MIT 라이선스](DEVICON-LICENSE)와 [기존 로고 출처](README.md#로고-출처)를 참고한다.
로고의 비율·색·경로는 바꾸지 않았고, 기관이나 제품의 공식 승인·보증을 뜻하지 않는다.
