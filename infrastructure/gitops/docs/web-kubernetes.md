# 웹 Kubernetes 배포

웹을 Vite 개발 서버 밖에서 실행하기 위한 구성이다. 런타임은 정적 번들을 제공하는 Nginx이며,
별도 웹 Chart 없이 기존 `govbiz-service` Chart의 Deployment·ClusterIP Service를 사용한다.
개발용 Compose·Vite와 기존 Vercel 배포는 유지한다.

## 실행 경로

`브라우저 → web:8080 → 정적 SPA 또는 Core/Ops 내부 Service`

- `/`, `/login`, `/ops/*` 등 화면 경로는 정적 번들을 제공한다. 깊은 경로 새로고침도 지원한다.
- `/api/v1/ops`와 그 하위 경로는 `ops-service:8000`으로 전달한다.
- 나머지 `/api/*`는 `core-service:8080`으로 전달한다. API 오류를 HTML로 바꾸지 않는다.
- Host의 포트, Origin, 쿠키, CSRF 헤더, 요청 메서드·쿼리·본문을 보존한다.
- API·HTML은 `private, no-store`, 해시 이름의 `/assets/*`만 장기 캐시한다.
- 브라우저가 보낸 프록시 IP·scheme·신뢰 헤더는 덮어쓰거나 제거한다.
- 일반 API 읽기 제한은 100초, 기존 신청 문서 생성 경로는 600초, 요청 본문 제한은 2MiB다.
- `/healthz`는 웹 프로세스 건강 확인이다. Core·Ops의 정상 여부를 대신하지 않는다.

현재 프록시는 같은 namespace의 Core·Ops Service와 직접 HTTP/loopback 접근을 대상으로 한다.
Service가 먼저 존재해야 Nginx가 기동하며, Service를 삭제·재생성해 ClusterIP가 바뀌면 웹도
재기동해야 한다. 일반 백엔드 Pod 교체는 Service를 유지하므로 웹 재기동이 필요 없다.
TLS 종료 지점의 신뢰 범위, 실제 클라이언트 IP, HTTPS 쿠키·CSRF 처리는 외부 ingress 구성에서
함께 정해야 한다. 임의의 `X-Forwarded-Proto`를 신뢰해 외부 TLS가 준비됐다고 간주하지 않는다.

## 빌드

저장소 루트에서 실행한다. Node 24.20.0과 기존 Nginx 1.30.4 이미지를 digest로 고정했고,
pnpm 11.22.0과 루트 잠금 파일을 사용한다.

```bash
docker build --file frontend/web/Dockerfile --tag govbiz-web:local-k8s .
```

기본 `WEB_MODE=portfolio`는 기존 격리 빌드 모드로 같은 origin API를 사용하고 도우미 AI UI를
끈다. 실제 AI UI가 필요한 배포는 `--build-arg WEB_MODE=connected`로 명시한다.
두 모드 모두 `.env*`와 상속된 `VITE_*`를 읽지 않으며 개발 로그인은 빌드에서 비활성이다.
개인 관리 계정의 정상 로그인 준비는 별도다. 런타임 환경변수로 이미 빌드한 UI 설정이 바뀌지 않는다.

Docker context는 웹·공통 패키지·workspace 입력으로 제한하고 `.env*`·키·캐시·로컬 산출물을
제외한다. 최종 이미지에는 정적 결과와 Nginx 설정만 복사한다. Node·pnpm·소스·API 비밀값은
런타임에 필요 없다. UID/GID `101`, 읽기 전용 루트 파일 시스템, 모든 capability 제거,
`/tmp` 임시 볼륨으로 실행한다.

## 로컬 개발 배포

먼저 Core·Ops가 실행되는 **명시적으로 선택한 개인 개발 클러스터**에 이미지를 적재한다.
기존 운영 Argo Application과 서비스는 이 명령의 변경 대상이 아니다.

```bash
kind load docker-image govbiz-web:local-k8s --name <개인-kind-클러스터>
helm template web infrastructure/gitops/charts/govbiz-service \
  --namespace govbiz-msa -f infrastructure/gitops/environments/local-msa/web.yaml
helm upgrade --install web infrastructure/gitops/charts/govbiz-service \
  --kubeconfig <개인-kubeconfig> --namespace govbiz-msa \
  -f infrastructure/gitops/environments/local-msa/web.yaml --wait --timeout 5m
kubectl --kubeconfig <개인-kubeconfig> -n govbiz-msa \
  port-forward --address 127.0.0.1 service/web 18173:8080
```

접속 주소는 `http://localhost:18173`이다. 기존 `5173` 개발 서버를 중지하거나 포트를 빼앗지 않는다.
Core의 허용 Origin, Ops의 `DJANGO_ALLOWED_HOSTS`·CSRF 설정과 NetworkPolicy가 이 경로를 허용해야
한다. 허용된 기존 관리자 계정의 로그인·Ops 조회를 별도로 확인한다. 서비스 상태 확인만으로
인증·평가의 실제 연결 성공을 주장하지 않는다.

## CI와 운영 인계

GovBiz CI의 기존 `Web and shared` 작업에서 정적 이미지 빌드와 기존
`verify-production-proxy.py --web-image govbiz-web:ci`를 실행한다. 가상 Core·Ops를 사용하므로
유료 모델이나 실제 데이터에 연결하지 않는다. 기존 AWS 프록시 검사도 같은 도구에 유지한다.
Infra CI는 기존 서비스 Chart 렌더링 테스트와 lint에 웹을 포함한다.

운영 인계는 다음 순서가 남아 있다.

1. 변경 커밋의 필수 CI 성공을 확인한다.
2. 검증된 SHA로 웹 이미지 발행을 기존 발행 경로에 연결하고 공개 digest를 확보한다.
3. `localMode=false`, 공개 repository/digest, `pullPolicy=IfNotPresent`를 지정한다.
   local values의 `Never`를 원격 배포에 그대로 사용하지 않는다.
4. 같은 SHA의 Chart·웹 values를 선택하는 수동 Argo Application을 등록·동기화한다.
5. 기존 화면을 유지한 채 새 주소에서 로그인·Core·Ops 연결을 확인한 뒤 웹 접속을 전환한다.

이번 소스 변경만으로 공개 이미지가 발행되거나 기존 8개 Argo Application에 웹이 추가되지는
않는다. Kubernetes 웹 전환 완료와 외부 ingress/TLS 완료도 별개다.

## 2026-10-10 로컬 확인

- 기존 Vite 설정 테스트 15개, 서비스 Chart 테스트의 11개 항목, Helm 4.3.0 웹 lint를 확인했다.
  새 렌더링 테스트의 리소스 순서 가정 오류는 종류로 찾도록 수정하고 해당 항목을 재실행했다.
- 설치된 workspace 의존성으로 `tsc -b`와 `vite build --mode portfolio`를 통과했다.
- 해당 정적 번들을 **같은 Nginx 런타임 단계**에 넣은 검사 전용 이미지로 가상 Core·Ops를
  연결했다. SPA 새로고침·정적 파일·메서드/본문/쿼리·Host/Origin/쿠키/CSRF 헤더 전달·캐시와
  헤더 경계·API 404·2MiB 제한·리다이렉트를 확인했다. UID 101·읽기 전용 루트로 실행했다.
- 가상 Ops를 중지했을 때 API는 오류를 반환하고 정적 웹은 계속 제공하는 것도 확인했다.
  실제 Core 로그인이나 Django CSRF 정책을 검증한 결과로 확대하지 않는다.
- 같은 도구의 기존 AWS 프록시 검사도 통과해 기존 비밀 헤더·IP·쿠키 전달 계약을 유지했다.
- 로컬 Dockerfile 전체 빌드는 npm의 `ECONNRESET`·`UND_ERR_SOCKET`이 반복되어 두 시도 후
  중단했다. 동시 다운로드를 8개로 제한해도 반복됐으며 빌더 OOM 기록은 없었다.
  공급망 검사나 잠금 파일을 완화하지 않았다. 이 전체 빌드는 다음 커밋의 CI 확인 대상이다.

검사 전용 이미지나 로컬 정적 빌드를 공개 발행본으로 취급하지 않으며, 기존 개인 웹·Kubernetes
서비스를 이 이미지로 교체하지 않았다. 임시 검사 컨테이너·네트워크는 제거하고 빌더는 중지했다.
