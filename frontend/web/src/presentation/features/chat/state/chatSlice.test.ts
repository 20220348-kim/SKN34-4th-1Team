import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'
import { describe, expect, it } from 'vitest'

import { createAppStore, type AppStore } from '../../../../app/store'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../../../data/fixtures/supportProgramConversation'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { Account } from '../../../../domain/entities/Account'
import { sessionRestored, signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import {
  conversationReset,
  govMessageSucceeded,
  govProgramSelected,
  govToolStarted,
  returnToGovChatChanged,
  searchResultRestored,
  searchResultRestoreFailed,
  draftChanged,
  interpretationFailed,
  interpretationCancelled,
  interpretationStarted,
  interpretationSucceeded,
  outcomeSeen,
  proposalConfirmed,
  searchCancelled,
  searchFailed,
  searchRelaxationProposed,
  searchStarted,
  searchSucceeded,
  searchTimedOut,
  selectChatActivity,
  selectConversationContext,
  selectConversationCount,
} from './chatSlice'

const account: Account = {
  email: 'first@example.test', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null,
}
const otherAccount: Account = { ...account, email: 'second@example.test' }

describe('검색 조건 제안과 작성 중 메시지', () => {
  it('초안을 수정해도 제안을 유지하고 미전송 초안을 비운 뒤에만 같은 제안을 확정한다', () => {
    const store = createAppStore()
    const started = interpretationStarted({ message: '서울 AI 창업지원 사업 찾아줘', context: emptyConversationContext })
    store.dispatch(started)
    store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId, result: readyConversationProposal(seoulConversationContext) }))
    const proposal = store.getState().chat.interpretation
    for (const draft of ['부', '부산으로 바꿔줘', '가'.repeat(501)]) {
      store.dispatch(draftChanged(draft))
      expect(store.getState().chat.interpretation).toBe(proposal)
      expect(store.getState().chat.pendingProposal).toEqual(seoulConversationContext)
      store.dispatch(proposalConfirmed(started.payload.requestId))
      expect(store.getState().chat.confirmedSearch).toBeNull()
      expect(selectConversationContext(store.getState())).toEqual(emptyConversationContext)
    }
    store.dispatch(draftChanged(' '))
    store.dispatch(proposalConfirmed(started.payload.requestId))
    expect(selectConversationContext(store.getState())).toEqual(seoulConversationContext)
    expect(store.getState().chat.pendingProposal).toBeNull()
  })
})

describe('대화의 로그인 세션 경계', () => {
  it.each([
    ['로그아웃', signedOut()],
    ['다른 계정 로그인', signedIn(otherAccount)],
    ['다른 계정 세션 복원', sessionRestored(otherAccount)],
    ['세션 종료 확인', sessionRestored(null)],
  ] as const)('%s 시 완료된 대화·검색 결과·기업 조건·작성 중 초안을 비운다', (_label, action) => {
    const store = createAppStore()
    store.dispatch(signedIn(account))
    completeSearch(store)
    store.dispatch(draftChanged('아직 보내지 않은 우리 회사의 다음 질문'))
    expect(selectConversationCount(store.getState())).toBe(1)
    expect(store.getState().chat.messages.at(-1)?.programs).toEqual([supportPrograms[0]])
    expect(selectConversationContext(store.getState())).toEqual(seoulConversationContext)

    store.dispatch(action)

    expectClearedConversation(store, store.getState().auth.account?.email ?? null)
  })

  it.each(['검색 실패', '추가 질문', '미확정 제안', '해석 실패'] as const)('로그아웃은 %s 상태와 재시도에 쓰는 이전 요청도 비운다', (phase) => {
    const store = createAppStore()
    store.dispatch(signedIn(account))
    completeSearch(store)
    if (phase === '검색 실패') {
      const started = searchStarted('다음 지원사업')
      store.dispatch(started)
      store.dispatch(searchFailed({ query: '다음 지원사업', requestId: started.payload.requestId, message: '다시 검색해 주세요.' }))
      expect(store.getState().chat.searchStatus).toBe('failed')
    } else {
      const started = interpretationStarted({ message: '설립한 지 2년입니다', context: seoulConversationContext })
      store.dispatch(started)
      if (phase === '추가 질문') {
        store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId, result: {
          status: 'CLARIFICATION_REQUIRED', proposedContext: seoulConversationContext,
          clarificationQuestion: '정확한 설립일을 알려주세요.', changedFields: [],
        } }))
        expect(store.getState().chat.pendingClarification).not.toBeNull()
      } else if (phase === '미확정 제안') {
        store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId,
          result: readyConversationProposal(seoulConversationContext) }))
        expect(store.getState().chat.pendingProposal).not.toBeNull()
      } else {
        store.dispatch(interpretationFailed({ requestId: started.payload.requestId, message: '다시 해석해 주세요.' }))
        expect(store.getState().chat.interpretation.status).toBe('failed')
      }
    }

    store.dispatch(signedOut())

    expectClearedConversation(store, null)
  })

  it('최근 검색 요약은 확정 화면 조건이 아니라 실제 요청의 검색어·조건을 기록한다', () => {
    const store = createAppStore()
    completeSearch(store)
    const search = searchStarted('다른 무역 검색', { acceptingOnly: false, companyConditions: { region: '대구' } })
    store.dispatch(search)
    expect(store.getState().chat.lastSearch).toBeNull()
    store.dispatch(searchSucceeded(completeSearchResult({ requestId: search.payload.requestId, programs: [] })))
    expect(store.getState().chat.lastSearch).toEqual({ resultCount: 0, context: {
      ...emptyConversationContext, query: '다른 무역 검색', acceptingOnly: false,
      companyConditions: { ...emptyConversationContext.companyConditions, region: '대구' },
    } })
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ searchQuery: '다른 무역 검색',
      searchOptions: { acceptingOnly: false, companyConditions: { region: '대구' } } })
    expect(selectConversationContext(store.getState())).toEqual(seoulConversationContext)
  })

  it('같은 계정의 기업정보 갱신과 세션 재확인은 대화를 유지하며 새 검색도 계정 소유를 유지한다', () => {
    const store = createAppStore()
    store.dispatch(signedIn(account))
    completeSearch(store)
    const previousConversation = store.getState().chat
    const updatedAccount: Account = { ...account, tier: 'COMPANY',
      company: { companyName: '서울 소프트웨어', businessNumber: '1248100998', businessStatusCode: '01' } }

    store.dispatch(signedIn(updatedAccount))
    expect(store.getState().chat).toBe(previousConversation)
    store.dispatch(sessionRestored(updatedAccount))
    expect(store.getState().chat).toBe(previousConversation)

    store.dispatch(conversationReset())
    expectClearedConversation(store, account.email)
    store.dispatch(draftChanged('새 대화 초안'))
    store.dispatch(signedIn(updatedAccount))
    expect(store.getState().chat.draft).toBe('새 대화 초안')
  })

  it('비로그인 세션 확인은 공개 검색 대화를 유지하고 로그인하면 새 계정의 대화로 시작한다', () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(null))
    completeSearch(store)
    const publicConversation = store.getState().chat

    store.dispatch(sessionRestored(null))
    expect(store.getState().chat).toBe(publicConversation)
    store.dispatch(signedIn(account))
    expectClearedConversation(store, account.email)
  })

  it.each([false, true])('로그아웃 전 검색 응답은 초기화된 상태나 새 계정의 검색을 되살리거나 덮어쓰지 않는다 (새 검색: %s)', (startNextSearch) => {
    const store = createAppStore()
    store.dispatch(signedIn(account))
    const oldSearch = searchStarted('이전 계정 검색')
    store.dispatch(oldSearch)
    store.dispatch(signedOut())
    expectClearedConversation(store, null)
    const nextSearch = searchStarted('새 계정 검색')
    if (startNextSearch) {
      store.dispatch(signedIn(otherAccount))
      store.dispatch(nextSearch)
    }
    const nextState = store.getState().chat
    const oldRequest = { query: oldSearch.payload.query, requestId: oldSearch.payload.requestId }

    store.dispatch(searchSucceeded(completeSearchResult({ requestId: oldRequest.requestId, programs: [supportPrograms[0]] })))
    store.dispatch(searchFailed({ ...oldRequest, message: '이전 계정의 오류' }))
    store.dispatch(searchTimedOut(oldRequest))
    store.dispatch(searchCancelled(oldRequest))

    expect(store.getState().chat).toBe(nextState)
    if (startNextSearch) {
      store.dispatch(searchSucceeded(completeSearchResult({ requestId: nextSearch.payload.requestId, programs: [supportPrograms[1]] })))
      expect(store.getState().chat.messages.at(-1)?.programs).toEqual([supportPrograms[1]])
    }
  })

  it.each([false, true])('로그아웃 전 해석의 성공·실패 응답은 초기화된 상태나 새 계정의 해석에 반영하지 않는다 (새 해석: %s)', (startNextInterpretation) => {
    const store = createAppStore()
    store.dispatch(signedIn(account))
    const oldInterpretation = interpretationStarted({ message: '이전 회사 조건', context: emptyConversationContext })
    store.dispatch(oldInterpretation)
    store.dispatch(signedOut())
    expectClearedConversation(store, null)
    const nextInterpretation = interpretationStarted({ message: '새 회사 조건', context: emptyConversationContext })
    if (startNextInterpretation) {
      store.dispatch(signedIn(otherAccount))
      store.dispatch(nextInterpretation)
    }
    const nextState = store.getState().chat

    store.dispatch(interpretationSucceeded({ requestId: oldInterpretation.payload.requestId,
      result: readyConversationProposal(seoulConversationContext) }))
    store.dispatch(interpretationFailed({ requestId: oldInterpretation.payload.requestId, message: '이전 회사의 오류' }))

    expect(store.getState().chat).toBe(nextState)
    if (startNextInterpretation) {
      store.dispatch(interpretationSucceeded({ requestId: nextInterpretation.payload.requestId,
        result: readyConversationProposal({ ...emptyConversationContext, query: '새 회사 지원사업' }) }))
      expect(store.getState().chat.interpretation.result?.proposedContext.query).toBe('새 회사 지원사업')
    }
  })
})

describe('결과가 없을 때의 조건 빼기 제안', () => {
  const options = { acceptingOnly: true, companyConditions: { region: '서울특별시', industry: '정보통신업' } }
  const counts = { candidateCount: 20, lowRelevance: 14, target: 2, region: 4 }

  function emptySearch(store: AppStore) {
    const started = searchStarted('AI 창업 자금', options)
    store.dispatch(started)
    store.dispatch(searchSucceeded({ requestId: started.payload.requestId, programs: [], totalCount: 0, resultToken: null, expiresAt: null,
      exclusionCounts: counts }))
  }

  it('결과 메시지에 제외 수를 남기고, 고른 조건만 뺀 제안을 AI 해석 없이 확인 카드로 만든다', () => {
    const store = createAppStore()
    emptySearch(store)
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ programs: [], totalCount: 0, exclusionCounts: counts })

    const proposed = searchRelaxationProposed('REGION', '지역 조건 빼고 찾기')
    store.dispatch(proposed)
    const chat = store.getState().chat
    expect(chat.messages.at(-1)).toEqual({ id: proposed.payload.messageId, role: 'user', text: '지역 조건 빼고 찾기' })
    expect(chat.interpretation).toMatchObject({ status: 'ready', requestId: proposed.payload.requestId,
      result: { status: 'READY', changedFields: ['REGION'] } })
    expect(chat.interpretation.request).toBeUndefined()
    expect(chat.interpretation.result?.proposedContext.companyConditions).toMatchObject({ region: null, industry: '정보통신업' })
    // 검색은 확인 카드에서 확정할 때만 합니다.
    expect(chat.searchStatus).toBe('idle')
    store.dispatch(proposalConfirmed(proposed.payload.requestId))
    expect(store.getState().chat.confirmedSearch).toMatchObject({ query: 'AI 창업 자금', acceptingOnly: true,
      companyConditions: { industry: '정보통신업' } })
    expect(store.getState().chat.confirmedSearch?.companyConditions?.region).toBeUndefined()
  })

  it('결과가 있던 검색이나 진행 중인 요청에는 조건 빼기 제안을 만들지 않는다', () => {
    const store = createAppStore()
    const started = searchStarted('무역 지원', options)
    store.dispatch(started)
    store.dispatch(searchSucceeded({ requestId: started.payload.requestId, programs: supportPrograms.slice(0, 1), totalCount: 1,
      resultToken: null, expiresAt: null }))
    const before = store.getState().chat
    store.dispatch(searchRelaxationProposed('REGION', '지역 조건 빼고 찾기'))
    expect(store.getState().chat).toBe(before)

    const busy = createAppStore()
    emptySearch(busy)
    busy.dispatch(searchStarted('다른 검색'))
    const pending = busy.getState().chat
    busy.dispatch(searchRelaxationProposed('ACCEPTING_ONLY', '마감·예정 공고도 찾기'))
    expect(busy.getState().chat).toBe(pending)
  })
})

describe('검색 공개 수와 복원 결과', () => {
  it('두 공고만 표시해도 마지막 검색 요약은 서버가 찾은 전체 추천 수를 유지한다', () => {
    const store = createAppStore()
    const started = searchStarted('무역 지원')
    store.dispatch(started)
    store.dispatch(searchSucceeded({ requestId: started.payload.requestId, programs: supportPrograms.slice(0, 2), totalCount: 5,
      resultToken: '4595df20-ea11-4b17-a37e-c82e1b5c9142', expiresAt: '2026-09-10T12:30:00Z' }))
    expect(store.getState().chat.lastSearch?.resultCount).toBe(5)
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ totalCount: 5, programs: supportPrograms.slice(0, 2) })
    expect(store.getState().chat.messages.at(-1)?.text).toContain('추천 결과 5건 중 2건')
    expect(store.getState().chat.messages.at(-1)?.text).toContain('표시된 공고 기준')
  })

  it('복원은 선택한 전체 결과·조건으로 새 대화를 만들고 로그인 소유자와 결과 순서를 유지한다', () => {
    const store = createAppStore()
    store.dispatch(signedIn(account))
    completeSearch(store)
    store.dispatch(draftChanged('복원과 무관한 이전 초안'))
    const context = { ...seoulConversationContext, query: '무역 지원',
      companyConditions: { ...seoulConversationContext.companyConditions, region: '대구' } }
    store.dispatch(searchResultRestored({ ...completeSearchResult({ query: context.query, programs: supportPrograms.slice(0, 5) }), context }))
    const state = store.getState().chat
    expect(state.accountEmail).toBe(account.email)
    expect(state.messages).toHaveLength(3)
    expect(state.draft).toBe('')
    expect(selectConversationContext(store.getState())).toEqual(context)
    expect(state.lastSearch).toEqual({ context, resultCount: 5 })
    expect(state.messages.at(-1)).toMatchObject({ programs: supportPrograms.slice(0, 5), totalCount: 5,
      resultToken: null, expiresAt: null })
    expect(state.searchStatus).toBe('idle')
    expect(state.pendingProposal).toBeNull()
  })

  it('복원 실패 안내는 재검색 가능한 실패 상태를 만들지 않는다', () => {
    const store = createAppStore()
    store.dispatch(searchResultRestoreFailed('검색 결과 보관 시간이 지났습니다. 새로 검색해 주세요.'))
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ role: 'assistant', text: '검색 결과 보관 시간이 지났습니다. 새로 검색해 주세요.' })
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(store.getState().chat.confirmedSearch).toBeNull()
  })
})

describe('요청 실패 대화 기록', () => {
  it.each(['search', 'timeout', 'interpretation'] as const)('%s 실패는 요청당 assistant 메시지 하나만 기록한다', (phase) => {
    const store = createAppStore()
    const interpretation = interpretationStarted({ message: '서울 지원사업', context: emptyConversationContext })
    const search = searchStarted('서울 지원사업')
    const requestId = phase === 'interpretation' ? interpretation.payload.requestId : search.payload.requestId
    store.dispatch(phase === 'interpretation' ? interpretation : search)
    const failure = phase === 'interpretation'
      ? interpretationFailed({ requestId, message: '조건 해석 실패' })
      : phase === 'timeout' ? searchTimedOut({ requestId, query: '서울 지원사업' })
        : searchFailed({ requestId, query: '서울 지원사업', message: '검색 실패' })
    store.dispatch(failure)
    const failedState = store.getState().chat
    expect(failedState.messages).toHaveLength(3)
    expect(failedState.messages.at(-1)).toMatchObject({ role: 'assistant',
      failure: phase === 'interpretation' ? 'interpretation' : 'search', text: expect.any(String) })
    store.dispatch(failure)
    expect(store.getState().chat).toBe(failedState)
    if (phase === 'timeout') {
      store.dispatch(searchFailed({ requestId, query: '서울 지원사업', message: '늦게 도착한 실패' }))
      expect(store.getState().chat).toBe(failedState)
    }
  })

  it.each(['search', 'interpretation'] as const)('%s 사용자 취소나 늦은 실패는 실패 말풍선을 기록하지 않는다', (phase) => {
    const store = createAppStore()
    if (phase === 'search') {
      const started = searchStarted('서울 지원사업')
      store.dispatch(started)
      const request = { requestId: started.payload.requestId, query: '서울 지원사업' }
      store.dispatch(searchCancelled(request))
      store.dispatch(searchFailed({ ...request, message: '취소된 요청의 오류' }))
    } else {
      const started = interpretationStarted({ message: '서울 지원사업', context: emptyConversationContext })
      store.dispatch(started)
      store.dispatch(interpretationCancelled(started.payload.requestId))
      store.dispatch(interpretationFailed({ requestId: started.payload.requestId, message: '취소된 요청의 오류' }))
    }
    expect(store.getState().chat.messages).toHaveLength(2)
    expect(store.getState().chat.messages.some((message) => message.failure)).toBe(false)
  })
})

function completeSearch(store: AppStore) {
  const interpretation = interpretationStarted({ message: '서울 SW 사업화 지원', context: emptyConversationContext })
  store.dispatch(interpretation)
  store.dispatch(interpretationSucceeded({ requestId: interpretation.payload.requestId,
    result: readyConversationProposal(seoulConversationContext) }))
  store.dispatch(proposalConfirmed(interpretation.payload.requestId))
  const search = searchStarted(seoulConversationContext.query!, store.getState().chat.searchOptions, interpretation.payload.messageId)
  store.dispatch(search)
  store.dispatch(searchSucceeded(completeSearchResult({ requestId: search.payload.requestId, programs: [supportPrograms[0]] })))
}

function expectClearedConversation(store: AppStore, accountEmail: string | null) {
  const fresh = createAppStore().getState().chat
  expect(store.getState().chat).toEqual({
    ...fresh,
    accountEmail,
    messages: [{ ...fresh.messages[0], id: expect.any(String) }],
  })
  expect(selectConversationCount(store.getState())).toBe(0)
  expect(selectConversationContext(store.getState())).toEqual(emptyConversationContext)
}


describe('unseen outcome', () => {
  it('marks arrived results as unseen until the chat screen reports it saw them', () => {
    const store = createAppStore()
    const started = searchStarted('서울 AI')
    store.dispatch(started)
    expect(store.getState().chat.unseenOutcome).toBeNull()
    store.dispatch(searchSucceeded(completeSearchResult({ requestId: started.payload.requestId, programs: [] })))
    expect(store.getState().chat.unseenOutcome).toBe('search-succeeded')
    expect(selectChatActivity(store.getState())).toEqual({ kind: 'unseen', outcome: 'search-succeeded', resultCount: 0 })
    store.dispatch(outcomeSeen())
    expect(store.getState().chat.unseenOutcome).toBeNull()
    expect(selectChatActivity(store.getState())).toBeNull()

    const failing = searchStarted('부산')
    store.dispatch(failing)
    expect(selectChatActivity(store.getState())).toEqual({ kind: 'searching' })
    store.dispatch(searchFailed({ query: '부산', requestId: failing.payload.requestId }))
    expect(store.getState().chat.unseenOutcome).toBe('search-failed')

    store.dispatch(conversationReset())
    const interpreted = interpretationStarted({ message: '경기', context: emptyConversationContext, pendingClarification: null })
    store.dispatch(interpreted)
    expect(selectChatActivity(store.getState())).toEqual({ kind: 'interpreting' })
    store.dispatch(interpretationSucceeded({ requestId: interpreted.payload.requestId, result: readyConversationProposal(seoulConversationContext) }))
    expect(store.getState().chat.unseenOutcome).toBe('interpretation-ready')
    store.dispatch(conversationReset())
    expect(store.getState().chat.unseenOutcome).toBeNull()
  })
})

describe('Gov 공고 선택 뒤 다시 묻기 · 파트너 찾기 · 대화로 돌아가기', () => {
  const program = { sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id, title: supportPrograms[0].title }

  function selectProgram(store: AppStore) {
    const searched = searchStarted('AI')
    store.dispatch(searched)
    store.dispatch(searchSucceeded(completeSearchResult({ requestId: searched.payload.requestId, programs: [supportPrograms[0]] })))
    store.dispatch(govProgramSelected(program))
  }

  it('공고를 골라야 한다는 답의 요청을 남기고, 공고를 고른 뒤 보낸 메시지나 다른 답이 오면 지운다', () => {
    const store = createAppStore()
    store.dispatch(signedIn({ ...account, role: 'ADMIN', tier: 'ADMIN' }))
    const asked = interpretationStarted({ message: '신청 자격 알려줘', context: emptyConversationContext })
    store.dispatch(asked)
    store.dispatch(govMessageSucceeded({ requestId: asked.payload.requestId, message: '공고를 먼저 골라 주세요.', needsProgram: true }))
    expect(store.getState().chat.govPendingQuestion).toBe('신청 자격 알려줘')
    // 공고를 고르기 전에 보낸 검색 요청은 남겨 둔 요청을 지우지 않습니다.
    store.dispatch(interpretationStarted({ message: 'AI 창업', context: emptyConversationContext }))
    expect(store.getState().chat.govPendingQuestion).toBe('신청 자격 알려줘')
    store.dispatch(interpretationCancelled(store.getState().chat.interpretation.requestId!))
    selectProgram(store)
    expect(store.getState().chat.govPendingQuestion).toBe('신청 자격 알려줘')
    store.dispatch(interpretationStarted({ message: '신청 자격 알려줘', context: emptyConversationContext }))
    expect(store.getState().chat.govPendingQuestion).toBeNull()

    // 다른 답(파트너 조회)이 오면 남겨 둔 요청을 지웁니다.
    store.dispatch(conversationReset())
    const again = interpretationStarted({ message: '신청서 써줘', context: emptyConversationContext })
    store.dispatch(again)
    store.dispatch(govMessageSucceeded({ requestId: again.payload.requestId, message: '공고를 먼저 골라 주세요.', needsProgram: true }))
    const partners = interpretationStarted({ message: '파트너 찾아줘', context: emptyConversationContext })
    store.dispatch(partners)
    store.dispatch(govMessageSucceeded({ requestId: partners.payload.requestId, message: '모집글', partners: { message: '모집글' } }))
    expect(store.getState().chat.govPendingQuestion).toBeNull()
  })

  it('[파트너 찾기] 칩은 고른 공고만 조건으로 담은 파트너 카드를 만든다', () => {
    const store = createAppStore()
    store.dispatch(signedIn({ ...account, role: 'ADMIN', tier: 'ADMIN' }))
    selectProgram(store)
    store.dispatch(govToolStarted('PARTNERS'))
    const [request, answer] = store.getState().chat.messages.slice(-2)
    expect(request).toMatchObject({ role: 'user', text: '이 공고 파트너 찾기' })
    expect(answer.govPartners).toEqual({ message: '이 공고로 모집 중인 파트너 모집글을 찾아봤어요.',
      conditions: { seekingRoles: [], regions: [], keywords: [], program: { sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId } } })
  })

  it('대화로 돌아가기 표시는 대화를 새로 시작하면 지운다', () => {
    const store = createAppStore()
    store.dispatch(returnToGovChatChanged(true))
    expect(store.getState().chat.returnToGovChat).toBe(true)
    store.dispatch(conversationReset())
    expect(store.getState().chat.returnToGovChat).toBe(false)
  })
})
