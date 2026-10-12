// @vitest-environment jsdom
import { createElement, type ComponentType, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore } from '../../../../app/store'
import { supportProgramClient } from '../../../../data/api/supportProgramClient'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'
import { emptyConversationContext, readyConversationProposal } from '../../../../data/fixtures/supportProgramConversation'
import { chatConversationSnapshotSchema } from '../../../../data/models/ChatConversationDto'
import type { GovAgentResult } from '@govbiz/shared/domain/entities/GovAgent'
import type { Company } from '../../../../domain/entities/Company'
import { signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { conversationHistoryOpened, createChatConversationSnapshot } from '../state/chatSlice'
import { useSupportProgramChat } from './useSupportProgramChat'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const account = { email: 'admin@test.local', role: 'ADMIN' as const, tier: 'ADMIN' as const,
  emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const program = { sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id, title: supportPrograms[0].title }
const proposal = readyConversationProposal({ ...emptyConversationContext, query: 'AI 사업' })
const evidence = { answer: '온라인으로 신청하세요.', answerStatus: 'ANSWERED' as const,
  citations: [{ excerpt: '온라인 신청', sourceUrl: supportPrograms[0].sourceUrl, sourceLabel: '기업마당 상세 본문', chunkOrder: 0 }] }

function setup(admin = true, company: Company | null = null) {
  const store = createAppStore()
  store.dispatch(signedIn(admin ? { ...account, company } : { ...account, role: 'USER', tier: 'MEMBER' }))
  const search = vi.fn().mockResolvedValue(completeSearchResult({ query: 'AI 사업', programs: [supportPrograms[0]] }))
  const interpret = vi.fn().mockResolvedValue(proposal)
  const gov = vi.spyOn(supportProgramClient, 'sendGovAgentMessage').mockResolvedValue({ outcome: 'SEARCH', interpretation: proposal })
  const loadCompany = vi.fn().mockResolvedValue(company)
  const StoreProvider = Provider as unknown as ComponentType<PropsWithChildren<{ store: typeof store }>>
  const hook = renderHook(() => useSupportProgramChat({ execute: search }, { execute: interpret }, undefined, { execute: loadCompany }), {
    wrapper: ({ children }: PropsWithChildren) => createElement(StoreProvider, { store }, children),
  })
  return { ...hook, store, search, interpret, gov, loadCompany }
}

async function searchAndSelect(hook: ReturnType<typeof setup>) {
  act(() => hook.result.current.updateDraft('AI 사업 찾아줘'))
  await act(async () => hook.result.current.submitMessage())
  expect(hook.search).not.toHaveBeenCalled()
  await act(async () => hook.result.current.confirmInterpretation())
  act(() => hook.result.current.selectGovProgram(program))
}

describe('관리자 Gov 에이전트 대화', () => {
  it('preserves a new application message while loading company defaults without inventing search context or a program', async () => {
    const company: Company = {
      businessNumber: '1208734519', companyName: '테스트 기업', businessStatus: '계속사업자', businessStatusCode: '01',
      region: '서울특별시', industry: '정보통신업', foundedYear: 2021, homepageUrl: null,
      businessVerifiedAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00',
    }
    const hook = setup(true, company)
    hook.gov.mockResolvedValue({ outcome: 'NEEDS_PROGRAM', message: '공고를 선택해 주세요.' })
    const message = '신청서 작성을 준비하고 싶어요'
    act(() => hook.result.current.updateDraft(message))
    await act(async () => hook.result.current.submitMessage())
    expect(hook.gov).toHaveBeenCalledOnce()
    expect(hook.gov.mock.calls[0][0]).toEqual({
      conversation: { message, context: { ...emptyConversationContext, companyConditions: {
        region: company.region, industry: company.industry, foundedYear: company.foundedYear,
        establishedOn: null, supportPurpose: null,
      } }, pendingClarification: null },
      selectedProgram: null,
    })
    expect(hook.loadCompany).toHaveBeenCalledOnce()
    expect(hook.interpret).not.toHaveBeenCalled()
    expect(hook.search).not.toHaveBeenCalled()
  })

  it('preserves restored search context and selection for the current application message, then clears them for a new conversation', async () => {
    const hook = setup()
    await searchAndSelect(hook)
    const question = '검색할 지역을 하나로 정해 알려 주세요.'
    hook.gov.mockResolvedValue({ outcome: 'SEARCH', interpretation: {
      status: 'CLARIFICATION_REQUIRED', proposedContext: proposal.proposedContext,
      clarificationQuestion: question, answer: null, changedFields: [],
    } })
    act(() => hook.result.current.updateDraft('지역 조건을 바꾸고 싶어요'))
    await act(async () => hook.result.current.submitMessage())
    const snapshot = chatConversationSnapshotSchema.parse(createChatConversationSnapshot(hook.store.getState().chat))
    const previousCalls = hook.gov.mock.calls.length
    act(() => hook.result.current.startNewConversation())
    act(() => hook.store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })))
    expect(hook.gov).toHaveBeenCalledTimes(previousCalls)
    const message = '신청서 작성을 준비하고 싶어요'
    hook.gov.mockResolvedValue({ outcome: 'APPLICATION', program, message: '신청 준비를 시작해 주세요.' })
    act(() => hook.result.current.updateDraft(message))
    await act(async () => hook.result.current.submitMessage())
    expect(hook.gov.mock.calls.at(-1)?.[0]).toEqual({
      conversation: { message, context: proposal.proposedContext,
        pendingClarification: { question, draftContext: proposal.proposedContext }, lastSearch: snapshot.lastSearch },
      selectedProgram: { sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId },
    })
    expect(hook.interpret).not.toHaveBeenCalled()
    expect(hook.search).toHaveBeenCalledOnce()
    expect(hook.loadCompany).not.toHaveBeenCalled()
    act(() => hook.result.current.startNewConversation())
    hook.gov.mockResolvedValue({ outcome: 'NEEDS_PROGRAM', message: '공고를 선택해 주세요.' })
    act(() => hook.result.current.updateDraft(message))
    await act(async () => hook.result.current.submitMessage())
    expect(hook.gov.mock.calls.at(-1)?.[0]).toEqual({
      conversation: { message, context: emptyConversationContext, pendingClarification: null }, selectedProgram: null,
    })
    expect(hook.search).toHaveBeenCalledOnce()
  })

  it('searches only after confirmation, then asks evidence in the same saved conversation', async () => {
    const hook = setup()
    await searchAndSelect(hook)
    expect(hook.search).toHaveBeenCalledOnce()
    expect(hook.interpret).not.toHaveBeenCalled()
    hook.gov.mockResolvedValue({ outcome: 'EVIDENCE', program, evidence })
    act(() => hook.result.current.updateDraft('신청 방법 알려줘'))
    await act(async () => hook.result.current.submitMessage())
    expect(hook.gov.mock.calls.at(-1)?.[0].selectedProgram).toEqual({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })
    expect(hook.result.current.messages.at(-1)?.govEvidence?.answer).toEqual(evidence)
    const snapshot = chatConversationSnapshotSchema.parse(createChatConversationSnapshot(hook.store.getState().chat))
    act(() => hook.result.current.startNewConversation())
    expect(hook.result.current.govProgram).toBeNull()
    act(() => hook.store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })))
    expect(hook.result.current.govProgram).toEqual(program)
    expect(hook.result.current.messages.at(-1)?.govEvidence?.answer).toEqual(evidence)
    expect(hook.gov).toHaveBeenCalledTimes(2)
  })

  it('ignores late responses after reset and clears selection on sign out', async () => {
    const hook = setup()
    await searchAndSelect(hook)
    let resolve!: (value: GovAgentResult) => void
    hook.gov.mockReturnValue(new Promise((done) => { resolve = done }))
    act(() => hook.result.current.updateDraft('신청 방법은?'))
    let request!: Promise<void>
    act(() => { request = hook.result.current.submitMessage() })
    act(() => hook.result.current.startNewConversation())
    await act(async () => { resolve({ outcome: 'APPLICATION', program, message: '신청 준비를 시작해 주세요.' }); await request })
    expect(hook.result.current.messages).toHaveLength(1)
    expect(hook.result.current.govProgram).toBeNull()
    act(() => hook.store.dispatch(signedOut()))
    expect(hook.result.current.isGovAgent).toBe(false)
  })

  it('saves and restores application requests without creating a document or rerouting the request', async () => {
    const hook = setup()
    await searchAndSelect(hook)
    const application = { program, message: '양식을 골라 신청 준비를 시작해 주세요.' }
    hook.gov.mockResolvedValue({ outcome: 'APPLICATION', ...application })
    act(() => hook.result.current.updateDraft('이 공고 신청 준비해줘'))
    await act(async () => hook.result.current.submitMessage())
    expect(hook.result.current.messages.at(-1)?.govApplication).toEqual(application)
    const snapshot = chatConversationSnapshotSchema.parse(createChatConversationSnapshot(hook.store.getState().chat))
    act(() => hook.result.current.startNewConversation())
    act(() => hook.store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })))
    expect(hook.result.current.govProgram).toEqual(program)
    expect(hook.result.current.messages.at(-1)?.govApplication).toEqual(application)
    expect(hook.search).toHaveBeenCalledOnce()
    expect(hook.gov).toHaveBeenCalledTimes(2)
  })

  it('members keep the existing conversation API', async () => {
    const hook = setup(false)
    act(() => hook.result.current.updateDraft('서울 사업 찾아줘'))
    await act(async () => hook.result.current.submitMessage())
    expect(hook.interpret).toHaveBeenCalledOnce()
    expect(hook.gov).not.toHaveBeenCalled()
    act(() => hook.result.current.selectGovProgram(program))
    expect(hook.result.current.govProgram).toBeNull()
  })

  it.each([false, true])('opens and restores a review with selected program=%s without running a search or analysis', async (selected) => {
    const hook = setup()
    if (selected) await searchAndSelect(hook)
    const review = { program: selected ? program : null, message: '검토할 공고 두 개를 선택해 주세요.' }
    hook.gov.mockResolvedValue({ outcome: 'COMBINATION_REVIEW', ...review })
    act(() => hook.result.current.updateDraft('두 지원사업을 동시에 받을 수 있을까?'))
    await act(async () => hook.result.current.submitMessage())
    const message = hook.result.current.messages.at(-1)!
    expect(message.govReview).toEqual(review)
    act(() => hook.result.current.attachGovReview(message.id, 12))
    expect(hook.result.current.messages.at(-1)?.govReview?.reviewId).toBe(12)
    const snapshot = chatConversationSnapshotSchema.parse(createChatConversationSnapshot(hook.store.getState().chat))
    const calls = hook.gov.mock.calls.length
    act(() => hook.result.current.startNewConversation())
    act(() => hook.store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })))
    expect(hook.result.current.messages.at(-1)?.govReview).toEqual({ ...review, reviewId: 12 })
    expect(hook.gov).toHaveBeenCalledTimes(calls)
    expect(hook.search).toHaveBeenCalledTimes(selected ? 1 : 0)
    expect(hook.interpret).not.toHaveBeenCalled()
  })

  it('opens recruitment browsing without a program and ignores a late review save after switching tools', async () => {
    const hook = setup()
    hook.gov.mockResolvedValue({ outcome: 'COMBINATION_REVIEW', program: null, message: '검토 준비' })
    act(() => hook.result.current.updateDraft('중복 지원 검토해 줘'))
    await act(async () => hook.result.current.submitMessage())
    const reviewMessageId = hook.result.current.messages.at(-1)!.id
    hook.gov.mockResolvedValue({ outcome: 'PARTNERS', message: '전체 모집글에서 조건을 확인해 주세요.',
      partnerConditions: { seekingRoles: ['PARTICIPANT'], regions: ['서울'], keywords: [], program: null } })
    act(() => hook.result.current.updateDraft('같이 사업할 파트너 모집글 찾아줘'))
    await act(async () => hook.result.current.submitMessage())
    act(() => hook.result.current.attachGovReview(reviewMessageId, 12))
    expect(hook.result.current.messages.find((message) => message.id === reviewMessageId)?.govReview?.reviewId).toBeUndefined()
    const partners = { message: '전체 모집글에서 조건을 확인해 주세요.',
      conditions: { seekingRoles: ['PARTICIPANT'], regions: ['서울'], keywords: [], program: null } }
    expect(hook.result.current.messages.at(-1)?.govPartners).toEqual(partners)
    expect(hook.result.current.govProgram).toBeNull()
    expect(hook.search).not.toHaveBeenCalled()
    const snapshot = chatConversationSnapshotSchema.parse(createChatConversationSnapshot(hook.store.getState().chat))
    act(() => hook.result.current.startNewConversation())
    act(() => hook.store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })))
    // 대화에서 읽은 조건도 저장된 대화에 함께 남아, 다시 열면 같은 조건으로 고릅니다.
    expect(hook.result.current.messages.at(-1)?.govPartners).toEqual(partners)
    expect(hook.gov).toHaveBeenCalledTimes(2)
  })

  it.each(['COMBINATION_REVIEW', 'PARTNERS'] as const)('discards a late %s response after changing account', async (outcome) => {
    const hook = setup()
    let resolve!: (value: GovAgentResult) => void
    hook.gov.mockReturnValue(new Promise((done) => { resolve = done }))
    act(() => hook.result.current.updateDraft('검토 또는 모집글 찾아줘'))
    let request!: Promise<void>
    act(() => { request = hook.result.current.submitMessage() })
    act(() => hook.store.dispatch(signedIn({ ...account, email: 'another@test.local' })))
    await act(async () => {
      resolve(outcome === 'PARTNERS'
        ? { outcome, message: '이전 계정 응답', partnerConditions: { seekingRoles: [], regions: [], keywords: [], program: null } }
        : { outcome, program: null, message: '이전 계정 응답' })
      await request
    })
    expect(hook.result.current.messages.some((message) => message.govReview || message.govPartners)).toBe(false)
  })

  it('requests selection without inventing a target and does not launch a search', async () => {
    const hook = setup()
    hook.gov.mockResolvedValue({ outcome: 'NEEDS_PROGRAM', message: '공고를 선택해 주세요.' })
    act(() => hook.result.current.updateDraft('이 공고 지원 대상은?'))
    await act(async () => hook.result.current.submitMessage())
    expect(hook.result.current.messages.at(-1)?.text).toBe('공고를 선택해 주세요.')
    expect(hook.search).not.toHaveBeenCalled()
    expect(hook.result.current.govProgram).toBeNull()
  })
})
