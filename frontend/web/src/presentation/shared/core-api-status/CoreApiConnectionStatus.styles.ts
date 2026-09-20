// 연결 상태의 공통 모양(root, dot)과 상태별 색상(loading, healthy, error)을 구분합니다.
// 상태 판단은 컴포넌트가 맡고, 이 파일은 각 상태가 어떻게 보이는지만 관리합니다.
export const coreApiStatusStyles = {
  root: 'flex items-start gap-[10px] border-t border-sample-border pt-[13px]',
  dot: 'mt-1 size-[9px] shrink-0 rounded-full',
  loadingDot: 'animate-connection-pulse bg-[#b77700]',
  healthyDot: 'bg-[#1f8a4c] shadow-[0_0_0_4px_rgba(31,138,76,0.16)]',
  errorDot: 'bg-[#b23d2b] shadow-[0_0_0_4px_rgba(178,61,43,0.12)]',
  title: 'block text-[0.78rem]',
  description: 'mt-1 mb-0 text-[0.71rem] leading-[1.45] text-sample-muted',
  retryButton: 'mt-[10px] rounded-full bg-brand-primary px-3 py-2 text-[0.72rem] text-white hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
} as const

export function coreApiStatusDotClassName(state: 'loading' | 'healthy' | 'error') {
  const variant = {
    loading: coreApiStatusStyles.loadingDot,
    healthy: coreApiStatusStyles.healthyDot,
    error: coreApiStatusStyles.errorDot,
  }[state]

  return `${coreApiStatusStyles.dot} ${variant}`
}
