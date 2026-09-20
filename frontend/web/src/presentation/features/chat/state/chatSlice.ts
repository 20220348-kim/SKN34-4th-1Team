import { createSelector, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'

import type { RootState } from '../../../../app/store'
import type { ChatConversationSnapshot, ChatMessage, ChatSearchOptions } from '../../../../domain/entities/ChatConversation'
import type { RestoredSupportProgramSearchResult, SupportProgramSearchResult } from '../../../../domain/entities/SupportProgramSearchResult'
import type { Company } from '../../../../domain/entities/Company'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramSearch } from '../../../../domain/repositories/SupportProgramRepository'
import type { SupportProgramConversationContext, SupportProgramInterpretation, SupportProgramInterpretRequest, SupportProgramLastSearch, SupportProgramPendingClarification } from '../../../../domain/entities/SupportProgramConversation'
import { sessionRestored, signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { formatSupportProgramEligibilityCounts } from '../supportProgramEligibility'

export type { ChatSearchOptions } from '../../../../domain/entities/ChatConversation'
export type SupportProgramChatMessage = ChatMessage

type ChatSearchStatus = 'idle' | 'pending' | 'failed'

/** 화면이 보지 않은 사이에 도착한 결과입니다. 채팅 화면이 열리면 `outcomeSeen`으로 지웁니다. */
export type ChatOutcome =
  | 'search-succeeded' | 'search-failed'
  | 'interpretation-ready' | 'interpretation-clarification' | 'interpretation-answered' | 'interpretation-failed'

type ChatInterpretation = {
  status: 'idle' | 'pending' | 'ready' | 'clarification' | 'failed'
  requestId?: string
  messageId?: string
  request?: SupportProgramInterpretRequest
  result?: SupportProgramInterpretation
  error?: string
}

type ChatState = {
  companyDefaultsInitialized: boolean
  accountEmail: string | null
  isRestoredHistory: boolean
  activeRequestId: string | null
  activeSearchContext: SupportProgramConversationContext | null
  lastSearch: SupportProgramLastSearch | null
  pendingProposal: SupportProgramConversationContext | null
  draft: string
  messages: SupportProgramChatMessage[]
  searchError: string | null
  searchStatus: ChatSearchStatus
  searchOptions: ChatSearchOptions
  conversationQuery: string | null
  interpretation: ChatInterpretation
  pendingClarification: SupportProgramPendingClarification | null
  confirmedSearch: SupportProgramSearch | null
  unseenOutcome: ChatOutcome | null
}

/** Core API의 query 최대 길이 계약과 일치합니다. */
export const maximumSupportProgramSearchQueryLength = 500

const initialState: ChatState = createInitialState()

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    companyDefaultsLoaded(state, action: PayloadAction<{ requestId: string; company: Company | null }>) {
      if (state.interpretation.status !== 'pending' || state.interpretation.requestId !== action.payload.requestId) return
      const company = action.payload.company
      const current = state.searchOptions.companyConditions
      if (company) {
        state.searchOptions.companyConditions = {
          region: company.region, industry: company.industry,
          ...(current?.establishedOn ? {} : { foundedYear: company.foundedYear }),
          ...current,
        }
      }
      state.companyDefaultsInitialized = true
      if (state.interpretation.request) {
        state.interpretation.request.context = searchOptionsToConversationContext(state.conversationQuery, state.searchOptions)
      }
    },
    conversationHistoryOpened(state, action: PayloadAction<{ accountEmail: string; snapshot: ChatConversationSnapshot }>) {
      if (!state.accountEmail || state.accountEmail !== action.payload.accountEmail) return
      const { schemaVersion: _version, ...snapshot } = action.payload.snapshot
      return { ...createInitialState(), ...snapshot, accountEmail: state.accountEmail, isRestoredHistory: true, companyDefaultsInitialized: snapshot.companyDefaultsInitialized ?? true }
    },
    conversationReset: {
      reducer(state, action: PayloadAction<{ welcomeMessage: SupportProgramChatMessage }>) {
        return { ...createInitialState(action.payload.welcomeMessage), accountEmail: state.accountEmail }
      },
      prepare() {
        return { payload: { welcomeMessage: createWelcomeMessage() } }
      },
    },
    searchResultRestored: {
      reducer(state, action: PayloadAction<{ result: RestoredSupportProgramSearchResult; welcomeMessage: SupportProgramChatMessage;
        questionId: string; answerId: string }>) {
        const { result, welcomeMessage, questionId, answerId } = action.payload
        const next = createInitialState(welcomeMessage)
        next.companyDefaultsInitialized = true
        next.accountEmail = state.accountEmail
        next.conversationQuery = result.context.query
        next.searchOptions = conversationContextToSearchOptions(result.context)
        next.confirmedSearch = result.context.query ? { query: result.context.query, ...copySearchOptions(next.searchOptions) } : null
        next.lastSearch = { context: result.context, resultCount: result.totalCount }
        next.messages.push({ id: questionId, role: 'user', text: result.query || '최신 지원사업',
          searchQuery: result.query, searchOptions: copySearchOptions(next.searchOptions) })
        next.messages.push({ id: answerId, role: 'assistant', programs: result.programs, totalCount: result.totalCount,
          resultToken: result.resultToken, expiresAt: result.expiresAt, searchQuery: result.query,
          searchOptions: copySearchOptions(next.searchOptions),
          text: createSearchResponseText(result.programs, result.context.acceptingOnly, result.totalCount) })
        return next
      },
      prepare(result: RestoredSupportProgramSearchResult) {
        return { payload: { result, welcomeMessage: createWelcomeMessage(), questionId: nanoid(), answerId: nanoid() } }
      },
    },
    searchResultRestoreFailed: {
      reducer(state, action: PayloadAction<{ messageId: string; message: string }>) {
        state.messages.push({ id: action.payload.messageId, role: 'assistant', text: action.payload.message })
      },
      prepare(message: string) { return { payload: { messageId: nanoid(), message } } },
    },
    draftChanged(state, action: PayloadAction<string>) {
      if (state.interpretation.status === 'pending') return
      state.draft = action.payload
      state.searchError = null
      // 작성 중인 후속 메시지와 이미 해석한 조건 제안은 별개로 유지합니다.
      if (state.interpretation.status === 'failed') {
        state.interpretation = { status: 'idle' }
      }
    },
    interpretationStarted: {
      reducer(state, action: PayloadAction<{ requestId: string; messageId: string; request: SupportProgramInterpretRequest }>) {
        if (isBusy(state)) return
        state.interpretation = { status: 'pending', ...action.payload }
        state.unseenOutcome = null
        state.draft = ''
        state.searchError = null
        state.searchStatus = 'idle'
        if (!state.messages.some((message) => message.id === action.payload.messageId)) {
          state.messages.push({ id: action.payload.messageId, role: 'user', text: action.payload.request.message })
        }
      },
      prepare(request: SupportProgramInterpretRequest, messageId = nanoid()) {
        return { payload: { requestId: nanoid(), messageId, request } }
      },
    },
    interpretationSucceeded(state, action: PayloadAction<{ requestId: string; result: SupportProgramInterpretation }>) {
      if (state.interpretation.status !== 'pending' || state.interpretation.requestId !== action.payload.requestId) return
      if (action.payload.result.status === 'ANSWERED') {
        state.messages.push({ id: `${action.payload.requestId}-answer`, role: 'assistant', text: action.payload.result.answer! })
        state.interpretation = { status: 'idle' }
        state.unseenOutcome = 'interpretation-answered'
        return
      }
      state.interpretation.status = action.payload.result.status === 'READY' ? 'ready' : 'clarification'
      state.unseenOutcome = action.payload.result.status === 'READY' ? 'interpretation-ready' : 'interpretation-clarification'
      state.interpretation.result = action.payload.result
      if (action.payload.result.status === 'CLARIFICATION_REQUIRED') {
        state.pendingProposal = null
        state.pendingClarification = {
          question: action.payload.result.clarificationQuestion!,
          draftContext: action.payload.result.proposedContext,
        }
      } else {
        state.pendingClarification = null
        state.pendingProposal = action.payload.result.proposedContext
      }
    },
    interpretationFailed(state, action: PayloadAction<{ requestId: string; message: string }>) {
      if (state.interpretation.status !== 'pending' || state.interpretation.requestId !== action.payload.requestId) return
      state.interpretation.status = 'failed'
      state.interpretation.error = action.payload.message
      state.unseenOutcome = 'interpretation-failed'
      state.messages.push({ id: `${action.payload.requestId}-failure`, role: 'assistant',
        text: action.payload.message, failure: 'interpretation' })
      if (!state.draft.trim()) state.draft = state.interpretation.request?.message ?? ''
    },
    interpretationCancelled(state, action: PayloadAction<string>) {
      if (state.interpretation.status !== 'pending' || state.interpretation.requestId !== action.payload) return
      if (!state.draft.trim()) state.draft = state.interpretation.request?.message ?? ''
      state.interpretation = { status: 'idle' }
    },
    interpretationDismissed(state) {
      if (!state.draft.trim()) state.draft = state.interpretation.request?.message ?? ''
      state.interpretation = { status: 'idle' }
      state.pendingClarification = null
      state.pendingProposal = null
    },
    proposalConfirmed(state, action: PayloadAction<string>) {
      const proposal = state.interpretation
      if (state.draft.trim() || proposal.status !== 'ready' || proposal.requestId !== action.payload || !proposal.result?.proposedContext.query) return
      const context = proposal.result.proposedContext
      state.conversationQuery = context.query!.trim()
      state.searchOptions = conversationContextToSearchOptions(context)
      state.confirmedSearch = { query: state.conversationQuery, ...copySearchOptions(state.searchOptions) }
      state.pendingClarification = null
      state.pendingProposal = null
      state.interpretation = { status: 'idle' }
    },
    searchCancelled(state, action: PayloadAction<{ query: string; requestId: string }>) {
      if (state.activeRequestId !== action.payload.requestId) return
      state.activeRequestId = null
      state.activeSearchContext = null
      if (state.draft.trim().length === 0) {
        state.draft = action.payload.query
      }
      state.searchError = null
      state.searchStatus = 'idle'
    },
    searchFailed(state, action: PayloadAction<{ query: string; requestId: string; message?: string }>) {
      if (state.activeRequestId !== action.payload.requestId) return
      state.activeRequestId = null
      state.activeSearchContext = null
      if (state.draft.trim().length === 0) {
        state.draft = action.payload.query
      }
      state.searchError = action.payload.message ?? '지원사업을 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      state.searchStatus = 'failed'
      state.unseenOutcome = 'search-failed'
      state.messages.push({ id: `${action.payload.requestId}-failure`, role: 'assistant',
        text: state.searchError, failure: 'search' })
    },
    searchTimedOut(state, action: PayloadAction<{ query: string; requestId: string }>) {
      if (state.activeRequestId !== action.payload.requestId) return
      state.activeRequestId = null
      state.activeSearchContext = null
      if (state.draft.trim().length === 0) {
        state.draft = action.payload.query
      }
      state.searchError = '검색 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
      state.searchStatus = 'failed'
      state.unseenOutcome = 'search-failed'
      state.messages.push({ id: `${action.payload.requestId}-failure`, role: 'assistant',
        text: state.searchError, failure: 'search' })
    },
    /** 채팅 화면이 결과를 보여 주었습니다. 배지·알림을 지웁니다. */
    outcomeSeen(state) {
      state.unseenOutcome = null
    },
    searchValidationFailed(state, action: PayloadAction<{ queryLength: number }>) {
      if (state.searchStatus === 'pending') return
      state.searchError = `검색어는 ${maximumSupportProgramSearchQueryLength}자 이하로 입력해 주세요. 현재 ${action.payload.queryLength}자입니다.`
      state.searchStatus = 'idle'
    },
    searchStarted: {
      reducer(
        state,
        action: PayloadAction<{ messageId: string; query: string; requestId: string; searchOptions?: ChatSearchOptions }>,
      ) {
        if (state.searchStatus === 'pending') return
        state.activeRequestId = action.payload.requestId
        state.lastSearch = null
        // 재시도는 실패한 검색만 다시 보내며, 작성 중인 다른 초안은 보존합니다.
        if (state.searchStatus !== 'failed' || state.draft.trim() === action.payload.query) {
          state.draft = ''
        }
        const existingMessage = state.messages.find((message) => message.id === action.payload.messageId)
        const snapshot = copySearchOptions(action.payload.searchOptions ?? state.searchOptions)
        state.activeSearchContext = searchOptionsToConversationContext(action.payload.query, snapshot)
        state.unseenOutcome = null
        if (existingMessage) {
          existingMessage.searchOptions = snapshot
          existingMessage.searchQuery = action.payload.query
        } else state.messages.push({ id: action.payload.messageId, role: 'user', text: action.payload.query,
          searchOptions: snapshot, searchQuery: action.payload.query })
        state.searchError = null
        state.searchStatus = 'pending'
      },
      prepare(query: string, searchOptions?: ChatSearchOptions, messageId = nanoid()) {
        return {
          payload: {
            messageId,
            query,
            requestId: nanoid(),
            searchOptions,
          },
        }
      },
    },
    searchSucceeded: {
      reducer(
        state,
        action: PayloadAction<Omit<SupportProgramSearchResult, 'query'> & { messageId: string; requestId: string }>,
      ) {
        if (state.activeRequestId !== action.payload.requestId || !state.activeSearchContext) return
        const context = state.activeSearchContext
        state.lastSearch = { context, resultCount: action.payload.totalCount }
        state.activeRequestId = null
        state.activeSearchContext = null
        state.messages.push({
          id: action.payload.messageId,
          role: 'assistant',
          text: createSearchResponseText(action.payload.programs, context.acceptingOnly, action.payload.totalCount),
          programs: action.payload.programs,
          totalCount: action.payload.totalCount,
          resultToken: action.payload.resultToken,
          expiresAt: action.payload.expiresAt,
          searchOptions: conversationContextToSearchOptions(context),
          searchQuery: context.query ?? undefined,
        })
        state.searchError = null
        state.searchStatus = 'idle'
        state.unseenOutcome = 'search-succeeded'
      },
      prepare(payload: Omit<SupportProgramSearchResult, 'query'> & { requestId: string }) {
        return {
          payload: {
            ...payload,
            messageId: nanoid(),
          },
        }
      },
    },
  },
  extraReducers: (builder) => {
    // 같은 계정의 프로필 갱신은 보존하고, 로그아웃·계정 변경에는 대화와 요청 ID를 함께 비웁니다.
    builder
      .addCase(signedOut, () => initialState)
      .addCase(signedIn, (state, action) => state.accountEmail === action.payload.email
        ? state : { ...initialState, accountEmail: action.payload.email })
      .addCase(sessionRestored, (state, action) => state.accountEmail === (action.payload?.email ?? null)
        ? state : { ...initialState, accountEmail: action.payload?.email ?? null })
  },
})

export const {
  companyDefaultsLoaded,
  conversationHistoryOpened,
  conversationReset,
  searchResultRestored,
  searchResultRestoreFailed,
  draftChanged,
  interpretationStarted,
  interpretationSucceeded,
  interpretationFailed,
  interpretationDismissed,
  interpretationCancelled,
  outcomeSeen,
  proposalConfirmed,
  searchCancelled,
  searchFailed,
  searchStarted,
  searchSucceeded,
  searchTimedOut,
  searchValidationFailed,
} = chatSlice.actions

export const selectChatState = (state: RootState) => state.chat
export const selectChatDraft = (state: RootState) => state.chat.draft
export const selectChatMessages = (state: RootState) => state.chat.messages
export const selectChatSearchError = (state: RootState) => state.chat.searchError
export const selectCanRetryChatSearch = (state: RootState) => state.chat.searchStatus === 'failed' && state.chat.confirmedSearch !== null
export const selectIsChatSearching = (state: RootState) => state.chat.searchStatus === 'pending'
export const selectChatUnseenOutcome = (state: RootState) => state.chat.unseenOutcome

/** 채팅 화면 밖에서 보여 줄 진행 상태입니다. 진행 중이면 그 종류를, 아니면 아직 보지 않은 결과를 알립니다. */
export type ChatActivity =
  | { kind: 'searching' }
  | { kind: 'interpreting' }
  | { kind: 'unseen'; outcome: ChatOutcome; resultCount: number | null }
export const selectChatActivity = createSelector(
  [(state: RootState) => state.chat.searchStatus, (state: RootState) => state.chat.interpretation.status,
    selectChatUnseenOutcome, (state: RootState) => state.chat.lastSearch?.resultCount ?? null],
  (searchStatus, interpretationStatus, unseenOutcome, resultCount): ChatActivity | null => {
    if (searchStatus === 'pending') return { kind: 'searching' }
    if (interpretationStatus === 'pending') return { kind: 'interpreting' }
    if (unseenOutcome !== null) return { kind: 'unseen', outcome: unseenOutcome, resultCount: unseenOutcome === 'search-succeeded' ? resultCount : null }
    return null
  },
)
export const selectConversationCount = createSelector(
  [selectChatMessages],
  (messages) => messages.filter((message) => message.role === 'user').length,
)
export const selectIsReadyToSubmit = createSelector(
  [selectChatDraft, selectChatState],
  (draft, state) => draft.trim().length > 0 && !isBusy(state),
)

export default chatSlice.reducer

/** 요청 중인 기록을 열어도 존재하지 않는 로딩을 복원하거나 AI를 자동 재호출하지 않습니다. */
export function createChatConversationSnapshot(state: ChatState): ChatConversationSnapshot {
  const interrupted = state.interpretation.status === 'pending' ? {
    id: `${state.interpretation.requestId}-interrupted`, role: 'assistant' as const, failure: 'interpretation' as const,
    text: '완료되지 않은 메시지입니다. 다시 해석해 주세요.',
  } : state.searchStatus === 'pending' ? {
    id: `${state.activeRequestId}-interrupted`, role: 'assistant' as const, failure: 'search' as const,
    text: '완료되지 않은 검색입니다. 확인한 조건으로 다시 검색해 주세요.',
  } : null
  return {
    schemaVersion: 1, companyDefaultsInitialized: state.companyDefaultsInitialized, messages: interrupted ? [...state.messages, interrupted] : state.messages, searchOptions: state.searchOptions,
    conversationQuery: state.conversationQuery, confirmedSearch: state.confirmedSearch, lastSearch: state.lastSearch,
    pendingProposal: state.pendingProposal, pendingClarification: state.pendingClarification,
    searchStatus: state.searchStatus === 'pending' ? 'failed' : state.searchStatus,
    searchError: state.searchStatus === 'pending' ? '완료되지 않은 검색입니다. 확인한 조건으로 다시 검색해 주세요.' : state.searchError,
    interpretation: state.interpretation.status === 'pending'
      ? { ...state.interpretation, status: 'failed', error: '완료되지 않은 메시지입니다. 다시 해석해 주세요.' }
      : { ...state.interpretation, status: state.interpretation.status },
  }
}

function createInitialState(welcomeMessage = createWelcomeMessage()): ChatState {
  return {
    companyDefaultsInitialized: false,
    accountEmail: null,
    isRestoredHistory: false,
    activeRequestId: null,
    activeSearchContext: null,
    lastSearch: null,
    pendingProposal: null,
    draft: '',
    messages: [welcomeMessage],
    searchError: null,
    searchStatus: 'idle',
    searchOptions: { acceptingOnly: true },
    conversationQuery: null,
    interpretation: { status: 'idle' },
    pendingClarification: null,
    confirmedSearch: null,
    unseenOutcome: null,
  }
}

function createWelcomeMessage(): SupportProgramChatMessage {
  return {
    id: nanoid(),
    role: 'assistant',
    text: '안녕하세요. GovBiz가 현재 접수 중인 정부지원사업을 찾아드릴게요. 지역이나 업종을 포함해 편하게 말씀해 주세요.',
  }
}

function createSearchResponseText(programs: SupportProgram[], acceptingOnly: boolean, totalCount: number) {
  if (totalCount > programs.length) return `추천 결과 ${totalCount}건 중 ${programs.length}건을 먼저 보여드릴게요. 표시된 공고 기준으로 ${formatSupportProgramEligibilityCounts(programs)}입니다. 회원가입 또는 로그인하면 추가 결과를 확인할 수 있어요. 최종 신청 자격은 원문을 확인해 주세요.`
  return programs.length > 0
    ? `${acceptingOnly ? '현재 접수 중인 공고에서' : '접수 상태 전체에서'} ${formatSupportProgramEligibilityCounts(programs)}을 찾았습니다. 조건 확인은 공식 API 본문 기준이며 최종 신청 자격을 보장하지 않습니다. 확인 필요 공고는 원문 조건을 추가로 확인해 주세요.`
    : '현재 일치하는 공고를 찾지 못했습니다. 지역이나 분야를 바꿔 다시 검색해 보세요.'
}

function copySearchOptions(options: ChatSearchOptions): ChatSearchOptions {
  return {
    acceptingOnly: options.acceptingOnly,
    ...(options.companyConditions ? { companyConditions: { ...options.companyConditions } } : {}),
  }
}

export function conversationContextToSearchOptions(context: SupportProgramConversationContext): ChatSearchOptions {
  const companyConditions = Object.fromEntries(Object.entries(context.companyConditions).filter(([, value]) => value != null))
  return { acceptingOnly: context.acceptingOnly,
    ...(Object.keys(companyConditions).length ? { companyConditions } : {}) }
}

export function selectConversationContext(state: RootState): SupportProgramConversationContext {
  return searchOptionsToConversationContext(state.chat.conversationQuery, state.chat.searchOptions)
}

function searchOptionsToConversationContext(query: string | null, options: ChatSearchOptions): SupportProgramConversationContext {
  const conditions = options.companyConditions
  return {
    query,
    acceptingOnly: options.acceptingOnly,
    companyConditions: { region: conditions?.region ?? null, industry: conditions?.industry ?? null,
      ...(conditions?.foundedYear != null ? { foundedYear: conditions.foundedYear } : {}),
      establishedOn: conditions?.establishedOn ?? null, supportPurpose: conditions?.supportPurpose ?? null },
  }
}

function isBusy(state: ChatState) {
  return state.searchStatus === 'pending' || state.interpretation.status === 'pending'
}
