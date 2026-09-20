function classes(...groups: string[]) {
  return groups.join(' ')
}

/**
 * GovBiz 도우미 위젯의 스타일입니다. 채널톡·Intercom·Zendesk 위젯 관례(브랜드색 헤더, 회색 봇 말풍선, 브랜드색 사용자 말풍선,
 * 알약 빠른 답변, 카드 + 전폭 링크 버튼)를 따르고 색은 전부 기존 토큰만 씁니다.
 */
export const assistantStyles = {
  // 런처: 우측 하단 56px 원. 채팅 화면에서는 입력창을 가리지 않게 위로 올립니다.
  launcherWrap: 'fixed right-6 z-[30] flex items-center gap-2.5 max-[639px]:right-4',
  launcherWrapDefault: 'bottom-6',
  launcherWrapLifted: 'bottom-[92px]',
  launcher: classes(
    'relative flex size-14 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary text-white',
    'shadow-[0_8px_22px_-8px_rgb(8_127_70_/_60%)] hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'max-[639px]:size-12',
  ),
  launcherOpen: 'bg-app-ink hover:bg-app-ink',
  launcherLabel: classes(
    'rounded-full border border-sample-border bg-white px-3.5 py-2 text-[13px] font-medium text-app-ink',
    'shadow-[0_2px_4px_rgb(20_24_22_/_6%),0_20px_44px_-20px_rgb(20_24_22_/_30%)] max-[639px]:hidden',
  ),
  launcherBadge: classes(
    'absolute -top-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full border-2 border-white',
    'bg-[#c62828] text-[10.5px] font-bold text-white',
  ),

  // 패널: 데스크톱 380×min(600, 화면 높이 - 아래 여백 - 위 여백 20px) 비모달 팝오버, 모바일 전체 화면.
  // 높이는 아래 여백(bottom)과 함께 정해야 창을 줄여도 위쪽이 화면 밖으로 잘리지 않습니다.
  panel: classes(
    'fixed right-6 z-[31] flex w-[380px] flex-col overflow-hidden rounded-2xl border border-sample-border bg-white',
    'shadow-[0_2px_4px_rgb(20_24_22_/_6%),0_20px_44px_-20px_rgb(20_24_22_/_30%)]',
    'max-[639px]:inset-0 max-[639px]:h-auto max-[639px]:w-auto max-[639px]:rounded-none max-[639px]:border-0',
  ),
  panelDefault: 'bottom-[92px] h-[min(600px,calc(100dvh-112px))]',
  // 채팅 화면에서는 입력창 위로 올리므로(bottom 160px) 그만큼 높이도 줄입니다.
  panelLifted: 'bottom-[160px] h-[min(600px,calc(100dvh-180px))]',
  header: 'flex shrink-0 items-center gap-2.5 bg-brand-primary px-3.5 py-3 text-white',
  headerBack: 'hidden max-[639px]:flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-white text-lg',
  avatar: 'flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[15px] font-bold text-brand-primary',
  avatarSmall: 'flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-[12px] font-bold text-brand-primary border border-sample-border',
  headerText: 'min-w-0 flex-1',
  headerName: 'm-0 text-[15px] font-bold leading-tight',
  headerActions: 'relative flex shrink-0 gap-1',
  headerButton: classes(
    'flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-white text-base',
    'hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
  ),
  menu: 'z-[32] w-[176px] rounded-xl border border-sample-border bg-white p-1.5 text-[13px] text-app-ink shadow-[0_10px_30px_-12px_rgb(0_0_0_/_32%)]',
  menuItem: 'block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-[13px] text-app-ink hover:bg-app-canvas focus-visible:outline-2 focus-visible:outline-brand-primary',

  // 대화 영역
  log: 'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto bg-white px-3.5 py-4',
  dateSeparator: 'text-center text-[11.5px] text-sample-muted',
  // 아바타는 묶음의 첫 말풍선 옆(위)에 붙습니다.
  group: 'flex items-start gap-2',
  groupMe: 'justify-end',
  column: 'flex max-w-[78%] flex-col gap-1.5',
  columnWide: 'max-w-[88%]',
  bubble: 'rounded-2xl px-[13px] py-2.5 text-[13.5px] leading-[1.6] [overflow-wrap:anywhere]',
  bubbleBot: 'rounded-tl-[4px] bg-app-canvas text-app-ink',
  bubbleMe: 'rounded-tr-[4px] bg-brand-primary text-white',
  bubbleWarn: 'rounded-tl-[4px] border border-[#f0dcc2] bg-[#fff5e8] text-app-ink',
  paragraph: 'm-0 mb-1.5 last:mb-0',
  timestamp: 'px-1 text-[10.5px] text-sample-muted',
  typing: 'inline-flex gap-1 rounded-2xl rounded-tl-[4px] bg-app-canvas px-3.5 py-3',
  typingDot: 'inline-block size-1.5 rounded-full bg-sample-muted/70',

  // 빠른 답변: 봇 말풍선 아래 알약. 누르면 사용자 말풍선이 되고 사라집니다.
  quickReplies: 'flex flex-wrap gap-1.5 pl-9',
  quickReply: classes(
    'cursor-pointer rounded-full border border-brand-primary bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#066538]',
    'hover:bg-brand-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),

  // 카드: 행 여러 개 + 전폭 링크 버튼
  card: 'overflow-hidden rounded-xl border border-sample-border bg-white text-[13px]',
  cardRow: 'border-b border-sample-border px-3 py-2.5 last:border-b-0',
  cardRowTitle: 'block font-bold leading-[1.45]',
  cardRowLink: 'block font-bold leading-[1.45] underline-offset-2 hover:underline focus-visible:underline',
  cardRowDetail: 'block text-[12px] text-sample-muted',
  cardTag: 'mr-1.5 inline-block rounded px-1.5 py-px align-[1px] text-[10.5px] font-bold',
  cardTagHot: 'bg-[#fde8e6] text-[#9a3947]',
  cardTagSoon: 'bg-[#fff5e8] text-[#9a5b1d]',
  cardTagOk: 'bg-brand-accent text-[#066538]',
  cardTagMuted: 'bg-app-canvas text-sample-muted',
  cardButton: classes(
    'block w-full cursor-pointer border-0 border-t border-sample-border bg-white px-3 py-2.5 text-center text-[13px] font-bold text-[#066538] no-underline',
    'hover:bg-brand-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-primary first:border-t-0',
  ),
  source: 'px-1 text-[10.5px] text-sample-muted',

  // 입력창
  composer: 'flex shrink-0 items-end gap-2 border-t border-sample-border bg-white px-3 pt-2.5 pb-3 max-[639px]:pb-[max(0.75rem,env(safe-area-inset-bottom))]',
  input: classes(
    'max-h-[104px] min-h-10 flex-1 resize-none rounded-[20px] border border-sample-border bg-white px-3.5 py-2.5 text-[13.5px] leading-[1.5] text-app-ink',
    'placeholder:text-sample-muted focus-visible:outline-2 focus-visible:outline-brand-primary',
  ),
  send: classes(
    'flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary text-white',
    'hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'disabled:cursor-default disabled:bg-[#d3d7db]',
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
