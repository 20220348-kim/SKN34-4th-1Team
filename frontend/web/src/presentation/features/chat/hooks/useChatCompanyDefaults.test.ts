// @vitest-environment jsdom
import { createElement, type ComponentType, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore } from '../../../../app/store'
import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'
import { chatConversationSnapshotSchema } from '../../../../data/models/ChatConversationDto'
import type { Company } from '../../../../domain/entities/Company'
import type { SupportProgramInterpretRequest } from '../../../../domain/entities/SupportProgramConversation'
import { signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { conversationHistoryOpened, createChatConversationSnapshot } from '../state/chatSlice'
import { useSupportProgramChat } from './useSupportProgramChat'

afterEach(cleanup)
const company: Company = {
  businessNumber: '1208734519', companyName: '데이터브릿지 주식회사', businessStatus: '계속사업자', businessStatusCode: '01',
  region: '서울특별시', industry: '정보통신업', foundedYear: 2021, homepageUrl: null,
  businessVerifiedAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00',
}
const account = { email: 'jihoon.park@demo.govbiz.local', role: 'USER' as const, tier: 'COMPANY' as const,
  emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: { companyName: company.companyName, businessNumber: company.businessNumber, businessStatusCode: '01' as const } }

function setup(loadCompany = vi.fn<(signal?: AbortSignal) => Promise<Company | null>>().mockResolvedValue(company)) {
  const store = createAppStore()
  store.dispatch(signedIn(account))
  const interpret = vi.fn(async (request: SupportProgramInterpretRequest, _signal?: AbortSignal) => ({
    status: 'READY' as const, proposedContext: { ...request.context, query: 'AI 창업지원' },
    changedFields: ['QUERY'] as ['QUERY'], clarificationQuestion: null,
  }))
  const search = vi.fn().mockResolvedValue(completeSearchResult({ query: 'AI 창업지원', programs: [] }))
  const StoreProvider = Provider as unknown as ComponentType<PropsWithChildren<{ store: typeof store }>>
  const hook = renderHook(() => useSupportProgramChat({ execute: search }, { execute: interpret }, undefined, { execute: loadCompany }), {
    wrapper: ({ children }: PropsWithChildren) => createElement(StoreProvider, { store }, children),
  })
  return { ...hook, store, interpret, search, loadCompany }
}

describe('등록 기업을 새 대화의 기본 조건으로 사용', () => {
  it('시드 회사의 소재지·업종·설립연도가 해석과 검색 및 기록 복원까지 유지된다', async () => {
    const { result, store, interpret, search, loadCompany } = setup()
    act(() => result.current.updateDraft('서울 AI 창업지원 사업 찾아줘'))
    await act(async () => result.current.submitMessage())
    expect(interpret.mock.calls[0][0].context.companyConditions).toEqual({
      region: '서울특별시', industry: '정보통신업', establishedOn: null, foundedYear: 2021, supportPurpose: null,
    })
    await act(async () => result.current.confirmInterpretation())
    expect(search.mock.calls[0][0].companyConditions).toEqual({ region: '서울특별시', industry: '정보통신업', foundedYear: 2021 })
    const snapshot = chatConversationSnapshotSchema.parse(createChatConversationSnapshot(store.getState().chat))
    expect(snapshot.searchOptions.companyConditions?.foundedYear).toBe(2021)
    act(() => result.current.startNewConversation())
    act(() => store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })))
    act(() => result.current.updateDraft('수출 지원도 찾아줘'))
    await act(async () => result.current.submitMessage())
    expect(loadCompany).toHaveBeenCalledTimes(1)
    expect(interpret.mock.calls[1][0].context.companyConditions.foundedYear).toBe(2021)
  })

  it('대화에서 바꾸거나 해제한 조건을 다음 요청에서 프로필로 덮어쓰지 않는다', async () => {
    const { result, interpret, search, loadCompany } = setup()
    act(() => result.current.updateDraft('서울 AI 창업지원 사업 찾아줘'))
    await act(async () => result.current.submitMessage())
    await act(async () => result.current.confirmInterpretation())
    interpret.mockImplementationOnce(async (request) => ({
      status: 'READY', proposedContext: { ...request.context, query: 'AI 창업지원',
        companyConditions: { region: '부산', industry: null, establishedOn: null, foundedYear: null, supportPurpose: null } },
      changedFields: ['QUERY'], clarificationQuestion: null,
    }))
    act(() => result.current.updateDraft('부산으로 바꾸고 업종과 설립 조건은 해제'))
    await act(async () => result.current.submitMessage())
    await act(async () => result.current.confirmInterpretation())
    act(() => result.current.updateDraft('다시 찾아줘'))
    await act(async () => result.current.submitMessage())
    expect(loadCompany).toHaveBeenCalledTimes(1)
    expect(interpret.mock.calls[2][0].context.companyConditions).toMatchObject({ region: '부산', industry: null, establishedOn: null })
    expect(interpret.mock.calls[2][0].context.companyConditions.foundedYear).toBeUndefined()
    expect(search.mock.calls[1][0].companyConditions).toEqual({ region: '부산' })
  })

  it('회사 조회 실패를 조건 없는 AI 검색으로 숨기지 않고 재시도한다', async () => {
    const loadCompany = vi.fn<(signal?: AbortSignal) => Promise<Company | null>>()
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(company)
    const { result, store, interpret } = setup(loadCompany)
    act(() => result.current.updateDraft('서울 AI 창업지원 사업 찾아줘'))
    await act(async () => result.current.submitMessage())
    expect(interpret).not.toHaveBeenCalled()
    expect(result.current.interpretation.error).toContain('등록된 기업 정보')
    const snapshot = chatConversationSnapshotSchema.parse(createChatConversationSnapshot(store.getState().chat))
    expect(snapshot.companyDefaultsInitialized).toBe(false)
    act(() => result.current.startNewConversation())
    act(() => store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })))
    await act(async () => result.current.retryInterpretation())
    expect(interpret.mock.calls[0][0].context.companyConditions.foundedYear).toBe(2021)
  })

  it('로그아웃 후 늦게 도착한 회사 정보로 새 계정의 해석을 시작하지 않는다', async () => {
    let resolve!: (value: Company) => void
    const pending = new Promise<Company>((done) => { resolve = done })
    const loadCompany = vi.fn<(signal?: AbortSignal) => Promise<Company | null>>().mockReturnValue(pending)
    const { result, store, interpret } = setup(loadCompany)
    act(() => result.current.updateDraft('서울 AI 창업지원 사업 찾아줘'))
    let running!: Promise<void>
    act(() => { running = result.current.submitMessage() })
    act(() => store.dispatch(signedOut()))
    await act(async () => { resolve(company); await running })
    expect(interpret).not.toHaveBeenCalled()
    expect(store.getState().chat.searchOptions.companyConditions).toBeUndefined()
    expect(loadCompany.mock.calls[0][0]?.aborted).toBe(true)
  })
})
