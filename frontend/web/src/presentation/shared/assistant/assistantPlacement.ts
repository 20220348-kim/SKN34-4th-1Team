/**
 * 도우미 런처(오른쪽 아래 원)가 화면의 버튼을 가리지 않게 하는 표시입니다. 요소에 펼쳐 달면(`{...assistantLift.narrow}`)
 * 그 요소가 그려져 있는 동안에만 CSS가 런처·패널 자리를 바꾸고, 사라지면 저절로 제자리로 돌아옵니다.
 *
 * assistantLift: 화면 아래에 붙는 바(sticky·fixed 동작 바·단계 바). index.css의 `:root:has([data-assistant-lift])`가
 *   `--assistant-lift`를 채우고 런처·패널(Assistant.styles)이 그만큼 위로 올라갑니다.
 *   - `always`: 모든 폭에서 아래에 붙는 바 (예: 중복 검토 단계 바)
 *   - `narrow`: 600px 미만에서만 아래에 붙는 바 (예: 공고 상세의 아래 동작 바, 답변 입력의 이동 바)
 *
 * assistantCover: 런처 자리까지 덮는 시트·옆 패널·펼친 바. 열려 있는 동안 런처를 숨깁니다.
 *   - `always`: 모든 폭에서 오른쪽 아래를 덮는 요소 (예: 오른쪽 옆 패널과 그 아래 [저장] 버튼)
 *   - `narrow`: 600px 미만에서만 덮는 요소 (예: 아래 시트, 펼친 동작 바, 화면 폭 메뉴)
 */
export const assistantLift = {
  always: { 'data-assistant-lift': 'always' },
  narrow: { 'data-assistant-lift': 'narrow' },
} as const

export const assistantCover = {
  always: { 'data-covers-assistant': 'always' },
  narrow: { 'data-covers-assistant': 'narrow' },
} as const
