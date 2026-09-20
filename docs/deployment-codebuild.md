# 백엔드 자동 배포 — AWS CodeBuild

> 현재 운영 환경은 없습니다. 아래 AWS/Vercel 구성·배포 이력은 재구성 참고 자료이며 현재 가동 상태를 뜻하지 않습니다. 재배포 전 저장소·브랜치·대상 리소스와 비밀 설정을 다시 검토해야 합니다. 런타임 이름은 `core-service`·`ops-service`로 통일했습니다.

## 배포 경로

`GitHub main push(PR 병합 포함) → CodeBuild 백엔드 검증 → ECR 고정 digest → SSM → 기존 EC2 Core/AI 교체`

Vercel 프런트 배포는 기존 연결을 유지한다. GitHub Actions는 PR CI를 계속 실행한다.
AWS CodeBuild가 별도로 Core clean build/test, AI 전체 테스트·잠금 파일·패키지 빌드,
오프라인 평가 도구 및 실제 Docker Compose/Nginx 스텁 통합 검증을 통과한 뒤에만 배포한다.
유료 OpenAI 호출이나 운영 데이터 수집은 검증에 사용하지 않는다.

GitHub OIDC 생성이 제한된 현재 AWS 계정에서 AWS 서비스 역할과 CodeConnections를 사용하는 구성이다.
SCP·결제 플랜을 변경하거나 장기 AWS 액세스 키를 GitHub에 저장하지 않는다.
CodePipeline, S3 아티팩트 버킷, EC2의 별도 GitHub runner는 필요하지 않다.

## 현재 대상과 필요한 설정

- GitHub: `ilil1/SKN34-3rd-1Team`, 브랜치 `main`.
- Sydney CodeConnections: `govbiz-github`. GitHub App 접근은 이 저장소만 허용한다.
- CodeBuild: `govbiz-backend-deploy`, 서비스 역할 `govbiz-codebuild-backend`.
- 소스: GitHub + 해당 CodeConnections의 프로젝트별 자격증명, `refs/heads/main`, clone depth 1.
- buildspec: [`infrastructure/codebuild/backend.yml`](../infrastructure/codebuild/backend.yml).
- 환경: `aws/codebuild/standard:7.0`, Linux x86/medium, Docker privileged 모드.
  동시 빌드 1, 실행/대기 제한 각각 60분. Public builds는 비활성으로 유지한다.
- 로그 그룹: `/aws/codebuild/govbiz-backend-deploy`, 보존 14일.
- 프로젝트 환경값(비밀값 아님): `GOVBIZ_DEPLOY_ENABLED`, `GOVBIZ_INSTANCE_ID`,
  `GOVBIZ_DEPLOY_DOCUMENT`, `GOVBIZ_DEPLOY_DOCUMENT_VERSION`. `AWS_REGION`은 CodeBuild가 제공한다.
- ECR: **동일 AWS 계정**의 `govbiz/core-service`, `govbiz/ai-service`에 immutable tag 사용.
- SSM: `GovBiz-DeployBackend-v1`, 검증한 문서 버전을 숫자로 고정하며 대상은 기존 `govbiz-app` EC2 한 대.
  SSM Agent 3.3.2746.0 이상이 필요하다. 외부 SSH/HTTP 인바운드 추가는 필요하지 않다.

프로젝트에는 DB/JWT/SMTP/OAuth/OpenAI/프록시 비밀값을 넣지 않는다.
실제 비밀값과 Compose는 EC2의 `/opt/govbiz`에만 남는다.
백엔드 코드에 새로운 필수 환경변수가 추가되면 운영 환경 설정을 **별도로 검토·적용**해야 한다.
이 경로는 이미지 배포이지 인프라·환경 파일 전체의 자동 동기화가 아니다.

### IAM 최소 범위

CodeBuild 역할의 신뢰 대상은 `codebuild.amazonaws.com`이며 해당 계정과 프로젝트 ARN으로 제한한다.
실행 권한은 다음으로 제한한다.

- 연결 ARN 하나의 `codeconnections:GetConnection`, `GetConnectionToken`, `UseConnection`.
- 전용 로그 그룹의 `logs:CreateLogStream`, `PutLogEvents`.
- `ecr:GetAuthorizationToken`(이 작업은 resource `*`가 필요).
- 위 두 ECR 저장소만의 layer upload/download, image publish/read.
- `ssm:SendCommand`: 해당 SSM 문서와 **대상 EC2 ARN 한 개**만 허용.
  `AWS-RunShellScript` 범용 문서 실행·IAM 수정·운영 secret 읽기 권한은 부여하지 않는다.
- 실행 결과 확인용 `ssm:GetCommandInvocation`, 연결 점검용 `ssm:DescribeInstanceInformation`.

SSM 문서 내용은 [`ssm_document.py`](../infrastructure/codebuild/ssm_document.py)가
[`deploy_host.py`](../infrastructure/codebuild/deploy_host.py)를 포함해 생성한다.
관리자가 검토한 문서만 AWS에 등록하며 **CodeBuild 역할은 문서를 변경할 수 없다**.
호스트 배포 로직을 바꾸려면 새 이름/버전의 문서를 검증하고 프로젝트 설정·IAM 대상을 함께 갱신한다.

## 최초 활성화 순서

1. GitHub 연결을 `Available`로 만들고, 프로젝트는 `GOVBIZ_DEPLOY_ENABLED=false`로 생성한다.
   아직 webhook을 만들지 않는다.
2. GitHub 소스 다운로드, Docker 실행, ECR 조회가 되는 CodeBuild preflight를 실행한다.
3. SSM 문서를 생성하고 `Mode=check`로 호출한다. 기존 컨테이너/이미지/고정 proxy IP,
   Core→AI 건강 상태만 검사하고 컨테이너나 `.env.production`을 바꾸지 않는다.
4. PR의 전체 GitHub CI 통과를 확인한다. CodeBuild에서도 해당 PR 커밋을 수동 실행하되
   `GOVBIZ_DEPLOY_ENABLED=false`를 유지하면 검증까지만 수행한다.
5. CodeBuild 프로젝트에 기존 EC2 ID와 SSM 문서 이름을 지정하고 배포 스위치를 `true`로 설정한다.
   webhook 필터를 **하나의 그룹 안에** 아래 두 조건으로 만든다. PR 이벤트는 추가하지 않는다.

   ```json
   [[
     {"type": "EVENT", "pattern": "PUSH"},
     {"type": "HEAD_REF", "pattern": "^refs/heads/main$"}
   ]]
   ```

6. 사용자가 PR을 병합한다. `main`의 새 커밋으로 CodeBuild가 시작되는지,
   SSM 성공 표시와 Vercel `/api/v1/health`, `/api/v1/health/ai-service`를 확인한다.
   **프로젝트 생성·webhook 등록·스텁 테스트 통과만으로 실제 자동 배포 검증이 완료된 것은 아니다.**

`main` 직접 push도 배포 대상이다. main 쓰기/병합 권한은 운영 배포 권한으로 취급하고
신뢰할 수 있는 리뷰어와 CI 통과 후 병합하는 정책을 유지한다.
모든 main push가 검증을 시작하므로 변경 경로만으로 배포가 누락되는 일은 없다.

## 배포 동작과 실패 처리

- 단일 빌드만 실행하고, ECR 게시 전/후 `main` 최신 commit을 확인한다.
  이미 최신이 아닌 대기 빌드는 운영에 보내지 않는다.
- `git-<40자리 commit>` tag를 만들고 EC2에는 `@sha256:...` digest로 전달한다.
  재시도에서 존재하는 immutable tag는 덮어쓰지 않는다.
- EC2는 전체 배포에 파일 잠금을 걸고 새 이미지의 계정·저장소·플랫폼·commit label을 검증한다.
- `/opt/govbiz/.env.production`에서 `CORE_API_IMAGE`, `AI_SERVICE_IMAGE`만 원자적으로 교체한다.
  Compose 파일을 복사하지 않으므로 호스트의 SMTP 설정과 Core `172.30.254.3` 고정 IP를 유지한다.
- AI가 healthy가 된 다음 Core를 `--no-deps`로 교체하고 Nginx 설정을 reload한다.
  Nginx/ES/Qdrant/Redis/RabbitMQ 컨테이너와 모든 영속 볼륨은 재생성·삭제하지 않는다.
- `/opt/govbiz/deployments/<commit>-<임의값>`에 mode-600 이전 환경과 결과를 남긴다.
  이 백업은 비밀값이 있으므로 GitHub/로그/공유 파일로 복사하지 않는다.
- 시작/건강 검사 실패 시 이전 환경·이미지 복구를 시도하되 배포 결과는 **실패**로 남긴다.
  **Flyway가 이미 적용한 DB migration은 되돌리지 않는다.** DB 비호환/파괴적 migration은 별도
  백업·검토·승인이 필요하며 이전 이미지 복구만으로 해결된다고 가정하지 않는다.
- 단일 EC2의 컨테이너 교체 중 짧은 중단이 가능하다. 무중단/다중 서버 배포 구성은 아니다.

SSM 결과를 기다리다 CodeBuild가 종료돼도 원격 SSM 명령이 계속될 수 있다.
로그의 `SSM_COMMAND_ID`로 결과를 확인한 뒤 재시도한다. 무조건 다시 보내거나 기존 볼륨을 지우지 않는다.

## 중지·비용·용량

새 자동 실행을 막으려면 CodeBuild webhook을 삭제/비활성화하고 배포 스위치를 false로 바꾼다.
이미 실행 중인 빌드/SSM 작업에는 새 설정이 소급 적용되지 않으므로 먼저 해당 실행 상태를 확인한다.
EC2 서비스를 중지하는 설정은 아니다.

CodeBuild 실행 시간, ECR 저장 공간 및 CloudWatch 로그에 사용량 비용이 발생할 수 있다.
medium 빌드를 무료라고 가정하지 않는다. 실행 상한 60분·동시 1개는 월간 비용 상한이 아니다.
기존 EC2/RDS/NAT 비용은 그대로다.

40 GiB EBS에는 이전 이미지가 쌓인다. Docker 여유 공간 4 GiB 미만이면 새 배포를 중단한다.
자동 `docker system prune`, 볼륨 삭제 또는 기존 ECR lifecycle 변경은 하지 않는다.
현재 및 복구용 digest를 확인한 후 불필요한 릴리스를 별도로 정리한다.

참고: [CodeBuild GitHub App 연결](https://docs.aws.amazon.com/codebuild/latest/userguide/connections-github-app.html),
[webhook 필터](https://docs.aws.amazon.com/codebuild/latest/userguide/github-webhook.html),
[CodeBuild 요금](https://aws.amazon.com/codebuild/pricing/),
[SSM 매개변수 보안](https://docs.aws.amazon.com/systems-manager/latest/userguide/documents-syntax-data-elements-parameters.html).
