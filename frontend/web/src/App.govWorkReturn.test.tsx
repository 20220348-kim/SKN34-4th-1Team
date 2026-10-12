// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import { emptyConversationContext } from './data/fixtures/supportProgramConversation'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { govMessageSucceeded, interpretationStarted } from './presentation/features/chat/state/chatSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({ CoreApiConnectionStatus: () => null }))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({ useSupportProgramSearchReadiness: () => ({
  canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
  data: { searchState: 'SEARCHABLE', programCount: 10, indexReady: true, sources: [] },
}) }))

const admin: Account = { email: 'admin@test.local', tier: 'ADMIN', role: 'ADMIN', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }

// 화면이 부르는 API는 응답하지 않게 두고 이동과 [대화로 돌아가기]만 봅니다.
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('Gov 대화를 떠나 신청 문서 화면으로 가면 [대화로 돌아가기]로 같은 대화에 돌아오고, 다른 화면에는 두지 않는다', async () => {
  const store = createAppStore()
  store.dispatch(sessionRestored(admin))
  await act(async () => { render(<Provider store={store}><MemoryRouter initialEntries={['/app/chat']}><App /></MemoryRouter></Provider>) })
  const started = interpretationStarted({ message: '신청 자격 알려줘', context: emptyConversationContext })
  act(() => {
    store.dispatch(started)
    store.dispatch(govMessageSucceeded({ requestId: started.payload.requestId, message: '먼저 검색 결과에서 공고를 선택해 주세요.', needsProgram: true }))
  })
  const sidebar = () => screen.getByRole('complementary', { name: '작업 사이드바' })
  await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /신청 문서 작성/ })))
  const back = screen.getByRole('link', { name: '대화로 돌아가기' })
  expect(back.getAttribute('href')).toBe('/app/chat')
  // 신청 문서 · 중복 검토 · 파트너 화면이 아닌 곳에는 두지 않습니다.
  await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /관심 공고함/ })))
  expect(screen.queryByRole('link', { name: '대화로 돌아가기' })).toBeNull()
  await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /중복 지원·수혜 검토/ })))
  await act(async () => fireEvent.click(screen.getByRole('link', { name: '대화로 돌아가기' })))
  expect(screen.getByText('먼저 검색 결과에서 공고를 선택해 주세요.')).toBeTruthy()
  expect(screen.queryByRole('link', { name: '대화로 돌아가기' })).toBeNull()
  expect(store.getState().chat.returnToGovChat).toBe(false)
})
