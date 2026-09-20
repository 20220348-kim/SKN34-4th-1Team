import type { AssistantAnswer, AssistantCard as AssistantAnswerCard } from '../../../domain/entities/AssistantAnswer'
import type { PartnerProposal } from '../../../domain/entities/PartnerProposal'
import type { SavedSupportProgram } from '../../../domain/entities/SavedSupportProgram'
import { loginPathFor, signupPathFor } from '../auth/returnPath'
import { findHelpEntry, helpActionHref } from '../help/helpContent'
import type { HelpEntry } from '../help/helpTypes'
import { appPaths, isAppPath, publicPaths, supportProgramQuestionPath } from '../routes/appPaths'
import type { AssistantCardTagTone } from './Assistant.styles'
import { assistantMessages } from './assistantMessages'

/** 봇 말풍선 아래 알약 버튼 하나입니다. 누르면 [label]이 사용자 말풍선이 되고 [kind]에 따라 답을 만듭니다. */
export type AssistantQuickReply = {
  id: string
  label: string
  kind: 'topic' | 'help' | 'saved-programs' | 'received-proposals' | 'login-benefits' | 'contact' | 'other' | 'retry'
  /** `help`일 때 도움말 항목 id입니다. */
  helpId?: string
  /** `topic`일 때 주제 id입니다. */
  topicId?: string
  /** `retry`일 때 다시 보낼 질문입니다. */
  text?: string
}

/** 도움말 항목을 묶는 주제입니다. 어느 화면에서 열어도 같은 주제 목록이 먼저 나오고, 주제 → 질문 → 답 순서로 타고 들어갑니다. */
export type AssistantHelpTopic = { id: string; label: string; entryIds: readonly string[] }

export const assistantHelpTopics: readonly AssistantHelpTopic[] = [
  { id: 'search', label: '지원사업 검색', entryIds: ['search-confirm-card', 'search-score-meaning', 'eligibility-unknown', 'status-unknown-source', 'evidence-insufficient', 'search-slow-or-failed'] },
  { id: 'saved', label: '관심 공고·리포트', entryIds: ['saved-programs-pipeline', 'daily-report'] },
  { id: 'review', label: '중복 검토·신청 문서', entryIds: ['review-save-vs-run', 'review-input-revision', 'application-preparation-flow'] },
  { id: 'partner', label: '파트너·기업 등록', entryIds: ['partner-write-requires-company', 'proposal-box'] },
  { id: 'general', label: '기타 안내', entryIds: ['feature-status-preparing'] },
]

export function findAssistantHelpTopic(id: string): AssistantHelpTopic | undefined {
  return assistantHelpTopics.find((topic) => topic.id === id)
}

export type AssistantCardRow = {
  tag: { label: string; tone: AssistantCardTagTone } | null
  title: string
  detail: string | null
  /** 있으면 제목이 이 경로로 가는 링크가 됩니다. 에이전트 카드(모집글·공고 상세)에 씁니다. */
  to?: string
}

/** [external]이면 새 탭에서 바깥 주소를 엽니다. `searchQuery`가 있으면 이동하면서 검색 입력창에 그 문구를 미리 채웁니다. */
export type AssistantCardButton = { label: string; to: string; external?: boolean; searchQuery?: string }

/** 목록·버튼이 있는 답변입니다. 버튼은 화면 이동만 합니다. */
export type AssistantCard = {
  rows: AssistantCardRow[]
  buttons: AssistantCardButton[]
}

export type AssistantMessage =
  | { id: string; role: 'user'; text: string }
  | {
      id: string
      role: 'assistant'
      paragraphs: string[]
      card: AssistantCard | null
      /** "내 관심 공고함 기준"처럼 답의 근거를 시각 옆에 작게 적습니다. */
      source: string | null
      tone: 'normal' | 'warn'
      /** 이 답변 뒤에 붙일 빠른 답변입니다. 비어 있으면 화면 추천으로 돌아갑니다. */
      followUps: AssistantQuickReply[]
    }

export type AssistantSession = {
  isAuthenticated: boolean
  hasCompany: boolean
  /** 담당자 문의가 여는 카카오톡 채널 1:1 채팅 주소입니다. null이면 문의 항목을 두지 않습니다. */
  contactUrl: string | null
}

const DAY_MS = 86_400_000
const SOON_DAYS = 7

let sequence = 0
function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence}`
}

export function userMessage(text: string): AssistantMessage {
  return { id: nextId('u'), role: 'user', text }
}

function botMessage(
  paragraphs: string[],
  options: Partial<Omit<Extract<AssistantMessage, { role: 'assistant' }>, 'id' | 'role' | 'paragraphs'>> = {},
): AssistantMessage {
  return {
    id: nextId('a'),
    role: 'assistant',
    paragraphs,
    card: options.card ?? null,
    source: options.source ?? null,
    tone: options.tone ?? 'normal',
    followUps: options.followUps ?? [],
  }
}

/** 처음 열 때의 인사 두 마디입니다. */
export function greetingMessages(): AssistantMessage[] {
  return [
    botMessage([assistantMessages.greetingIntro, assistantMessages.greetingScope]),
    botMessage([assistantMessages.greetingAsk]),
  ]
}

function helpQuickReply(entry: HelpEntry): AssistantQuickReply {
  return { id: `help:${entry.id}`, label: entry.question, kind: 'help', helpId: entry.id }
}

export const contactQuickReply: AssistantQuickReply = { id: 'contact', label: assistantMessages.quickContact, kind: 'contact' }

/**
 * 처음 열었을 때와 "다른 주제"를 눌렀을 때의 빠른 답변입니다. 화면과 무관하게 도움말 주제 전부와 회원의 상태 질문을 둡니다.
 * 비로그인이면 상태 질문 대신 로그인 안내 하나를 둡니다. 카카오톡 채널이 설정돼 있으면 담당자 문의를 마지막에 둡니다.
 */
export function quickRepliesFor(session: AssistantSession): AssistantQuickReply[] {
  const topics = assistantHelpTopics.map<AssistantQuickReply>((topic) => ({ id: `topic:${topic.id}`, label: topic.label, kind: 'topic', topicId: topic.id }))
  const status: AssistantQuickReply[] = session.isAuthenticated
    ? [
        { id: 'status:saved-programs', label: assistantMessages.quickSavedPrograms, kind: 'saved-programs' },
        ...(session.hasCompany ? [{ id: 'status:received-proposals', label: assistantMessages.quickReceivedProposals, kind: 'received-proposals' as const }] : []),
      ]
    : [{ id: 'status:login-benefits', label: assistantMessages.quickLoginBenefits, kind: 'login-benefits' }]
  const contact = session.contactUrl === null ? [] : [contactQuickReply]
  return [...topics, ...status, ...contact]
}

export const otherQuestionReply: AssistantQuickReply = { id: 'other', label: assistantMessages.otherQuestion, kind: 'other' }

/** 주제를 고르면 그 주제의 질문들을 알약으로 보여 줍니다. 답은 짧게 한 줄입니다. */
export function topicAnswer(topic: AssistantHelpTopic): AssistantMessage {
  const questions = topic.entryIds
    .map((id) => findHelpEntry(id))
    .filter((entry): entry is HelpEntry => entry !== undefined)
    .map(helpQuickReply)
  return botMessage([assistantMessages.topicAsk(topic.label)], { followUps: [...questions, otherQuestionReply] })
}

/** 도움말 항목으로 답합니다. 결론 → 본문 첫 문단 → 지금 안 되는 것 → 행동 버튼. 준비 중·예시 항목은 그 사실을 함께 말합니다. */
export function helpAnswer(entry: HelpEntry, pathname: string): AssistantMessage {
  const inApp = isAppPath(pathname)
  const paragraphs = [entry.summary, ...entry.body.slice(0, 1)]
  if (entry.limitation !== null) paragraphs.push(entry.limitation)
  if (entry.status === 'planned') paragraphs.push(assistantMessages.helpPlanned)
  if (entry.status === 'demo') paragraphs.push(assistantMessages.helpDemo)
  const buttons: AssistantCardButton[] = entry.action === null
    ? []
    : [{ label: entry.action.label, to: helpActionHref(entry.action.to, inApp) }]
  const followUps = entry.related
    .map((id) => findHelpEntry(id))
    .filter((related): related is HelpEntry => related !== undefined)
    .slice(0, 2)
    .map(helpQuickReply)
  return botMessage(paragraphs, {
    card: buttons.length > 0 ? { rows: [], buttons } : null,
    source: assistantMessages.helpSource(entry.title),
    followUps: [...followUps, otherQuestionReply],
  })
}

/** 담당자 문의는 카카오톡 채널 1:1 채팅을 새 탭으로 엽니다. 대화는 이 도우미 밖에서 이어집니다. */
export function contactAnswer(contactUrl: string | null): AssistantMessage {
  return botMessage([assistantMessages.contactIntro], {
    card: contactUrl === null ? null : { rows: [], buttons: [{ label: assistantMessages.contactKakao, to: contactUrl, external: true }] },
    followUps: [otherQuestionReply],
  })
}

/** 주제·도움말 id가 맞지 않을 때의 안내입니다. */
export function freeTextFallback(): AssistantMessage {
  return botMessage([assistantMessages.freeTextPreparing])
}

/** 공고 상세·원문 질문 화면이면 URL의 복합 식별자를 돌려줍니다. 자유 질문의 `programSelected`와 원문 질문 버튼에 씁니다. */
export function programIdentityFrom(pathname: string, search: string): { sourceCode: string; sourceProgramId: string } | null {
  const path = pathname.replace(/\/+$/, '') || publicPaths.landing
  const detailPaths: string[] = [publicPaths.supportProgramDetail, publicPaths.supportProgramQuestion, appPaths.supportProgramDetail, appPaths.supportProgramQuestion]
  if (!detailPaths.includes(path)) return null
  const params = new URLSearchParams(search)
  const sourceCode = params.get('sourceCode')
  const sourceProgramId = params.get('sourceProgramId')
  if (!sourceCode || !sourceProgramId) return null
  return { sourceCode, sourceProgramId }
}

export type AssistantFreeTextContext = { pathname: string; search: string; session: AssistantSession; returnTo: string }

/** 에이전트 카드를 목록 행으로 바꿉니다. 종류 태그, 제목 링크, 부제와 고른 이유 한 줄입니다. */
function agentCardRows(cards: AssistantAnswerCard[], inApp: boolean): AssistantCardRow[] {
  return cards.map((card) => ({
    tag: { label: card.kind === 'RECRUITMENT' ? assistantMessages.cardRecruitment : assistantMessages.cardProgram, tone: 'ok' },
    title: card.title,
    detail: [card.subtitle, card.reason, card.quote === null ? null : assistantMessages.cardQuote(card.quote)].filter((part): part is string => part !== null).join(' · '),
    to: helpActionHref(card.to, inApp),
  }))
}

/**
 * Core가 검증한 자유 질문 답을 말풍선으로 바꿉니다. 의도별로 출처·버튼·후속 알약이 다릅니다.
 * UNCLEAR는 확인 질문 뒤에 주제 알약을 다시 보여 주고, 비로그인 상태 질문은 로그인 링크를 붙입니다.
 */
export function freeTextAnswer(answer: AssistantAnswer, context: AssistantFreeTextContext): AssistantMessage {
  const inApp = isAppPath(context.pathname)
  const navigation: AssistantCardButton | null = answer.navigation === null
    ? null
    : { label: answer.navigation.label, to: helpActionHref(answer.navigation.to, inApp) }
  const cardOf = (buttons: AssistantCardButton[], rows: AssistantCardRow[] = []): AssistantCard | null =>
    (buttons.length > 0 || rows.length > 0 ? { rows, buttons } : null)
  const agentRows = agentCardRows(answer.cards, inApp)
  const loginButtons: AssistantCardButton[] = [
    { label: assistantMessages.login, to: loginPathFor(context.returnTo) },
    { label: assistantMessages.signup, to: signupPathFor(context.returnTo) },
  ]

  switch (answer.intent) {
    case 'UNCLEAR':
      return botMessage([answer.clarificationQuestion ?? assistantMessages.greetingAsk], { followUps: quickRepliesFor(context.session) })
    case 'PRODUCT_HELP': {
      const cited = answer.citations.map((id) => findHelpEntry(id)).filter((entry): entry is HelpEntry => entry !== undefined)
      const first = cited[0]
      const related = (first?.related ?? [])
        .map((id) => findHelpEntry(id))
        .filter((entry): entry is HelpEntry => entry !== undefined)
        .slice(0, 2)
        .map(helpQuickReply)
      // 첫 인용 항목의 행동 버튼은 원본 도움말 그대로(질의 포함) 씁니다. 인용이 없을 때만 Core가 고른 경로를 씁니다.
      const helpButton: AssistantCardButton | null = first?.action
        ? { label: first.action.label, to: helpActionHref(first.action.to, inApp) }
        : navigation
      return botMessage([answer.answer ?? ''], {
        card: cardOf(helpButton === null ? [] : [helpButton]),
        source: first === undefined ? assistantMessages.aiSource : assistantMessages.helpSource(first.title),
        followUps: [...related, otherQuestionReply],
      })
    }
    case 'ACCOUNT_STATE': {
      const source = answer.accountTopic === 'SAVED_PROGRAMS'
        ? assistantMessages.savedSource
        : answer.accountTopic === 'RECEIVED_PROPOSALS' ? assistantMessages.proposalsSource : assistantMessages.profileSource
      return botMessage([answer.answer ?? ''], {
        card: cardOf(context.session.isAuthenticated ? (navigation === null ? [] : [navigation]) : loginButtons, context.session.isAuthenticated ? agentRows : []),
        source: context.session.isAuthenticated ? (agentRows.length > 0 ? assistantMessages.aiToolSource(source) : source) : null,
        followUps: [otherQuestionReply],
      })
    }
    case 'PARTNER_MATCH':
    case 'SAVED_PROGRAMS_QUESTION': {
      // 도구 에이전트의 답입니다. 비로그인이면 Core가 로그인 안내를 보내므로 로그인 버튼을 붙입니다.
      const basis = answer.intent === 'PARTNER_MATCH' ? assistantMessages.profileSource : assistantMessages.savedSource
      return botMessage([answer.answer ?? ''], {
        card: cardOf(context.session.isAuthenticated ? (navigation === null ? [] : [navigation]) : loginButtons, context.session.isAuthenticated ? agentRows : []),
        source: context.session.isAuthenticated ? assistantMessages.aiToolSource(basis) : null,
        followUps: [otherQuestionReply],
      })
    }
    case 'SEARCH':
      return botMessage([answer.answer ?? ''], {
        card: cardOf(navigation === null ? [] : [{ ...navigation, searchQuery: answer.searchQuery ?? undefined }]),
        followUps: [otherQuestionReply],
      })
    case 'PROGRAM_QUESTION': {
      const identity = programIdentityFrom(context.pathname, context.search)
      const button = navigation ?? (identity === null
        ? null
        : { label: assistantMessages.openProgramQuestion, to: supportProgramQuestionPath(identity, inApp) })
      return botMessage([answer.answer ?? ''], { card: cardOf(button === null ? [] : [button]), followUps: [otherQuestionReply] })
    }
    case 'OUT_OF_SCOPE':
      return botMessage([answer.answer ?? ''], { source: assistantMessages.aiSource, followUps: [otherQuestionReply] })
  }
}

/** 자유 질문에 답을 받지 못했을 때입니다. 같은 질문을 다시 보내는 알약을 붙입니다. */
export function freeTextFailure(text: string, message: string): AssistantMessage {
  return botMessage([message], {
    tone: 'warn',
    followUps: [{ id: 'retry', label: assistantMessages.retry, kind: 'retry', text }, otherQuestionReply],
  })
}

/** 비로그인이 상태 질문을 눌렀을 때입니다. 로그인 뒤 같은 화면으로 돌아옵니다. */
export function loginPromptAnswer(returnTo: string): AssistantMessage {
  return botMessage([assistantMessages.loginPrompt], {
    card: { rows: [], buttons: [{ label: assistantMessages.login, to: loginPathFor(returnTo) }, { label: assistantMessages.signup, to: signupPathFor(returnTo) }] },
  })
}

export function loginBenefitsAnswer(returnTo: string): AssistantMessage {
  return botMessage([assistantMessages.loginBenefits], {
    card: { rows: [], buttons: [{ label: assistantMessages.login, to: loginPathFor(returnTo) }, { label: assistantMessages.signup, to: signupPathFor(returnTo) }] },
    followUps: [otherQuestionReply],
  })
}

/** 서울 기준 오늘 0시입니다. */
function startOfSeoulDay(now: Date): number {
  const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth(), seoul.getUTCDate()) - 9 * 60 * 60 * 1000
}

/** YYYY-MM-DD까지 남은 날수입니다. 지난 날짜는 음수입니다. */
export function daysUntil(date: string, now: Date): number {
  return Math.round((Date.parse(`${date}T00:00:00+09:00`) - startOfSeoulDay(now)) / DAY_MS)
}

function deadlineTag(applicationEndDate: string | null, now: Date): AssistantCardRow['tag'] {
  if (applicationEndDate === null) return { label: '미정', tone: 'muted' }
  const remaining = daysUntil(applicationEndDate, now)
  if (Number.isNaN(remaining)) return { label: '미정', tone: 'muted' }
  if (remaining < 0) return { label: '마감', tone: 'muted' }
  if (remaining === 0) return { label: 'D-day', tone: 'hot' }
  return { label: `D-${remaining}`, tone: remaining <= 3 ? 'hot' : remaining <= SOON_DAYS ? 'soon' : 'ok' }
}

function monthDay(date: string): string {
  const [, month = '', day = ''] = date.split('-')
  return `${Number.parseInt(month, 10)}월 ${Number.parseInt(day, 10)}일`
}

/** 관심 공고를 마감 임박순으로 정리해 카드로 답합니다. 목록은 3개까지, 나머지는 버튼 문구로 셉니다. */
export function savedProgramsAnswer(saved: SavedSupportProgram[], now: Date): AssistantMessage {
  if (saved.length === 0) {
    return botMessage([assistantMessages.savedNone], {
      card: { rows: [], buttons: [{ label: assistantMessages.openSearch, to: appPaths.chat }] },
      source: assistantMessages.savedSource,
      followUps: [otherQuestionReply],
    })
  }
  const upcoming = saved
    .filter((item) => item.program.applicationEndDate === null || daysUntil(item.program.applicationEndDate, now) >= 0)
    .sort((a, b) => {
      const left = a.program.applicationEndDate
      const right = b.program.applicationEndDate
      if (left === right) return 0
      if (left === null) return 1
      if (right === null) return -1
      return left < right ? -1 : 1
    })
  const soon = upcoming.filter((item) => item.program.applicationEndDate !== null && daysUntil(item.program.applicationEndDate, now) <= SOON_DAYS).length
  const rows: AssistantCardRow[] = upcoming.slice(0, 3).map((item) => ({
    tag: deadlineTag(item.program.applicationEndDate, now),
    title: item.program.title,
    detail: item.program.applicationEndDate === null
      ? `${item.program.organization} · ${assistantMessages.savedDeadlineUnknown}`
      : `${item.program.organization} · ${monthDay(item.program.applicationEndDate)} 마감`,
  }))
  const buttons: AssistantCardButton[] = [{
    label: saved.length > 3 ? assistantMessages.savedOpenAll(saved.length) : assistantMessages.savedOpen,
    to: appPaths.savedPrograms,
  }]
  return botMessage([assistantMessages.savedSummary(saved.length, soon)], {
    card: { rows, buttons },
    source: assistantMessages.savedSource,
    followUps: [otherQuestionReply],
  })
}

/** 받은 제안함 상태로 답합니다. 수락·거절은 제안함 화면에서 하므로 여기서는 화면만 엽니다. */
export function receivedProposalsAnswer(
  view: { phase: 'loading' | 'ready' | 'failed'; proposals: PartnerProposal[]; pendingCount: number },
  session: AssistantSession,
): AssistantMessage {
  if (!session.hasCompany) {
    return botMessage([assistantMessages.proposalsNeedCompany], {
      card: { rows: [], buttons: [{ label: assistantMessages.openProfile, to: appPaths.profile }] },
      followUps: [otherQuestionReply],
    })
  }
  if (view.phase === 'loading') return botMessage([assistantMessages.proposalsLoading], { followUps: [otherQuestionReply] })
  if (view.phase === 'failed') {
    return botMessage([assistantMessages.proposalsFailed], {
      card: { rows: [], buttons: [{ label: assistantMessages.openProposals, to: appPaths.proposals }] },
      tone: 'warn',
      followUps: [otherQuestionReply],
    })
  }
  if (view.pendingCount === 0) {
    return botMessage([assistantMessages.proposalsNone], {
      card: { rows: [], buttons: [{ label: assistantMessages.openProposals, to: appPaths.proposals }] },
      source: assistantMessages.proposalsSource,
      followUps: [otherQuestionReply],
    })
  }
  const earliest = view.proposals
    .filter((proposal) => proposal.status === 'PENDING')
    .map((proposal) => proposal.expiresAt.slice(0, 10))
    .sort()[0] ?? null
  return botMessage([assistantMessages.proposalsSummary(view.pendingCount, earliest === null ? null : monthDay(earliest)), assistantMessages.proposalsHandled], {
    card: { rows: [], buttons: [{ label: assistantMessages.openProposals, to: appPaths.proposals }] },
    source: assistantMessages.proposalsSource,
    followUps: [otherQuestionReply],
  })
}

/** 로그인·회원가입처럼 도우미를 두지 않는 화면입니다. */
export function isAssistantHiddenOn(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || publicPaths.landing
  return [publicPaths.login, publicPaths.signup, publicPaths.oauthComplete, publicPaths.reportEmail, '/forgot-password', '/reset-password'].includes(path)
    || path.startsWith('/examples/')
}

/** 채팅 입력창이 아래에 있는 화면에서는 런처를 위로 올립니다. */
export function isComposerScreen(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || publicPaths.landing
  return path === publicPaths.landing || path === appPaths.chat
}
