function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 ChatPage에서 맡는 UI 역할을 이름으로 사용합니다.
// open/closed, user/assistant처럼 화면 상태가 달라지는 경우에는 base 스타일과 variant를 분리합니다.
export const chatPageStyles = {
  // 대화 내역은 껍데기와 함께 스크롤됩니다. 대화가 짧아도 입력창이 화면 아래에 오도록 남는 높이를 차지합니다.
  guestTimeline: 'relative mx-auto w-[min(860px,calc(100%_-_4rem))] flex-1 pt-8 pb-8 max-chat:w-[calc(100%_-_2rem)] max-chat:pt-4 [&>section]:ml-0 [&>section]:w-full',
  guestMessageRow: 'mb-10 flex min-w-0 gap-3 max-chat:mb-7',
  guestUserContent: 'min-w-0 max-w-[80%] [overflow-wrap:anywhere] max-chat:max-w-[90%]',
  guestAssistantContent: 'min-w-0 w-full [overflow-wrap:anywhere]',
  guestUserBubble: 'whitespace-pre-wrap rounded-3xl bg-[#f1f3f2] px-5 py-3.5 text-[0.95rem] leading-7 text-app-ink',
  guestAssistantBubble: 'whitespace-pre-wrap rounded-xl py-3 text-[0.95rem] leading-8 text-app-ink',
  // 입력창은 스크롤 껍데기의 아래에 붙습니다. 대화가 비치지 않도록 흰 배경을 깝니다.
  guestComposerDock: 'sticky bottom-0 z-[2] mx-auto mt-auto w-[min(860px,calc(100%_-_4rem))] shrink-0 bg-white pt-3 pb-[max(0.8rem,env(safe-area-inset-bottom))] max-chat:w-[calc(100%_-_1.5rem)]',
  guestComposerGroup: 'relative rounded-[1.8rem] border border-[#dce2de] bg-white shadow-[0_2px_12px_rgb(0_0_0_/_4%)] focus-within:border-[#7b9c88] focus-within:ring-2 focus-within:ring-brand-primary/10',
  guestComposerInput: 'block max-h-40 min-h-15 w-full resize-none rounded-[1.8rem] border-0 bg-transparent py-[1.05rem] pr-17 pl-6 text-base leading-7 text-app-ink placeholder:text-sample-muted outline-0 [field-sizing:content] max-chat:pl-4 max-chat:text-base',
  guestSubmitButton: 'absolute right-2.5 bottom-2.5 grid size-10 cursor-pointer place-items-center rounded-full bg-[#202124] text-white hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:bg-[#e9edeb] disabled:text-[#959e98]',
  guestCancelButton: 'absolute right-2 bottom-2 min-h-11 cursor-pointer rounded-full bg-[#edf2ef] px-3 text-xs font-semibold text-app-ink hover:bg-[#dee7e1] focus-visible:outline-2 focus-visible:outline-brand-primary',
  guestComposerFooter: 'mx-2 mt-2 flex min-h-7 items-center justify-between gap-2 [&_small]:text-[0.65rem] [&_button]:py-1',
  guestDisclaimer: 'mx-2 mt-1 block text-center text-[0.65rem] leading-5 text-sample-muted [@media(max-height:500px)]:sr-only',
  proposalPanel: 'ml-11 grid w-[min(40rem,calc(100%_-_2.75rem))] min-w-0 grid-cols-1 scroll-mt-36 gap-2 rounded-3xl border border-[#c9e4d6] bg-white p-4 shadow-[0_8px_28px_rgb(32_33_36_/_4%)] max-chat:ml-0 max-chat:w-full',
  proposalHeader: 'flex flex-wrap items-center justify-between gap-2',
  proposalEyebrow: 'inline-flex items-center gap-1.5 text-xs font-semibold text-brand-primary',
  proposalScope: 'rounded-full bg-brand-accent px-2.5 py-1 text-[0.68rem] font-bold text-brand-primary',
  proposalTitle: 'm-0 text-base font-bold leading-snug tracking-tight text-app-ink [overflow-wrap:anywhere]',
  proposalQueryTitle: 'line-clamp-2',
  proposalDescription: 'm-0 text-xs leading-relaxed text-sample-muted',
  proposalChanges: 'm-0 flex list-none flex-wrap gap-1.5 p-0',
  proposalChange: 'max-w-[calc(50%_-_0.1875rem)] truncate rounded-lg border border-sample-border bg-[#f8faf9] px-2.5 py-1 text-xs leading-relaxed text-[#345745]',
  proposalHint: 'm-0 text-xs leading-relaxed text-sample-muted',
  proposalDetails: 'min-w-0 border-t border-sample-border pt-2.5',
  proposalDetailsSummary: 'w-fit cursor-pointer rounded text-[0.72rem] font-semibold text-sample-muted hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  proposalDetailsList: 'my-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl bg-[#f8faf9] p-3 text-xs leading-relaxed',
  proposalDetailsLabel: 'text-sample-muted',
  proposalDetailsValue: 'm-0 whitespace-pre-wrap text-app-ink [overflow-wrap:anywhere]',
  conditionsActions: 'col-span-full flex flex-wrap items-center gap-2 pt-0.5',
  conditionsButton: 'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-full border border-brand-primary bg-brand-primary px-4 py-2 text-xs font-bold text-white hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50',
  proposalCancelButton: 'min-h-10 cursor-pointer rounded-full border border-sample-border bg-white px-3.5 py-2 text-xs font-semibold text-sample-muted hover:bg-[#f5f6f7] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  conditionsHint: 'my-2 text-xs leading-relaxed text-sample-muted',
  searchSnapshot: 'mt-2 text-xs leading-relaxed text-sample-muted',
  // 화면 안쪽에 스크롤 영역을 두지 않습니다. 스크롤은 껍데기(비로그인은 문서, 로그인은 작업 칸)가 맡습니다.
  page: 'flex flex-1 flex-col bg-white text-app-ink',
  workspace:
    'flex min-w-0 flex-1 flex-col',
  introWorkspace: 'pb-10',
  conversationWorkspace: '',
  // 로그인 뒤 작업 화면은 작업 칸의 남는 높이를 채우고, 대화가 길어지면 작업 칸과 함께 스크롤됩니다.
  workspacePage: 'relative flex flex-1 flex-col bg-white text-app-ink',
  workspaceShell: 'flex min-w-0 flex-1 flex-col',
  timeline: classes(
    'relative mx-auto min-h-0 w-[min(1040px,calc(100%_-_3rem))] flex-1 overflow-y-auto overscroll-contain px-1 pt-8 pb-6',
    'max-chat:w-[calc(100%_-_1rem)] max-chat:pt-5',
  ),
  emptyTimeline: 'sr-only',
  // 작업 화면에는 머리말이 없으므로 첫 메시지가 탭 줄 바로 아래에 붙지 않도록 위쪽 여백을 넉넉히 둡니다.
  workspaceTimeline: classes(
    'mx-auto w-[min(860px,calc(100%_-_2rem))] flex-1 pt-16 pb-6',
    'max-chat:w-[calc(100%_-_1.2rem)] max-chat:pt-10',
  ),
  messageRow: 'mb-[1.8rem] flex gap-3',
  userMessageRow: 'justify-end',
  assistantAvatar:
    'grid size-8 shrink-0 place-items-center self-start rounded-[0.7rem] bg-brand-accent font-black text-app-ink',
  messageContent: 'min-w-0 max-w-[min(700px,90%)] [overflow-wrap:anywhere] max-chat:max-w-[88%]',
  messageBubble:
    'whitespace-pre-wrap px-[1.1rem] py-4 leading-[1.65] shadow-[0_10px_30px_rgb(32_33_36_/_5%)]',
  userMessageBubble: 'rounded-[1rem_1rem_0.25rem_1rem] bg-brand-primary text-white',
  assistantMessageBubble: 'rounded-[1rem_1rem_1rem_0.25rem] bg-white text-app-ink',
  failureMessageBubble: 'ring-1 ring-inset ring-[#efd9d3]',
  messageActions: 'mt-3 flex flex-wrap items-center gap-2',
  messageRetryButton: 'min-h-10 cursor-pointer rounded-full border border-brand-primary bg-white px-4 py-2 text-xs font-semibold text-brand-primary hover:bg-brand-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  suggestedQuestions: 'mt-[0.85rem] flex flex-wrap gap-2',
  suggestedQuestionButton: classes(
    'cursor-pointer rounded-full border bg-white px-[0.78rem] py-[0.6rem] text-left text-[0.78rem]',
    'border-[#b4ddc7] text-sample-muted hover:border-brand-primary hover:bg-[#eef8f2] hover:text-[#115b3c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'disabled:cursor-not-allowed disabled:opacity-50',
  ),
  programList: 'mt-[0.9rem] grid gap-[0.8rem]',
  eligibilityReview: 'mt-3 grid gap-2 rounded-lg border border-sample-border bg-[#f6f7f8] p-3',
  eligibilityAxisTitle: 'm-0 text-sm font-bold text-app-ink',
  eligibilityQuote: 'mx-0 my-2 break-words border-l-2 border-sample-border pl-3 text-xs leading-relaxed text-sample-muted',
  reviewRequiredTag: 'rounded-[0.35rem] bg-[#fff4df] px-[0.48rem] py-1 text-[0.68rem] font-extrabold text-[#805a20]',
  searchingBubble: classes(
    'grid min-w-0 w-[min(26rem,calc(100%_-_2.75rem))] gap-2.5 rounded-[1rem_1rem_1rem_0.25rem] border border-sample-border bg-white p-4',
    'shadow-[0_10px_30px_rgb(32_33_36_/_5%)]',
  ),
  loadingHeader: 'flex items-center justify-between gap-4',
  loadingLabel: 'text-[0.85rem] font-bold text-app-ink',
  loadingDots: 'flex h-5 shrink-0 items-center gap-1.5',
  loadingDot: 'size-1.5 rounded-full bg-brand-primary motion-safe:animate-chat-loading-dot motion-reduce:animate-none',
  loadingDescription: 'm-0 text-xs leading-relaxed text-sample-muted [overflow-wrap:anywhere]',
  loadingTrack: 'h-1 overflow-hidden rounded-full bg-brand-accent',
  loadingSweep: 'block h-full w-1/3 rounded-full bg-brand-primary/75 motion-safe:animate-chat-loading-sweep motion-reduce:mx-auto motion-reduce:animate-none',
  intro: 'mx-auto w-[min(1180px,calc(100%_-_2rem))] pt-[clamp(2.5rem,5vw,4.5rem)] text-center',
  introTitle: 'mt-7 mb-0 break-keep text-[clamp(1.85rem,4vw,3.5rem)] font-extrabold leading-[1.38] tracking-[-0.065em] text-app-ink [text-wrap:balance] max-chat:mt-6',
  introTitleLine: 'inline-block max-w-full motion-safe:animate-search-intro-enter',
  introTitleSecondLine: 'motion-safe:[animation-delay:120ms]',
  introTitleWord: 'inline-block',
  introTitleFreeWord: 'inline-block font-black text-brand-primary underline decoration-[#aedcc2] decoration-[0.1em] underline-offset-[0.15em] forced-colors:text-[CanvasText]',
  introTitleCharacter: 'motion-safe:animate-search-intro-type',
  introTitleHighlight: classes(
    'text-brand-primary',
    'motion-safe:bg-[linear-gradient(110deg,#087f46_20%,#2ea66c_45%,#087f46_70%)] motion-safe:bg-size-[220%_100%]',
    'motion-safe:bg-clip-text motion-safe:text-transparent motion-safe:animate-search-intro-highlight',
    'forced-colors:bg-none forced-colors:text-[CanvasText]',
  ),
  introDescription: 'mt-6 mb-0 break-keep text-[clamp(0.9rem,1.45vw,1.15rem)] leading-[1.85] tracking-[-0.025em] text-sample-muted [text-wrap:pretty] max-chat:mt-4',
  composer:
    'mx-auto w-[min(1040px,calc(100%_-_3rem))] shrink-0 pt-10 pb-5 max-chat:w-[calc(100%_-_2rem)] max-chat:pt-7',
  composerDock:
    'mx-auto max-h-[55%] w-[min(1040px,calc(100%_-_3rem))] shrink-0 overflow-y-auto overscroll-contain px-1 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-chat:w-[calc(100%_-_1rem)]',
  dockedComposerInput: '[@media(max-height:500px)]:min-h-12 [@media(max-height:500px)]:pt-3 [@media(max-height:500px)]:pb-1',
  dockedComposerFooter: '[@media(max-height:500px)]:min-h-13 [@media(max-height:500px)]:pb-3',
  dockedComposerHint: '[@media(max-height:500px)]:sr-only',
  suggestions: 'mx-auto flex w-[min(1040px,calc(100%_-_3rem))] flex-wrap justify-center gap-2.5 max-chat:w-[calc(100%_-_2rem)]',
  // 입력창은 작업 칸의 아래에 붙습니다. 대화가 비치지 않도록 흰 배경을 깝니다.
  composerWorkspace:
    'sticky bottom-0 z-[2] mx-auto mt-auto w-[min(860px,calc(100%_-_2rem))] bg-white pt-2 pb-6 max-chat:w-[calc(100%_-_1.2rem)]',
  composerInputGroup: 'relative overflow-hidden rounded-[1.65rem] border border-[#b8dfc9] bg-white shadow-[0_3px_5px_rgb(23_68_45_/_5%),0_16px_48px_rgb(23_68_45_/_3%)] focus-within:border-[#23805a] focus-within:ring-2 focus-within:ring-[#23805a]/10',
  searchContextControls: 'mb-2',
  currentConditions: 'm-0 min-w-0 flex-1 text-xs leading-relaxed text-sample-muted [overflow-wrap:anywhere]',
  searchStatus: 'sr-only',
  searchError: classes(
    'mt-0 mb-[0.55rem] flex items-center justify-between gap-3 rounded-[0.7rem] border px-[0.8rem] py-[0.65rem] text-[0.76rem]',
    'border-[#f0cfd4] bg-[#fff5f6] text-[#9a3947]',
  ),
  readinessNotice: classes(
    'mx-auto mb-3 flex w-[min(860px,calc(100%_-_2rem))] flex-wrap items-center gap-2 text-xs leading-relaxed max-chat:w-[calc(100%_-_1.2rem)]',
    'text-sample-muted',
  ),
  readinessErrorNotice: classes(
    'mx-auto mb-3 flex w-[min(860px,calc(100%_-_2rem))] flex-wrap items-center gap-2 text-xs leading-relaxed max-chat:w-[calc(100%_-_1.2rem)]',
    'text-[#9a3947]',
  ),
  readinessRetryButton:
    'shrink-0 cursor-pointer rounded-[0.45rem] border border-[#dcaab2] bg-white px-2 py-[0.3rem] text-[0.72rem] font-bold text-[#8f3340] disabled:cursor-wait disabled:opacity-50',
  composerInput: classes(
    'block w-full resize-none border-0 bg-transparent px-7 pt-6 pb-3 text-app-ink placeholder:text-sample-muted outline-0',
    'leading-[1.7] max-chat:px-5 max-chat:pt-5',
  ),
  landingComposerInput: 'min-h-[8.5rem] text-[1.1rem] max-chat:min-h-[8rem] max-chat:text-base',
  workspaceComposerInput: 'min-h-[4.25rem] text-[0.95rem]',
  submitButton: classes(
    'absolute right-5 bottom-4 grid size-12 place-items-center max-chat:right-4 max-chat:bottom-4',
    'cursor-pointer rounded-full border-0 bg-brand-primary text-white hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'disabled:cursor-not-allowed disabled:bg-[#d7dce1]',
  ),
  cancelSearchButton: classes(
    'absolute right-5 bottom-4 min-h-12 rounded-full border-0 px-3 max-chat:right-4',
    'cursor-pointer bg-[#e8f5ed] text-[0.75rem] font-bold text-[#286044] hover:bg-[#d6ecdf]',
  ),
  composerFooter: 'flex min-h-[4.25rem] flex-wrap items-center gap-x-4 gap-y-2 pt-1 pr-[5.5rem] pb-5 pl-7 max-chat:pl-5',
  composerHint: 'block text-[0.75rem] leading-relaxed text-sample-muted max-chat:text-[0.68rem]',
  sourceHint: 'mx-4 mt-7 mb-0 flex flex-wrap items-center justify-center gap-2 text-center text-xs leading-relaxed text-sample-muted',
  programCard:
    'rounded-2xl border border-sample-border bg-white p-5 shadow-[0_8px_24px_rgb(32_33_36_/_4%)]',
  programCardHeader: 'flex flex-wrap items-center justify-between gap-3',
  programBadges: 'flex flex-wrap items-center gap-2',
  programRelevance: 'text-xs leading-relaxed text-sample-muted',
  interestButton: classes(
    'inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-lg border border-sample-border bg-white px-2 text-xs font-bold text-sample-muted',
    'hover:bg-brand-accent aria-pressed:border-brand-primary aria-pressed:bg-brand-accent aria-pressed:text-brand-primary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50',
  ),
  interestError: 'my-2 text-xs leading-relaxed text-red-700',
  programTag:
    'rounded-[0.35rem] bg-[#f0f9e9] px-[0.48rem] py-1 text-[0.68rem] font-extrabold text-[#536d37]',
  programDeadline: 'text-[0.74rem] font-extrabold text-[#b75561]',
  programTitle:
    'mt-3 mb-[0.18rem] text-[1.02rem] font-bold tracking-[-0.025em] text-app-ink',
  programOrganization: 'm-0 text-[0.75rem] text-sample-muted',
  programSummary: 'my-3 text-[0.82rem] leading-[1.55] text-sample-muted',
  programDetails: classes(
    'flex flex-col items-start justify-between gap-1 rounded-[0.65rem] p-[0.7rem]',
    'bg-[#f6f7f8] text-[0.75rem] text-sample-muted',
  ),
  matchedReasons: 'mt-[0.7rem] flex flex-wrap gap-[0.35rem]',
  matchedReason: 'text-[0.7rem] text-sample-muted',
  programActions: 'mt-[0.85rem] flex items-center justify-start gap-3',
  programDetailsButton: classes(
    'cursor-pointer rounded-full border-0 px-[0.7rem] py-[0.55rem]',
    'bg-brand-primary text-[0.74rem] font-extrabold text-white',
  ),
  programSourceLink:
    'rounded-full bg-[#edf7f1] px-[0.7rem] py-[0.55rem] text-[0.74rem] font-extrabold text-[#286044] no-underline',
} as const

export function chatMessageRowClassName(isUser: boolean) {
  return isUser
    ? `${chatPageStyles.messageRow} ${chatPageStyles.userMessageRow}`
    : chatPageStyles.messageRow
}

export function chatMessageBubbleClassName(isUser: boolean) {
  const variant = isUser
    ? chatPageStyles.userMessageBubble
    : chatPageStyles.assistantMessageBubble
  return `${chatPageStyles.messageBubble} ${variant}`
}
