function classes(...groups: string[]) {
  return groups.join(' ')
}

/**
 * GovBiz 도우미 위젯의 스타일입니다. 채널톡·Intercom·Zendesk 위젯 관례(브랜드색 헤더, 회색 봇 말풍선, 브랜드색 사용자 말풍선,
 * 알약 빠른 답변, 카드 + 전폭 링크 버튼)를 따르고 색은 전부 기존 토큰만 씁니다.
 */
export const assistantStyles = {
  // 런처: 우측 하단 56px 원. 아래 고정 바가 `data-assistant-lift`를 달면 index.css가 --assistant-lift를 채워 그 바 위로 올립니다.
  // 화면이 `data-covers-assistant`를 단 요소(옆 패널·아래 시트·펼친 동작 바·메뉴)를 그리는 동안에는 그 위에 떠 있지 않도록 숨깁니다.
  // 값이 always면 모든 폭, 그 밖(narrow)은 600px 미만에서만 숨깁니다(assistantPlacement.ts).
  launcherWrap: classes(
    'fixed right-6 bottom-[calc(1.5rem+var(--assistant-lift,0px))] z-[30] flex items-center gap-2.5 max-[639px]:right-4',
    '[body:has([data-covers-assistant=always])_&]:hidden max-[599px]:[body:has([data-covers-assistant])_&]:hidden',
  ),
  launcher: classes(
    'relative flex size-14 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary text-white',
    'shadow-[0_8px_22px_-8px_rgb(8_127_70_/_60%)] hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'max-[639px]:size-12',
  ),
  launcherOpen: 'bg-ink hover:bg-ink',
  launcherLabel: classes(
    'rounded-full border border-line bg-white px-3.5 py-2 text-[13px] font-medium text-ink',
    'shadow-[0_2px_4px_rgb(20_24_22_/_6%),0_20px_44px_-20px_rgb(20_24_22_/_30%)] max-[639px]:hidden',
  ),
  launcherBadge: classes(
    'absolute -top-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full border-2 border-white',
    'bg-[#c62828] text-[10.5px] font-bold text-white',
  ),

  // 패널: 데스크톱 380×min(600, 화면 높이 - 아래 여백 - 위 여백 20px) 비모달 팝오버, 모바일 전체 화면.
  // 높이는 아래 여백(bottom)과 함께 정해야 창을 줄여도 위쪽이 화면 밖으로 잘리지 않습니다. 런처를 올린 만큼(--assistant-lift) 함께 올립니다.
  panel: classes(
    'fixed right-6 bottom-[calc(5.75rem+var(--assistant-lift,0px))] z-[31] flex h-[min(600px,calc(100dvh-7rem-var(--assistant-lift,0px)))] w-[380px]',
    'flex-col overflow-hidden rounded-2xl border border-line bg-white',
    'shadow-[0_2px_4px_rgb(20_24_22_/_6%),0_20px_44px_-20px_rgb(20_24_22_/_30%)]',
    'max-[639px]:inset-0 max-[639px]:h-auto max-[639px]:w-auto max-[639px]:rounded-none max-[639px]:border-0',
  ),
  header: 'flex shrink-0 items-center gap-2.5 bg-brand-primary px-3.5 py-3 text-white',
  headerBack: 'hidden max-[639px]:flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-white text-lg',
  avatar: 'flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[15px] font-bold text-brand-primary',
  avatarSmall: 'flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-[12px] font-bold text-brand-primary border border-line',
  headerText: 'min-w-0 flex-1',
  headerName: 'm-0 text-[15px] font-bold leading-tight',
  headerActions: 'relative flex shrink-0 gap-1',
  headerButton: classes(
    'flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-white text-base',
    'hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
  ),

  // 대화 영역
  log: 'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto bg-white px-3.5 py-4',
  dateSeparator: 'text-center text-[11.5px] text-ink-muted',
  // 아바타는 묶음의 첫 말풍선 옆(위)에 붙습니다.
  group: 'flex items-start gap-2',
  groupMe: 'justify-end',
  column: 'flex max-w-[78%] flex-col gap-1.5',
  columnWide: 'max-w-[88%]',
  bubble: 'rounded-2xl px-[13px] py-2.5 text-[13.5px] leading-[1.6] [overflow-wrap:anywhere]',
  bubbleBot: 'rounded-tl-[4px] bg-canvas text-ink',
  bubbleMe: 'rounded-tr-[4px] bg-brand-primary text-white',
  bubbleWarn: 'rounded-tl-[4px] border border-[#f0dcc2] bg-[#fff5e8] text-ink',
  paragraph: 'm-0 mb-1.5 last:mb-0',
  timestamp: 'px-1 text-[10.5px] text-ink-muted',
  typing: 'inline-flex gap-1 rounded-2xl rounded-tl-[4px] bg-canvas px-3.5 py-3',
  // 검색 말풍선과 같은 점 움직임입니다. 둘째 · 셋째 점은 조금씩 늦게 시작하고, 움직임 줄이기 설정이면 멈춥니다.
  typingDot: 'inline-block size-1.5 rounded-full bg-ink-muted/70 motion-safe:animate-chat-loading-dot motion-reduce:animate-none nth-2:[animation-delay:160ms] nth-3:[animation-delay:320ms]',

  // 빠른 답변: 봇 말풍선 아래 알약. 누르면 사용자 말풍선이 되고 사라집니다.
  quickReplies: 'flex flex-wrap gap-1.5 pl-9',
  quickReply: classes(
    'cursor-pointer rounded-full border border-brand-primary bg-white px-3 py-1.5 text-[12.5px] font-medium text-brand-hover',
    'hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),

  // 카드: 행 여러 개 + 전폭 링크 버튼
  card: 'overflow-hidden rounded-xl border border-line bg-white text-[13px]',
  cardRow: 'border-b border-line px-3 py-2.5 last:border-b-0',
  cardRowTitle: 'block font-bold leading-[1.45]',
  cardRowLink: 'block font-bold leading-[1.45] underline-offset-2 hover:underline focus-visible:underline',
  cardRowDetail: 'block text-[12px] text-ink-muted',
  cardTag: 'mr-1.5 inline-block rounded px-1.5 py-px align-[1px] text-[10.5px] font-bold',
  cardTagHot: 'bg-[#fde8e6] text-danger',
  cardTagSoon: 'bg-[#fff5e8] text-[#9a5b1d]',
  cardTagOk: 'bg-brand-soft text-brand-hover',
  cardTagMuted: 'bg-canvas text-ink-muted',
  cardButton: classes(
    'block w-full cursor-pointer border-0 border-t border-line bg-white px-3 py-2.5 text-center text-[13px] font-bold text-brand-hover no-underline',
    'hover:bg-brand-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-primary first:border-t-0',
  ),
  source: 'px-1 text-[10.5px] text-ink-muted',

  // 입력창
  composer: 'flex shrink-0 items-end gap-2 border-t border-line bg-white px-3 pt-2.5 pb-3 max-[639px]:pb-[max(0.75rem,env(safe-area-inset-bottom))]',
  input: classes(
    'max-h-[104px] min-h-10 flex-1 resize-none rounded-[20px] border border-line bg-white px-3.5 py-2.5 text-[13.5px] leading-[1.5] text-ink',
    'placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-brand-primary',
  ),
  send: classes(
    'flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary text-white',
    'hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'disabled:cursor-default disabled:bg-[#d3d7db]',
  ),
  // 로그인 전에는 입력창 자리에 안내 한 줄과 로그인 링크를 둡니다. 주제 알약은 그대로 씁니다.
  composerLogin: 'flex shrink-0 items-center justify-between gap-3 border-t border-line bg-white px-4 pt-3 pb-3.5 max-[639px]:pb-[max(0.875rem,env(safe-area-inset-bottom))]',
  composerLoginText: 'm-0 text-[12.5px] leading-[1.5] text-ink-muted',
  composerLoginLink: classes(
    'inline-flex min-h-9 shrink-0 items-center rounded-full border border-brand-primary bg-white px-3.5 text-[12.5px] font-bold text-brand-hover no-underline',
    'hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
} as const

export type AssistantCardTagTone = 'hot' | 'soon' | 'ok' | 'muted'

export function assistantCardTagClassName(tone: AssistantCardTagTone): string {
  const tones: Record<AssistantCardTagTone, string> = {
    hot: assistantStyles.cardTagHot,
    soon: assistantStyles.cardTagSoon,
    ok: assistantStyles.cardTagOk,
    muted: assistantStyles.cardTagMuted,
  }
  return `${assistantStyles.cardTag} ${tones[tone]}`
}
