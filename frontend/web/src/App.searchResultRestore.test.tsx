// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { supportPrograms } from './data/fixtures/supportPrograms'
import type { Account } from './domain/entities/Account'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from './data/fixtures/supportProgramConversation'
import { interpretationStarted } from './presentation/features/chat/state/chatSlice'
import { sessionRestored, signedOut } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({ CoreApiConnectionStatus: () => null }))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({
  useSupportProgramSearchReadiness: () => ({
    canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
    data: { searchState: 'SEARCHABLE', programCount: 10, indexReady: true,
      lastSuccessfulSyncAt: null, lastFailedSyncAt: null, sources: [{ sourceCode: 'BIZINFO', sourceName: '기업마당',
        searchState: 'SEARCHABLE', programCount: 10, indexReady: true, lastSuccessfulSyncAt: null, lastFailedSyncAt: null }] },
  }),
}))

const token = 'ce5a0b64-5496-47e4-8bab-05392e7661c9'
const returnTo = '/app/chat?searchResult=' + token
const account = { email: 'member@example.test', role: 'USER' as const, tier: 'MEMBER' as const, emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const originals = [4, 2, 5, 1, 3].map((index) => ({ ...supportPrograms[0]!, id: 'original-' + index, title: '선택한 검색 공고 ' + index }))
const restored = { query: seoulConversationContext.query, context: seoulConversationContext,
  programs: originals, totalCount: originals.length, resultToken: null, expiresAt: null }

beforeEach(() => {
  // 관심 조회는 별도 검증하며, 여기서는 검색·검색 결과 복원 요청 횟수만 확인합니다.
  vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute').mockResolvedValue([])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(restored)))
  vi.spyOn(appContainer.resolve('signUpUseCase'), 'execute').mockResolvedValue({
    outcome: 'session', session: { account, expiresAt: '2026-12-01T00:00:00+09:00' },
  })
  vi.spyOn(appContainer.resolve('sendSignupEmailCodeUseCase'), 'execute').mockResolvedValue({ outcome: 'sent' })
  vi.spyOn(appContainer.resolve('verifySignupEmailCodeUseCase'), 'execute').mockResolvedValue({ outcome: 'verified', passToken: 'b'.repeat(43) })
  vi.spyOn(appContainer.resolve('logInUseCase'), 'execute').mockResolvedValue({
    outcome: 'session', session: { account, expiresAt: '2026-12-01T00:00:00+09:00' },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('가입·로그인 후 선택한 검색의 원본 복원', () => {
  it('가입과 로그인 화면을 왕복해도 선택한 검색의 next를 유지한다', () => {
    renderApp('/signup?next=' + encodeURIComponent(returnTo))
    const loginLink = screen.getByRole('link', { name: '로그인' })
    expect(loginLink.getAttribute('href')).toBe('/login?next=' + encodeURIComponent(returnTo))
    fireEvent.click(loginLink)
    expect(screen.getByRole('form', { name: '로그인' })).toBeTruthy()
    const signupLink = screen.getByRole('link', { name: '회원가입' })
    expect(signupLink.getAttribute('href')).toBe('/signup?next=' + encodeURIComponent(returnTo))
    fireEvent.click(signupLink)
    expect(screen.getByRole('form', { name: '회원가입' })).toBeTruthy()
    expect(new URLSearchParams(locationText().split('?')[1]).get('next')).toBe(returnTo)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['signup', 'login'] as const)('%s 성공 후 추가 검색 없이 선택한 원본 5개와 조건만 복원한다', async (entry) => {
    const { store } = renderApp('/' + entry + '?next=' + encodeURIComponent(returnTo))
    await submitAuth(entry)
    await waitFor(() => expect(store.getState().chat.messages.at(-1)?.programs).toEqual(originals))
    expect(locationText()).toBe('/app/chat')
    expect(screen.getAllByRole('link', { name: '상세 조건 보기' })).toHaveLength(5)
    expect(store.getState().chat.messages).toHaveLength(3)
    expect(store.getState().chat.messages.some((message) => message.text.includes('이전 다른 대화'))).toBe(false)
    expect(store.getState().chat.confirmedSearch).toEqual({
      query: seoulConversationContext.query, acceptingOnly: seoulConversationContext.acceptingOnly,
      companyConditions: seoulConversationContext.companyConditions,
    })
    expect(store.getState().chat.lastSearch).toEqual({ context: seoulConversationContext, resultCount: 5 })
    expect(fetch).toHaveBeenCalledOnce()
    const fetchMock = vi.mocked(fetch)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/support-programs/search/results')
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ resultToken: token })

    act(() => store.dispatch(signedOut()))
    await screen.findByRole('form', { name: '로그인' })
    expect(locationText()).not.toContain(token)
    expect(store.getState().chat.messages).toHaveLength(1)
    expect(store.getState().chat.lastSearch).toBeNull()
  })

  it('비회원이 복원 경로에 직접 들어오면 로그인·가입 링크를 거쳐 같은 선택으로 돌아온다', async () => {
    const { store } = renderApp(returnTo)
    expect(screen.getByRole('form', { name: '로그인' })).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('link', { name: '회원가입' }))
    expect(screen.getByRole('form', { name: '회원가입' })).toBeTruthy()
    await submitAuth('signup')
    await waitFor(() => expect(store.getState().chat.messages.at(-1)?.programs).toEqual(originals))
    expect(fetch).toHaveBeenCalledOnce()
    expect(locationText()).toBe('/app/chat')
  })
})

describe('회원 검색에 도착한 비회원 미리보기의 전체 공개', () => {
  const limited = { query: restored.query, programs: originals.slice(0, 2), totalCount: 5,
    resultToken: token, expiresAt: '2026-12-01T00:00:00Z' }

  it.each(['USER', 'ADMIN'] as const)('%s는 잠금 응답을 받으면 같은 결과를 한 번 복원해 5개를 표시한다', async (role) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(limited)).mockResolvedValueOnce(Response.json(restored))
    vi.stubGlobal('fetch', fetchMock)
    const store = await startSearch({ ...account, role, tier: role === 'ADMIN' ? 'ADMIN' : 'MEMBER' })
    await waitFor(() => expect(screen.getAllByRole('link', { name: '상세 조건 보기' })).toHaveLength(5))
    expect(screen.queryByRole('region', { name: '추가 검색 결과' })).toBeNull()
    expect(store.getState().chat.messages.at(-1)?.programs).toEqual(originals)
    expect(store.getState().chat.lastSearch?.resultCount).toBe(5)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/search$/)
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/search\/results$/)
    expect(fetchMock.mock.calls[1][1].credentials).toBe('include')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ resultToken: token })
  })

  it('비회원에게는 2개와 잠금을 표시하고 전체 복원을 요청하지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(limited))
    vi.stubGlobal('fetch', fetchMock)
    await startSearch(null)
    expect(await screen.findByRole('heading', { name: '추가 지원사업 3건이 있어요' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: '상세 조건 보기' })).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('회원 검색이 이미 전체 결과를 받았다면 추가 요청하지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(restored))
    vi.stubGlobal('fetch', fetchMock)
    await startSearch(account)
    await screen.findByRole('region', { name: '지원사업 검색 결과' })
    expect(screen.getAllByRole('link', { name: '상세 조건 보기' })).toHaveLength(5)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [401, '로그인 상태를 확인하지 못했습니다. 새로고침한 뒤 다시 로그인해 주세요.'],
    [410, '검색 결과 보관 시간이 지났거나 확인할 수 없는 결과입니다. 새로 검색해 주세요.'],
    [503, '검색 결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  ])('전체 복원 HTTP %s는 회원에게 가입 안내를 표시하지 않고 오류로 알린다', async (status, message) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(limited)).mockResolvedValueOnce(new Response(null, { status: Number(status) }))
    vi.stubGlobal('fetch', fetchMock)
    await startSearch(account)
    await screen.findByText(message)
    expect(screen.queryByRole('region', { name: '지원사업 검색 결과' })).toBeNull()
    expect(screen.queryByRole('link', { name: '회원가입하고 전체 보기' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['cancel', 'logout'] as const)('전체 복원 중 %s는 요청을 취소하고 늦은 결과를 반영하지 않는다', async (action) => {
    let complete!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { complete = resolve })
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(limited)).mockReturnValueOnce(pending)
    vi.stubGlobal('fetch', fetchMock)
    const store = await startSearch(account)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: '지원사업 검색 결과' })).toBeNull()
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal
    if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: '취소' }))
    else act(() => store.dispatch(signedOut()))
    expect(signal.aborted).toBe(true)
    await act(async () => { complete(Response.json(restored)); await pending })
    expect(screen.queryByRole('region', { name: '지원사업 검색 결과' })).toBeNull()
    expect(store.getState().chat.messages.some((message) => message.programs)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('복원 응답의 검색 의도가 다르면 다른 검색 결과로 표시하지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(limited)).mockResolvedValueOnce(Response.json({
      ...restored, query: '다른 검색', context: { ...restored.context, query: '다른 검색' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await startSearch(account)
    await screen.findByText('검색 결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
    expect(screen.queryByRole('region', { name: '지원사업 검색 결과' })).toBeNull()
  })
})

async function startSearch(currentAccount: Account | null) {
  vi.spyOn(appContainer.resolve('interpretSupportProgramConversationUseCase'), 'execute')
    .mockResolvedValue(readyConversationProposal(seoulConversationContext))
  const store = createAppStore()
  store.dispatch(sessionRestored(currentAccount))
  render(<Provider store={store}><MemoryRouter initialEntries={[currentAccount ? '/app/chat' : '/']}>
    <App />
  </MemoryRouter></Provider>)
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  fireEvent.change(input, { target: { value: restored.query } })
  await act(async () => fireEvent.submit(input.closest('form')!))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
  return store
}

function renderApp(path: string) {
  const store = createAppStore()
  store.dispatch(sessionRestored(null))
  store.dispatch(interpretationStarted({ message: '이전 다른 대화', context: emptyConversationContext, pendingClarification: null }))
  return { ...render(<Provider store={store}><MemoryRouter initialEntries={[path]}>
    <App /><CurrentLocation />
  </MemoryRouter></Provider>), store }
}
function CurrentLocation() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}
function locationText() { return screen.getByTestId('location').textContent ?? '' }
async function submitAuth(entry: 'signup' | 'login') {
  const form = screen.getByRole('form', { name: entry === 'signup' ? '회원가입' : '로그인' })
  fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: account.email } })
  if (entry === 'signup') {
    // 가입은 인증번호를 맞힌 뒤에만 보낼 수 있습니다.
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: '인증번호 받기' })) })
    fireEvent.change(await within(form).findByLabelText('인증번호'), { target: { value: '482137' } })
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: '확인' })) })
    await within(form).findByText('인증됨')
  }
  fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'welcome-12' } })
  if (entry === 'signup') fireEvent.change(within(form).getByLabelText('비밀번호 확인'), { target: { value: 'welcome-12' } })
  await act(async () => fireEvent.submit(form))
}
