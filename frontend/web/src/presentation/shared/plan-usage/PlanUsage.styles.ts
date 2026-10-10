// 색상이나 CSS 속성이 아니라 이용량 줄에서 맡는 UI 역할을 이름으로 사용합니다.
// 글자 크기와 바깥 여백은 붙는 자리(입력창 아래 안내 · 실행 버튼 옆)에 맞추도록 쓰는 화면이 정합니다.
export const planUsageStyles = {
  line: 'm-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-relaxed text-ink-muted',
  // 한도의 80%부터는 경고 색으로 바꾸고 다시 채워지는 때를 함께 둡니다.
  lineWarning: 'm-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-relaxed font-semibold text-warning',
  separator: 'text-ink-subtle',
} as const
