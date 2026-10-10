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

개인 환경에서 기존 `http://localhost:5173`을 유지하며 새 웹을 사용할 때는 Core를 관리하는
Argo Application의 `spec.source.helm.valuesObject.env.APP_CORS_ALLOWED_ORIGIN`에
`http://localhost:5173,http://localhost:18173`을 설정하고 Core만 수동 동기화한다. 기존 값이
따로 있으면 덮어 버리지 말고 허용할 새 origin을 추가한다. 이는 Core의 세션 쿠키 쓰기 요청에
필요한 설정이다. 로그인·조회가 성공해도 이 값이 없으면 저장·로그아웃은 거절될 수 있다.
`127.0.0.1`로 접속한다면 해당 origin도 정확히 추가하고, 쿠키를 공유하지 않는 두 호스트를
로그인 도중에 혼용하지 않는다. 외부 origin을 광범위하게 허용하거나 CSRF 검사를 끄지 않는다.

Ops는 Host·Origin을 함께 보존하는 같은 origin 프록시를 사용한다. 현재 개인 환경의
`DJANGO_ALLOWED_HOSTS`에 `localhost,127.0.0.1`이 포함되어 있으므로 이 두 호스트의 직접 HTTP
접속을 위해 `DJANGO_CSRF_TRUSTED_ORIGINS`를 추가할 필요는 없다. 외부 ingress는 별도 설정이다.

## CI와 운영 인계

GovBiz CI의 기존 `Web and shared` 작업에서 정적 이미지 빌드와 기존
`verify-production-proxy.py --web-image govbiz-web:ci`를 실행한다. 가상 Core·Ops를 사용하므로
유료 모델이나 실제 데이터에 연결하지 않는다. 기존 AWS 프록시 검사도 같은 도구에 유지한다.
Infra CI는 기존 서비스 Chart 렌더링 테스트와 lint에 웹을 포함한다.

운영 인계는 다음 순서가 남아 있다.

1. 변경 커밋의 필수 CI 성공을 확인한다.
2. 기본 브랜치의 `Kubernetes package setup`에서 `component=web`과 정확한 패키지 주소를
   입력해 빈 패키지를 준비한다. Actions 임시 토큰을 사용하므로 PAT 발급은 필요 없다.
   Public·연결 포크·Actions Write를 확인한다. 기존 패키지가 있으면 설정을 조회한다.
3. 기존 `MSA image candidates`를 기본 브랜치에서 `component=web`으로 수동 실행한다.
   동일 SHA 필수 CI를 다시 확인하고 `portfolio` 이미지 한 개를 발행한다.
   `msa-image-web`의 `web.json`에 기록된 공개 digest를 확보한다.
4. `localMode=false`, 공개 repository/digest, `pullPolicy=IfNotPresent`를 지정한다.
   local values의 `Never`를 원격 배포에 그대로 사용하지 않는다.
5. 같은 SHA의 Chart·웹 values를 선택하는 수동 Argo Application을 등록·동기화한다.
6. 기존 화면을 유지한 채 새 주소에서 로그인·Core·Ops 연결을 확인한 뒤 웹 접속을 전환한다.

발행·패키지 준비는 기존 도구를 재사용한다. 네 백엔드의 자동 발행과 평가 실행기의 별도 발행은
유지하며, 웹 패키지가 없다는 이유로 백엔드 자동 발행을 차단하지 않는다.
웹은 여러 workspace 입력과 `portfolio` 모드를 묶은 v4 receipt를 사용하므로 기존 네 백엔드
배포 묶음에 포함하지 않는다. [발행 안내](../../release/README.md#kubernetes-웹-이미지)

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

후속 `skn-422` CI에서는 npm 설치가 성공한 뒤 `tsc -b`가 실패했다. 웹 테스트가 참조하는
`evaluation/application-map/fixtures/synthetic-online-input-guide-v1.json`이 Docker context에
없던 것이 원인이다. 해당 합성 파일 하나를 빌드 단계·dockerignore 허용 목록·발행 archive 입력에
포함하도록 수정했다. 타입 검사를 제외하거나 전체 evaluation 디렉터리를 이미지에 넣지 않는다.
최종 Nginx 단계에는 계속 정적 번들과 Nginx 설정만 복사한다.

수정 확인은 Docker와 같은 소스 경로만 복사한 격리 디렉터리에서 수행했다. 합성 JSON을 뺀
`tsc -b --force`에서 동일한 `TS2307`을 재현했고, 추가한 뒤 타입 검사와 `portfolio` 정적 빌드가
통과했다. 설치된 의존성을 사용한 Windows 확인이며 Linux 이미지 빌드 성공을 대신하지 않는다.
수정 후 로컬 전체 이미지 빌드도 npm의 `UND_ERR_SOCKET`·`ECONNRESET`이 반복되어 중지했다.
새 커밋의 필수 CI에서 전체 이미지 빌드·프록시를 확인해야 한다.

## 2026-10-10 병합본 CI 확인과 후속 수정

`skn-424`가 병합된 `c391f55b9b9b344ce56c115de6e1b348c814bb0c`의
[GovBiz CI 실행](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/38045961584)에서
Linux 웹 Docker 이미지 빌드가 성공했다. 합성 JSON 누락 문제는 해결됐으며, 정적 파일·SPA·
Core/Ops 라우팅·본문·쿠키·CSRF 헤더 전달 검사도 통과했다.

마지막 Ops 장애 검사에서는 검사 클라이언트의 3초 제한이 Nginx의 3초 연결 제한과 겹쳐
HTTP 오류 응답을 읽기 전에 `TimeoutError`가 발생했다. 기존 검사 도구에서 이 요청만 10초까지
기다리도록 수정했다. Nginx의 운영 제한은 유지하고, 실제 `502` 또는 `504`·캐시 금지·SPA로
대체하지 않는 응답·정적 웹 지속 제공을 계속 확인한다. 요청 실패 시에도 검사 소켓을 닫는다.

수정 후 기존 로컬 Nginx 검사 이미지로 전체 웹 프록시·Ops 중단 경로를 통과했고 Ruff 검사도
통과했다. 이 실행은 기존 런타임 단계 검사 이미지를 사용했으며 공개 이미지 발행은 아니다.
별도 검사 도구나 워크플로는 추가하지 않았다. 실패한 병합본 CI를 성공으로 간주하지 않으며,
수정 커밋의 필수 CI가 통과한 뒤 공개 패키지 준비·웹 이미지 발행·Argo 인계를 진행해야 한다.
