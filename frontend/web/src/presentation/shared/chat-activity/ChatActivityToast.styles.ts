/** 화면 오른쪽, 페이지 헤더 아래에 한 줄로 떠서 검색 결과 도착을 알리는 토스트입니다. 헤더 제목·탭과 도우미 런처(오른쪽 아래)를 가리지 않습니다. */
export const chatActivityToastStyles = {
  toast: 'fixed right-4 top-16 z-50 md:top-[5.5rem] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-sample-border bg-white px-4 py-3 text-sm text-brand-primary shadow-lg',
  text: 'm-0 min-w-0 flex-1 leading-snug',
  open: 'shrink-0 rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-semibold text-white no-underline hover:opacity-90',
  close: 'shrink-0 cursor-pointer border-0 bg-transparent px-1 text-base leading-none text-sample-muted hover:text-brand-primary',
} as const
