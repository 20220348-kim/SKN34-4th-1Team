# LLMOps README 구조도

[메인 README](../../../README.md#llmops-평가운영)의 **평가·운영 기능을 설명하던 이미지 원본**입니다.
현재 메인 README는 시스템 아키텍처와 스타일을 통일한 Mermaid 흐름도를 사용하며, 해당 Markdown에서 직접 수정합니다.
아래 PNG·SVG는 기존 그림을 참고할 수 있도록 보존합니다.
배포 네트워크나 모든 서비스의 HTTP 호출 관계를 나타내는 그림은 아닙니다.

- [PNG](llmops-evaluation-flow.png): 기존 이미지, 2880 × 2864px.
- [SVG](llmops-evaluation-flow.svg): 문구·색상·배치를 편집할 수 있는 원본, 1440 × 1432 viewBox.
- 구성 근거: [Ops 기능·API](../../../backend/ops-service/README.md),
  [실행 환경](../../../infrastructure/llmops/README.md),
  [공유 검토 기록](../../ops-local-review-copy.md).

첨부 예시의 연한 녹색·파란색 영역, 둥근 카드와 위에서 아래로 이어지는 구성을 참고해 새로 작성했습니다.
예시 이미지의 LangGraph 흐름이나 로고를 복제하지 않았습니다.

## 그림을 읽는 순서

1. **접수:** React → Django Ops → Prefect. Core는 기존 관리자 세션을 확인하고,
   Django는 실행 명세를 고정합니다. 새 모델 호출이 있는 요청에 예산 승인·예약을 적용합니다.
2. **실행:** 저장 응답 재평가, 고정 근거 새 답변, 새 RAG 실행은 한 실행에서 선택하는 대안입니다.
   세 경로가 모두 순차 실행되는 것은 아닙니다. RAG는 등록된 원문·청크와 격리된 메모리 색인 범위입니다.
3. **분석:** pandas·Pandera로 데이터를 변환·검증하고 지표를 계산합니다. Evidently 보고서와
   Langfuse 관측·점수를 확인합니다. Langfuse의 호출 추적은 실제 호출 중에도 수집합니다.
4. **검토:** 사람의 자료·사례·실행 검토, 품질 판정, 비교 기준 수동 지정을 거쳐 다음 평가에 재사용합니다.
   실행 완료만으로 합격이나 기준 지정이 이루어지지 않습니다.

## 수정·렌더링

SVG는 외부 이미지·스크립트·네트워크 참조 없이 텍스트와 벡터 도형으로 구성합니다.
PNG의 한글은 저장소의 [NanumGothic](../../../backend/core-service/src/main/resources/fonts/NanumGothic-Regular.ttf)으로
렌더링했습니다. 글꼴 라이선스는 [SIL OFL](../../../backend/core-service/src/main/resources/fonts/OFL-NanumGothic.txt)입니다.
SVG 자체에는 글꼴을 포함하지 않으므로 보는 환경에 따라 대체 글꼴이 사용될 수 있습니다.
이 PNG·SVG를 수정해도 현재 메인 README의 Mermaid 흐름도에는 반영되지 않습니다.

SVG를 수정한 뒤 NanumGothic을 사용할 수 있는 문서 도구 환경에서 Sharp로 PNG를 다시 렌더링합니다.
아래는 저장소 루트를 기준으로 한 예시입니다. Sharp는 그림 제작 도구이며 애플리케이션 의존성을
추가할 필요가 없습니다. `NODE_PATH`는 Sharp가 설치된 별도 도구의 `node_modules` 경로를 가리킵니다.

```bash
NODE_PATH=/path/to/document-tools/node_modules node <<'JS'
const sharp = require('sharp');
sharp('docs/assets/llmops/llmops-evaluation-flow.svg', { density: 144 })
  .png()
  .toFile('docs/assets/llmops/llmops-evaluation-flow.png');
JS
```

한글과 줄바꿈, 카드 안의 글자 잘림, 화살표·문구의 겹침을 PNG에서 확인한 후 SVG와 함께 반영합니다.
