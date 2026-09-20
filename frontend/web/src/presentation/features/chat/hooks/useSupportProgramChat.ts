import { useEffect } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import type { AppDispatch, AppThunkExtra, RootState } from '../../../../app/store'
import type { RestoreSupportProgramSearchUseCase } from '../../../../domain/usecases/RestoreSupportProgramSearchUseCase'
import { SupportProgramSearchRestoreError } from '../../../../domain/errors/SupportProgramSearchRestoreError'
import type { SearchSupportProgramsUseCase } from '../../../../domain/usecases/SearchSupportProgramsUseCase'
import type { GetMyCompanyUseCase } from '../../../../domain/usecases/CompanyUseCases'
import type { InterpretSupportProgramConversationUseCase } from '../../../../domain/usecases/InterpretSupportProgramConversationUseCase'
import type { SupportProgramConversationContext, SupportProgramInterpretRequest } from '../../../../domain/entities/SupportProgramConversation'
import type { SupportProgramSearch } from '../../../../domain/repositories/SupportProgramRepository'
import { SupportProgramRequestError } from '../../../../domain/errors/SupportProgramRequestError'
import { SupportProgramInterpretationError } from '../../../../domain/errors/SupportProgramInterpretationError'
import { SupportProgramSearchTimeoutError } from '../../../../domain/errors/SupportProgramSearchTimeoutError'
import { supportProgramRequestFailureMessage } from '../../../shared/support-program/supportProgramRequestFailureMessage'
import {
  companyDefaultsLoaded,
  conversationReset,
  draftChanged,
  interpretationStarted,
  interpretationSucceeded,
  interpretationFailed,
  interpretationDismissed,
  interpretationCancelled,
  outcomeSeen,
  proposalConfirmed,
  selectConversationContext,
  maximumSupportProgramSearchQueryLength,
  searchCancelled,
  searchFailed,
  searchStarted,
  searchSucceeded,
  searchTimedOut,
  searchValidationFailed,
  selectCanRetryChatSearch,
  selectChatDraft,
  selectChatMessages,
  selectChatSearchError,
  selectChatState,
  selectConversationCount,
  selectChatUnseenOutcome,
  selectIsChatSearching,
  selectIsReadyToSubmit,
} from '../state/chatSlice'

export const supportProgramChatSuggestions = [
  '서울 AI 창업지원 사업 찾아줘',
  '현재 접수 중인 수출 지원사업 알려줘',
  '제조기업 R&D 사업을 찾아줘',
]

/** 순차 의미 검색(30초)·점수화(55초)에 여유를 두고 검색 요청 시간을 제한합니다. */
export const supportProgramSearchTimeoutMilliseconds = 90_000
export const supportProgramInterpretationTimeoutMilliseconds = 40_000

type SupportProgramSearchUseCase = Pick<SearchSupportProgramsUseCase, 'execute'>

/**
 * 채팅의 Redux 상태를 읽고 검색·해석 요청을 시작·취소하는 내부 훅입니다. 진행 중인 HTTP 요청은 이 훅이 아니라
 * 스토어의 `ChatRequestRegistry`가 쥐고 있어 화면을 떠나도 끊기지 않고, 결과는 Redux로 돌아옵니다.
 */
export function useSupportProgramChat(
  searchSupportProgramsUseCase: SupportProgramSearchUseCase = appContainer.resolve('searchSupportProgramsUseCase'),
  interpretConversationUseCase: Pick<InterpretSupportProgramConversationUseCase, 'execute'> = appContainer.resolve('interpretSupportProgramConversationUseCase'),
  restoreSearchUseCase: Pick<RestoreSupportProgramSearchUseCase, 'execute'> = appContainer.resolve('restoreSupportProgramSearchUseCase'),
  getMyCompanyUseCase: Pick<GetMyCompanyUseCase, 'execute'> = appContainer.resolve('getMyCompanyUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const conversationCount = useAppSelector(selectConversationCount)
  const draft = useAppSelector(selectChatDraft)
  const isReadyToSubmit = useAppSelector(selectIsReadyToSubmit)
  const isSearching = useAppSelector(selectIsChatSearching)
  const messages = useAppSelector(selectChatMessages)
  const isRestoredHistory = useAppSelector((state) => state.chat.isRestoredHistory)
  const canRetrySearch = useAppSelector(selectCanRetryChatSearch)
  const searchError = useAppSelector(selectChatSearchError)
  const inputError = useAppSelector((state) => state.chat.searchStatus === 'failed' ? null : state.chat.searchError)
  const searchOptions = useAppSelector((state) => state.chat.searchOptions)
  const interpretation = useAppSelector((state) => state.chat.interpretation)
  const pendingClarification = useAppSelector((state) => state.chat.pendingClarification)
  const conversationQuery = useAppSelector((state) => state.chat.conversationQuery)
  const confirmedContext: SupportProgramConversationContext = {
    query: conversationQuery, acceptingOnly: searchOptions.acceptingOnly,
    companyConditions: { region: searchOptions.companyConditions?.region ?? null,
      ...(searchOptions.companyConditions?.foundedYear != null ? { foundedYear: searchOptions.companyConditions.foundedYear } : {}),
      industry: searchOptions.companyConditions?.industry ?? null,
      establishedOn: searchOptions.companyConditions?.establishedOn ?? null,
      supportPurpose: searchOptions.companyConditions?.supportPurpose ?? null },
  }
  const isInterpreting = interpretation.status === 'pending'
  const unseenOutcome = useAppSelector(selectChatUnseenOutcome)
  const searchRequestId = useAppSelector((state) => state.chat.activeRequestId)

  useEffect(() => {
    // 로그아웃·계정 변경으로 Redux의 요청이 초기화되면 스토어가 쥔 이전 요청을 끊습니다. 앱 최상단의 useChatRequestLifecycle과 같은 규칙입니다.
    dispatchToStore((_dispatch: AppDispatch, _getState: () => RootState, requests: AppThunkExtra) => {
      if (requests.search && requests.search.requestId !== searchRequestId) requests.takeSearch()
      if (requests.interpretation && requests.interpretation.requestId !== (interpretation.requestId ?? null)) requests.takeInterpretation()
    })
  }, [dispatchToStore, searchRequestId, interpretation.requestId])

  // 이 화면이 열려 있으면 도착한 결과는 바로 본 것입니다. 배지·알림을 지웁니다.
  useEffect(() => {
    if (unseenOutcome !== null) dispatchToStore(outcomeSeen())
  }, [dispatchToStore, unseenOutcome])

  function startNewConversation() {
    dispatchToStore((dispatch: AppDispatch, _getState: () => RootState, requests: AppThunkExtra) => {
      requests.takeInterpretation()
      requests.takeSearch()
      dispatch(conversationReset())
    })
  }

  function cancelSearch() {
    dispatchToStore((dispatch: AppDispatch, _getState: () => RootState, requests: AppThunkExtra) => {
      if (requests.interpretation) {
        cancelInterpretation()
        return
      }
      const currentRequest = requests.takeSearch()
      if (!currentRequest) return
      dispatch(searchCancelled({ query: currentRequest.query ?? '', requestId: currentRequest.requestId }))
    })
  }

  function cancelInterpretation() {
    dispatchToStore((dispatch: AppDispatch, _getState: () => RootState, requests: AppThunkExtra) => {
      const current = requests.takeInterpretation()
      dispatch(current ? interpretationCancelled(current.requestId) : interpretationDismissed())
    })
  }

  function selectSuggestion(suggestion: string) {
    dispatchToStore(draftChanged(suggestion))
  }

  function updateDraft(value: string) {
    dispatchToStore(draftChanged(value))
  }

  function runSearch(command: SupportProgramSearch, messageId?: string) {
    async function runSupportProgramSearch(
      dispatchAction: AppDispatch,
      readCurrentState: () => RootState,
      requests: AppThunkExtra,
    ): Promise<void> {
      const currentState = readCurrentState()
      const currentChatState = selectChatState(currentState)
      const accountEmail = currentState.auth.status === 'authenticated' ? currentState.auth.account?.email : null
      const searchQuery = command.query.trim()

      if (searchQuery.length === 0) return
      if (currentChatState.searchStatus === 'pending' || currentChatState.interpretation.status === 'pending') return
      if (searchQuery.length > maximumSupportProgramSearchQueryLength) {
        dispatchAction(searchValidationFailed({ queryLength: searchQuery.length }))
        return
      }

      const searchStartedAction = searchStarted(searchQuery, {
        acceptingOnly: command.acceptingOnly ?? true,
        companyConditions: command.companyConditions,
      }, messageId)
      const requestController = new AbortController()
      const requestId = searchStartedAction.payload.requestId

      dispatchAction(searchStartedAction)
      const timeoutId = setTimeout(() => {
        if (requests.search?.requestId !== requestId) return

        requests.search = null
        dispatchAction(searchTimedOut({ query: searchQuery, requestId }))
        requestController.abort()
      }, supportProgramSearchTimeoutMilliseconds)
      requests.search = {
        controller: requestController,
        query: searchQuery,
        requestId,
        timeoutId,
      }

      try {
        let searchResult = await searchSupportProgramsUseCase.execute(
          { ...command, query: searchQuery },
          requestController.signal,
        )

        if (requestController.signal.aborted || readCurrentState().chat.activeRequestId !== requestId) return

        // 회원 화면에 비회원 미리보기가 도착해도 잠금으로 확정하지 않습니다.
        // 같은 결과 토큰을 서버 세션으로 복원하므로 검색·모델 호출을 반복하지 않습니다.
        const latestAuth = readCurrentState().auth
        if (accountEmail && latestAuth.status === 'authenticated'
          && latestAuth.account?.email === accountEmail && searchResult.resultToken) {
          const restored = await restoreSearchUseCase.execute(searchResult.resultToken, requestController.signal)
          if (restored.query !== searchResult.query) throw new SupportProgramSearchRestoreError('unavailable')
          searchResult = restored
        }

        if (requestController.signal.aborted || readCurrentState().chat.activeRequestId !== requestId) return

        const searchSucceededAction = searchSucceeded({
          programs: searchResult.programs,
          totalCount: searchResult.totalCount,
          resultToken: searchResult.resultToken,
          expiresAt: searchResult.expiresAt,
          requestId,
        })
        dispatchAction(searchSucceededAction)
      } catch (error) {
        if (requestController.signal.aborted) return

        const searchFailedAction = searchFailed({
          query: searchQuery,
          requestId,
          message: error instanceof SupportProgramSearchRestoreError
            ? error.reason === 'unauthorized'
              ? '로그인 상태를 확인하지 못했습니다. 새로고침한 뒤 다시 로그인해 주세요.'
              : error.message
            : error instanceof SupportProgramRequestError
              ? supportProgramRequestFailureMessage(error)
              : error instanceof SupportProgramSearchTimeoutError
                ? '서버의 지원사업 검색 시간이 초과되었습니다. 확인한 조건으로 다시 검색해 주세요.'
                : undefined,
        })
        dispatchAction(searchFailedAction)
      } finally {
        requests.releaseSearch(requestId)
      }
    }

    return dispatchToStore(runSupportProgramSearch)
  }

  function runInterpretation(request: SupportProgramInterpretRequest, messageId?: string) {
    return dispatchToStore(async (dispatch: AppDispatch, getState: () => RootState, requests: AppThunkExtra) => {
      const state = getState().chat
      if (state.searchStatus === 'pending' || state.interpretation.status === 'pending') return
      const started = interpretationStarted(request, messageId)
      const requestId = started.payload.requestId
      const controller = new AbortController()
      dispatch(started)
      const timeoutId = setTimeout(() => {
        if (requests.interpretation?.requestId !== requestId) return
        requests.interpretation = null
        dispatch(interpretationFailed({ requestId, message: '조건 해석 시간이 초과되었습니다. 다시 해석해 주세요.' }))
        controller.abort()
      }, supportProgramInterpretationTimeoutMilliseconds)
      requests.interpretation = { controller, requestId, timeoutId }
      let loadingCompany = false
      try {
        if (!state.companyDefaultsInitialized) {
          const account = getState().auth.account
          loadingCompany = Boolean(account?.company)
          const company = loadingCompany ? await getMyCompanyUseCase.execute(controller.signal) : null
          if (controller.signal.aborted || getState().chat.interpretation.requestId !== requestId) return
          if (loadingCompany && !company) throw new Error('Registered company is unavailable')
          dispatch(companyDefaultsLoaded({ requestId, company }))
          loadingCompany = false
        }
        const effectiveRequest = getState().chat.interpretation.request
        if (!effectiveRequest || controller.signal.aborted) return
        const result = await interpretConversationUseCase.execute(effectiveRequest, controller.signal)
        if (!controller.signal.aborted) dispatch(interpretationSucceeded({ requestId, result }))
      } catch (error) {
        if (!controller.signal.aborted) dispatch(interpretationFailed({ requestId, message:
          loadingCompany ? '등록된 기업 정보를 불러오지 못했습니다. 다시 해석해 주세요.'
            : error instanceof SupportProgramRequestError ? supportProgramRequestFailureMessage(error)
            : error instanceof SupportProgramInterpretationError
              ? error.reason === 'timeout'
                ? '조건 해석 응답이 지연되어 시간이 초과되었습니다. 잠시 후 다시 해석해 주세요.'
                : '조건 해석 서비스를 일시적으로 이용할 수 없습니다. 잠시 후 다시 해석해 주세요.'
              : '메시지의 조건 변경을 해석하지 못했습니다. 다시 해석해 주세요.',
        }))
      } finally {
        requests.releaseInterpretation(requestId)
      }
    })
  }

  function submitMessage() {
    return dispatchToStore((_dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
      const state = getState()
      const message = state.chat.draft
      if (!message.trim() || state.chat.searchStatus === 'pending' || state.chat.interpretation.status === 'pending') return Promise.resolve()
      if (message.length > maximumSupportProgramSearchQueryLength) {
        dispatchToStore(searchValidationFailed({ queryLength: message.length }))
        return Promise.resolve()
      }
      return runInterpretation({ message, context: selectConversationContext(state),
        pendingClarification: state.chat.pendingClarification,
        ...(!state.chat.pendingClarification && state.chat.pendingProposal ? { pendingProposal: state.chat.pendingProposal } : {}),
        ...(state.chat.lastSearch ? { lastSearch: state.chat.lastSearch } : {}),
      })
    })
  }

  function retryInterpretation() {
    return dispatchToStore((_dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
      const current = getState().chat.interpretation
      return current.status === 'failed' && current.request
        ? runInterpretation(current.request, current.messageId) : Promise.resolve()
    })
  }

  function confirmInterpretation() {
    return dispatchToStore((dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
      const state = getState().chat
      if (state.draft.trim()) return Promise.resolve()
      const current = state.interpretation
      if (current.status !== 'ready' || !current.requestId || !current.result?.proposedContext.query) return Promise.resolve()
      dispatch(proposalConfirmed(current.requestId))
      const command = getState().chat.confirmedSearch
      return command ? runSearch(command, current.messageId) : Promise.resolve()
    })
  }

  function retrySearch() {
    return dispatchToStore((_dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
      const state = getState().chat
      return state.searchStatus === 'failed' && state.confirmedSearch
        ? runSearch(state.confirmedSearch) : Promise.resolve()
    })
  }

  return {
    isRestoredHistory,
    confirmedContext,
    interpretation,
    pendingClarification,
    conversationQuery,
    isInterpreting,
    isBusy: isSearching || isInterpreting,
    confirmInterpretation,
    cancelInterpretation,
    retryInterpretation,
    retrySearch,
    searchOptions,
    conversationCount,
    canRetrySearch,
    draft,
    isReadyToSubmit,
    isSearching,
    messages,
    cancelSearch,
    searchError,
    inputError,
    selectSuggestion,
    startNewConversation,
    submitMessage,
    updateDraft,
  }
}
