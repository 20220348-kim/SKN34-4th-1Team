# 단일 기본 노드와 자동 확장

시드니 EKS의 운영 목표는 `workloads` 공용 풀 **최소 1대 / 최대 2대**다.
`node-pool.yaml`은 기존 클러스터에 4 vCPU·16GiB `m6a.xlarge` 노드 그룹과
Cluster Autoscaler의 Pod Identity 역할을 만든다. VPC·클러스터·업무 데이터 볼륨을 생성하거나
삭제하지 않는다. 기존 역할별 두 노드 그룹은 데이터 이전과 준비 상태 확인 후 0대로 축소한다.

## 용량과 비용

2026-10-12 이전 직전 두 `m7i-flex.large`의 합산 CPU는 약 0.35~0.39코어,
메모리는 약 7.8GiB였다. 이는 관측 시점의 사용량이며 최대 부하 측정이 아니다.
8GiB 한 대로 통합할 여유가 없으므로 16GiB를 선택했다.
시드니 Linux 온디맨드 조회값은 기존 두 대 합계 시간당 $0.2394,
새 기본 한 대 $0.216이다. EC2 기본 비용 약 9.8% 절감이며 EKS·ALB·NAT·데이터 EBS 비용은 별도다.
두 번째 노드가 실행 중이면 EC2 비용은 시간당 $0.432이다. 크레딧과 무관하게 사용량은 발생한다.

## 확장 경로

`CPU 사용 증가 → HPA가 API Pod 증가 → 자원 요청을 수용할 노드 부족 → Cluster Autoscaler가 EC2 추가`

- API Gateway·Core·AI: CPU 요청량 대비 60%, Pod 최소 1 / 최대 3.
- Core·AI CPU 요청은 각각 250m이다. HPA·스케줄러·노드 확장이 동일한 요청량을 사용한다.
- Catalog·Ops·평가·DB·Langfuse는 단일 실행을 유지한다.
- 기존 Metrics Server를 사용한다. 자동 확장은 직접 설치한 Cluster Autoscaler 1.36.0이며
  EKS Auto Mode를 켜지 않는다. 클러스터 minor 버전 변경 시 Autoscaler도 함께 검토한다.
- HPA는 5분 안정화 후 한 번에 Pod 1개씩 줄인다. 노드는 10분의 축소 대기 시간을 둔다.
- 데이터 PVC를 사용하는 Pod와 기본 노드의 운영 구성 요소에는
  `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`를 적용한다.
  먼저 공용 노드 한 대에 이들을 모은 후 자동 확장을 시작한다. 영속 서비스가 여러 노드로
  흩어지면 데이터 재배치 전에는 해당 노드를 자동 축소할 수 없다.
- CPU 기반 확장은 OpenAI 응답 대기·DB 병목·요청 수 자체를 측정하지 않는다. 요청 지연 증가가
  CPU 증가 없이 발생하면 동시 요청 지표나 호출 한도 조정이 필요하다.
- Core의 검색 admission과 로그인 시도 제한은 기존과 같이 프로세스별이다.
  복제 수 증가만큼 전체 허용량이 늘어나며 전역 사용자 한도로 간주하지 않는다.
- 단일 기본 노드와 같은 AZ의 EBS 구성은 고가용성이 아니다. 노드 교체·DB 이동 중 중단이 발생한다.

## 적용 순서

1. 현재 Deployment·StatefulSet·Pod·PVC/PV·Argo Application을 비공개 작업 폴더에 보관한다.
   Secret 값이나 환경변수가 담긴 수집 파일은 Git·이슈·CI artifact에 올리지 않는다.
2. `kubectl top nodes`, `kubectl top pods -A`와 자원 요청량을 확인한다. EBS의 `Retain`과
   `ap-southeast-2a` 배치를 확인하고, 기존 EKS Pod Identity Agent 및 `aws-node`의 전용 IAM 역할을 유지한다.
3. `node-pool.yaml`을 CloudFormation으로 생성한다. `PrivateSubnet`에는 기존 EBS와 같은 AZ의
   private subnet, `ClusterSecurityGroup`에는 기존 EKS 클러스터 보안 그룹을 전달한다.
   생성 시 `DesiredSize: 1`이 필요하다. **이후 스택 갱신에서는 DesiredSize를 제거**하여
   Autoscaler가 관리하는 현재 크기를 되돌리지 않는다.
4. `aws eks describe-nodegroup`의 `resources.autoScalingGroups`에서 새 ASG를 확인하고 아래 태그를
   **ASG에 직접** 적용한다. EKS Nodegroup 태그만으로는 전파되지 않는다.

   | ASG 태그 | 값 |
   |---|---|
   | `k8s.io/cluster-autoscaler/enabled` | `true` |
   | `k8s.io/cluster-autoscaler/govbiz-eks` | `owned` |
   | `govbiz.io/workload-pool` | `workloads` |

   IAM의 변경 권한은 세 태그를 모두 가진 ASG에만 부여한다. 기존 두 풀에는 태그를 붙이지 않는다.
5. 새 노드 Ready와 EBS CSI·VPC CNI를 확인한다. 이전 중 새 배포가 겹치지 않게 배포 workflow를
   잠시 보류하고 Argo 자동 동기화를 보류한다. 기존 실행 중 요청을 종료한 뒤 저장소를 순차 이동한다.
   StatefulSet/PVC 이름과 볼륨 ID를 유지하며 볼륨이나 namespace를 삭제하지 않는다.
6. 모든 기존 `govbiz.io/workload-pool` 선택을 `workloads`로 바꾼다. 특히 Argo Application의
   비공개 Kustomize patch가 이전 `application`/`observability` 선택을 덮어쓰지 않도록 갱신한다.
   평가 실행기·결과 서버의 동일 호스트 affinity를 함께 유지한다.
7. 기본 노드에 `cluster-autoscaler.yaml`을 적용한다. Pod Identity 인증·ASG 발견·metrics API를 확인한다.
8. 새 `gitops-values.yaml`과 Chart를 포함한 커밋의 필수 CI를 통과시켜 배포한다.
   Core의 graceful shutdown 환경값은 비공개 runtime env patch에도 반영한다.
   Argo의 `ignoreDifferences`는 Core·AI Deployment의 `/spec/replicas`만 허용하고
   `RespectIgnoreDifferences=true`를 유지한다. 이미지·설정·나머지 서비스의 복제 수 검증은 유지한다.
9. API Gateway는 `kubectl apply -k infrastructure/eks/api-gateway`로 갱신한다.
   HPA 적용 후 `replicas`를 수동 고정하지 않는다. 기존 ALB·Ingress·Secret을 유지한다.
10. 모든 서비스 준비, 기존 PVC 13개 Bound, 운영 API 응답을 확인한 뒤 이전 두 노드를 drain하고
    기존 풀의 min/desired를 0으로 낮춘다. 기존 풀 max 1은 복구용으로 유지하되 자동 확장 대상에서 제외한다.
11. 유료 모델 호출 없이 제한된 부하로 HPA 증가를 확인하고, 합성 Pod로 새 노드 자동 생성·축소를 확인한다.
    테스트 namespace·부하는 종료한다. 합성 검증은 실제 사용자 트래픽의 성능 보장이 아니다.
12. 배포 workflow·Argo 자동 동기화를 복구하고 작업용 임시 EKS 접속 주소를 제거한다.

## 복구

기존 풀을 1대로 복구하고 Ready를 확인한 뒤, 저장해 둔 selector·runtime patch로 되돌린다.
새 노드에 붙은 EBS가 정상적으로 분리·재부착될 때까지 기다린다. 볼륨 강제 분리나 삭제를 사용하지 않는다.
HPA와 Autoscaler는 먼저 정지해 수동 복구와 경쟁하지 않도록 한다.
원래 노드 그룹의 역할·런치 템플릿은 통합 성공 직후에도 삭제하지 않는다.

## 확인 명령

```sh
kubectl get nodes -L govbiz.io/workload-pool
kubectl top nodes
kubectl -n govbiz-msa get hpa
kubectl -n kube-system get configmap cluster-autoscaler-status -o yaml
kubectl get pvc -A
kubectl -n argocd get application govbiz-eks
```

[AWS 노드 자동 확장](https://docs.aws.amazon.com/eks/latest/userguide/autoscaling.html) ·
[기존 시드니 배치](../sydney-demo.md) · [Argo 배포 흐름](../argo-cd.md)
