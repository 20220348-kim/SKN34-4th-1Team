# 운영 Langfuse HTTPS 연결

기존 Core·Ops API와 Argo 연결은 [API 진입점 안내](../api-entrypoint.md)를 따른다.
Langfuse는 [전용 CloudFront 템플릿](../langfuse-cloudfront.yaml)의 `LangfuseOrigin` 출력 주소를
사용한다. 이 주소의 루트(`/`)에 웹을 제공하므로 Next.js 정적 파일·로그인 callback·내부 API도
같은 HTTPS 호스트에서 동작한다. GovBiz 로그인과 Langfuse 로그인은 별도이며, 기존 Langfuse
계정의 조직·프로젝트 권한으로 실행 추적을 조회한다.

```text
GovBiz 관리 화면의 AI 실행 추적 링크
  → 전용 CloudFront HTTPS 호스트 /project/<프로젝트 ID>/traces
  → 관리자 IPv4 확인 → 기존 VPC origin → 기존 내부 ALB
  → api-gateway /_langfuse/* (전용 비밀값·허용 표식·공개 호스트 확인)
  → 접두어 제거 → langfuse-web.govbiz-observability:3000
```

`/_langfuse`는 원본 연결에서만 사용하는 경로다. 사용자가 여는 주소에는 붙이지 않는다.
새 ALB·VPC origin·Pod를 만들지 않고 CloudFront 배포와 접근 제어 Function을 추가한다.
응답은 캐시하지 않으며 쿠키·Origin·쿼리·Next.js 요청 헤더를 전달한다.

## 입력과 접근 경계

| 설정 | 값과 용도 |
| --- | --- |
| `VpcOriginId`, `AlbDnsName` | 기존 API CloudFront에 연결된 동일 VPC origin과 내부 ALB |
| `LangfuseAllowedIpv4` | 접근할 관리자 공인 IPv4 한 개. CIDR을 붙이지 않으며 빈 값이면 전체 차단 |
| `LangfuseOriginSecret` | 별도 생성한 64자리 소문자 16진수. API·Argo 비밀값과 공유하지 않음 |
| `govbiz-msa/langfuse-dashboard-proxy` | 위 비밀값을 `origin-secret` 키로 보관하는 Kubernetes Secret |
| `NEXTAUTH_URL` | `langfuse-web`·`langfuse-worker` 모두 `LangfuseOrigin`의 HTTPS 루트 주소 사용 |
| `LANGFUSE_PROJECT_URL` | Ops에 `<LangfuseOrigin>/project/<기존 프로젝트 ID>` 설정. **끝에 `/traces`를 붙이지 않음** |

Ops는 프로젝트 주소에 `/traces`나 `/scores`를 붙여 링크를 만든다. CloudFront 호스트를 하드코딩하지
않고 배포된 스택의 `LangfuseOrigin` 출력을 읽는다. Helm으로 관측 서비스를 관리하는 환경에서는
`govbiz-observability` Chart의 `publicUrl`이 두 Langfuse 컨테이너의 `NEXTAUTH_URL`을 설정한다.
SDK·평가 실행기의 클러스터 내부 Langfuse 접속 주소와 기존 API 키는 그대로 유지한다.

CloudFront는 브라우저가 보낸 접근 표식·호스트를 교체하고 실제 접속 IPv4를 검사한다. Gateway는
독립 origin 비밀값까지 확인하며, Secret이 없으면 해당 경로를 `403`으로 닫는다.
Langfuse의 NetworkPolicy는 기존 수집 경로와 `govbiz-msa`의 `api-gateway` Pod만 허용한다.
Langfuse DB·Redis·MinIO·ClickHouse와 Prefect에는 외부 경로를 추가하지 않는다.

## 적용 순서

1. 대상 EKS의 기존 Gateway·VPC origin·ALB 및 Langfuse 프로젝트 ID를 확인한다.
   현재 Deployment 환경설정과 `argocd/govbiz-eks` Application을 복구용으로 보관한다.
2. 별도 origin 비밀값을 위 Secret에 등록하고 Gateway 설정·Ingress의 `/_langfuse` 경로를 적용한다.
   Gateway egress와 Langfuse ingress의 namespace·Pod selector·3000 포트를 함께 반영한다.
   기존 관측 서비스를 직접 관리하는 환경에서는 해당 NetworkPolicy만 갱신하며 저장소를 재설치하지 않는다.
3. 기존 VPC origin ID·ALB DNS·같은 비밀값으로 CloudFront 스택을 적용한다. 설정을 마치기 전에는
   `LangfuseAllowedIpv4`를 비워 외부 접근을 닫을 수 있다. 배포 완료 후 `LangfuseOrigin`을 읽는다.
   비밀값은 비공개 입력 파일로 전달하고 명령 인자·Git·로그에 기록하지 않는다.
4. Langfuse 웹과 worker의 `NEXTAUTH_URL`을 새 HTTPS 루트로 맞추고 순서대로 교체해 Ready를 확인한다.
   기존 Secret·DB·볼륨·프로젝트 ID는 유지한다.
5. Ops `LANGFUSE_PROJECT_URL`을 프로젝트 기본 주소로 바꾼다. Argo가 관리하는 운영 Ops는
   `govbiz-eks` Application의 `spec.source.kustomize.patches` 안에 있는 Ops 환경설정 패치에도
   **같은 값을 보존**한다. 다른 환경변수·Secret 참조·배치 패치를 유지하면서 해당 키만 갱신하고
   동기화한다. Deployment만 직접 바꾸면 후속 배포에서 기존 주소로 돌아갈 수 있다.
6. 관리자 IPv4를 설정하고 HTTPS 로그인·프로젝트 traces 조회·Ops의 AI 실행 추적 링크를 확인한다.
   허용하지 않은 IP와 잘못된 origin 비밀값의 요청은 차단되는지 함께 확인한다.

관리자 네트워크가 바뀌면 `LangfuseAllowedIpv4`도 갱신한다. 접근을 중단할 때는 해당 값을 비워
차단할 수 있으며, 기존 API·Argo 경로와 데이터 볼륨을 삭제할 필요가 없다.
이 문서는 적용 구성과 절차이며, 오프라인 렌더링·테스트만으로 실제 HTTPS 배포 완료를 뜻하지 않는다.
