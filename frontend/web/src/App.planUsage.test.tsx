// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planQuotaExceededMessage, type PlanUsage, type PlanUsageItem } from '@govbiz/shared/domain/entities/PlanUsage'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { readyConversationProposal, seoulConversationContext } from './data/fixtures/supportProgramConversation'
import { completeSearchResult } from './data/fixtures/supportProgramSearchResult'
import type { Account } from './domain/entities/Account'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({ CoreApiConnectionStatus: () => null }))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({
  useSupportProgramSearchReadiness: () => ({
    canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
    data: { searchState: 'SEARCHABLE', programCount: 10, indexReady: true, lastSuccessfulSyncAt: null, lastFailedSyncAt: null,
      sources: [{ sourceCode: 'BIZINFO', sourceName: '기업마당', searchState: 'SEARCHABLE', programCount: 10, indexReady: true,
        lastSuccessfulSyncAt: null, lastFailedSyncAt: null }] },
  }),
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const member: Account = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const resetsAt = '2026-10-09T00:00:00+09:00'
const emptyCatalog = { programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [] }

function aiSearch(used: number, limit: number | null): PlanUsageItem {
  return { feature: 'AI_SEARCH', period: 'DAY', limit, used, resetsAt }
}
const memberUsage = (used: number): PlanUsage => ({ plan: 'FREE', items: [aiSearch(used, 10)] })
const guestUsage = (used: number): PlanUsage => ({ plan: null, items: [aiSearch(used, 2)] })
const memberLimitMessage = planQuotaExceededMessage({ feature: 'AI_SEARCH', period: 'DAY', limit: 10, resetsAt, plan: 'FREE' })

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
}

function quotaProblem() {
  return new Response(JSON.stringify({
    type: 'urn:govbiz:problem:plan-quota-exceeded', title: 'Plan Quota Exceeded', status: 429, detail: 'private server detail',
    instance: '/api/v1/support-programs/search', code: 'PLAN_QUOTA_EXCEEDED', feature: 'AI_SEARCH', period: 'DAY', plan: 'FREE',
    limit: 10, used: 10, resetsAt, retryAfterSeconds: 3600,
  }), { status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '3600' } })
}

/** 해석은 서울 조건 제안을, AI 검색은 [search]의 응답을, 필터 검색은 빈 목록을 돌려줍니다. 나머지 요청은 끝나지 않습니다. */
function mockNetwork(search: (query: string) => Response = (query) => json(completeSearchResult({ query, programs: [] }))) {
  const searchRequests: { query: string }[] = []
  const catalogRequests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/conversation/interpret')) return json(readyConversationProposal(seoulConversationContext))
    if (path.endsWith('/support-programs/search')) {
      const body = JSON.parse(String(init?.body)) as { query: string }
      searchRequests.push(body)
      return search(body.query)
    }
    if (path.endsWith('/support-programs/catalog')) {
      catalogRequests.push(String(url))
      return json(emptyCatalog)
    }
    return new Promise<Response>(() => {})
  }))
  return { searchRequests, catalogRequests }
}

function renderApp(path: string, account: Account | null) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  render(<Provider store={store}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Provider>)
  return store
}

async function submitMessage(message: string) {
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  fireEvent.change(input, { target: { value: message } })
  await act(async () => fireEvent.submit(input.closest('form')!))
  await waitFor(() => expect(screen.queryByText('조건 변경안을 해석하고 있어요. 아직 검색하지 않았습니다…')).toBeNull())
}

describe('AI 대화 검색 이용량', () => {
  it('로그인 전에는 체험 횟수를 보여 주고, 이용량을 읽지 못하면 아무것도 그리지 않는다', async () => {
    mockNetwork()
    const usage = vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue(guestUsage(0))
    renderApp('/', null)
    const line = (await screen.findByText('로그인 전 체험 0/2회')).closest('p')!
    expect(line.textContent).toBe('AI 대화 검색·로그인 전 체험 0/2회')
    // 80% 전에는 경고와 다시 채워지는 때를 붙이지 않습니다.
    expect(line.className).not.toContain('text-warning')
    expect(usage).toHaveBeenCalledOnce()

    cleanup()
    usage.mockRejectedValue(new Error('usage unavailable'))
    renderApp('/', null)
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByText(/로그인 전 체험|오늘 \d+\/\d+회/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('80%부터 경고 색과 다시 채워지는 때를 붙이고 검색할 때마다 이용량을 다시 읽는다', async () => {
    const network = mockNetwork()
    const usage = vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage')
      .mockResolvedValueOnce(memberUsage(8)).mockResolvedValue(memberUsage(9))
    renderApp('/app/chat', member)
    const line = (await screen.findByText('오늘 8/10회')).closest('p')!
    expect(line.className).toContain('text-warning')
    expect(line.textContent).toContain('자정(서울 시간)에 다시 채워져요.')
    // 요금제 화면에는 아직 한도가 없으므로 그 화면으로 잇지 않습니다.
    expect(within(line).queryByRole('link')).toBeNull()

    await submitMessage('서울 SW 사업화 지원 찾아줘')
    // 메시지 해석은 이용량에 들지 않아 다시 읽지 않습니다.
    expect(usage).toHaveBeenCalledOnce()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests).toHaveLength(1)
    expect(await screen.findByText('오늘 9/10회')).toBeTruthy()
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('한도를 다 쓰면 이 조건으로 검색만 막고 안내를 보이며, 메시지 입력과 필터 검색은 그대로 쓴다', async () => {
    const network = mockNetwork()
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue(memberUsage(10))
    renderApp('/app/chat', member)
    const composer = screen.getByRole('textbox', { name: '지원사업 검색어' }).closest('form')!
    expect(await within(composer).findByText(memberLimitMessage)).toBeTruthy()

    const input = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    expect(input.disabled).toBe(false)
    await submitMessage('서울 SW 사업화 지원 찾아줘')
    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    const confirm = within(proposal).getByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!)?.textContent).toBe(memberLimitMessage)
    fireEvent.click(confirm)
    expect(network.searchRequests).toHaveLength(0)

    fireEvent.click(screen.getByRole('tab', { name: '필터 검색' }))
    expect(await screen.findByRole('combobox', { name: '출처' })).toBeTruthy()
    await waitFor(() => expect(network.catalogRequests.length).toBeGreaterThan(0))
    expect(network.searchRequests).toHaveLength(0)
  })

  it('서버가 한도로 검색을 거절하면 shared 안내를 대화에 보여 주고, 다시 읽은 이용량으로 다시 검색을 막는다', async () => {
    mockNetwork(() => quotaProblem())
    const usage = vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage')
      .mockResolvedValueOnce(memberUsage(9)).mockResolvedValue(memberUsage(10))
    renderApp('/app/chat', member)
    await screen.findByText('오늘 9/10회')
    await submitMessage('서울 SW 사업화 지원 찾아줘')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))

    const timeline = screen.getByRole('region', { name: '대화 내역' })
    expect(await within(timeline).findByText(memberLimitMessage)).toBeTruthy()
    expect(within(timeline).queryByText('지원사업을 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeNull()
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(timeline).queryByRole('button', { name: '다시 검색' })).toBeNull())
  })

  it('로그인 전 체험 2회를 다 쓰면 로그인 안내가 담긴 문구를 보여 준다', async () => {
    mockNetwork()
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue(guestUsage(2))
    renderApp('/', null)
    const message = planQuotaExceededMessage({ feature: 'AI_SEARCH', period: 'DAY', limit: 2, resetsAt, plan: null })
    expect(message).toContain('로그인하면 회원 한도로 이어서 검색할 수 있고')
    const line = (await screen.findByText(message)).closest('p')!
    expect(within(line).queryByRole('link')).toBeNull()
  })

  it('아직 한도를 정하지 않은 요금제는 이용량 줄을 그리지 않고 검색을 막지 않는다', async () => {
    const network = mockNetwork()
    const usage = vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage')
      .mockResolvedValue({ plan: 'PREMIUM', items: [aiSearch(500, null)] })
    renderApp('/app/chat', member)
    await waitFor(() => expect(usage).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByText(/오늘 \d+/)).toBeNull()

    await submitMessage('서울 SW 사업화 지원 찾아줘')
    const confirm = screen.getByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    await act(async () => fireEvent.click(confirm))
    expect(network.searchRequests).toHaveLength(1)
  })
})
