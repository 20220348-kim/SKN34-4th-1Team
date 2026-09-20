/** 대화 기록과 헤더에서 검색 진행·결과 도착을 알리는 점 표시입니다. */
export const chatActivityDotStyles = {
  dot: 'size-2.5 shrink-0 rounded-full',
  dotPending: 'bg-brand-primary animate-pulse motion-reduce:animate-none',
  dotDone: 'bg-brand-primary',
  dotFailed: 'bg-red-600',
} as const
