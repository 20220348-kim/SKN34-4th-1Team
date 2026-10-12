// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, type NavigateFunction, useNavigate } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import { supportPrograms } from './data/fixtures/supportPrograms'
import { emptyConversationContext } from './data/fixtures/supportProgramConversation'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { govMessageSucceeded, interpretationStarted } from './presentation/features/chat/state/chatSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({ CoreApiConnectionStatus: () => null }))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({ useSupportProgramSearchReadiness: () => ({
  canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
  data: { searchState: 'SEARCHABLE', programCount: 10, indexReady: true, sources: [] },
}) }))

const admin: Account = { email: 'admin@test.local', tier: 'ADMIN', role: 'ADMIN', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const program = { sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id, title: supportPrograms[0].title }

// 화면이 부르는 API는 응답하지 않게 두고 이동과 [대화로 돌아가기]만 봅니다. 신청 문서 카드는 내 신청 준비를 읽는 중이라 목록 링크를 둡니다.
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

let navigateTo: NavigateFunction
function NavigateProbe() {
  navigateTo = useNavigate()
  return null
}

async function startGovChat() {
  const store = createAppStore()
  store.dispatch(sessionRestored(admin))
  await act(async () => { render(<Provider store={store}><MemoryRouter initialEntries={['/app/chat']}><App /><NavigateProbe /></MemoryRouter></Provider>) })
  const started = interpretationStarted({ message: '신청서 써 줘', context: emptyConversationContext })
  act(() => {
    store.dispatch(started)
    store.dispatch(govMessageSucceeded({ requestId: started.payload.requestId, message: '양식을 확인하고 신청 준비를 시작해 주세요.',
      application: { program, message: '양식을 확인하고 신청 준비를 시작해 주세요.' } }))
  })
  return store
}

const sidebar = () => screen.getByRole('complementary', { name: '작업 사이드바' })
const returnLink = () => screen.queryByRole('link', { name: '대화로 돌아가기' })

it('사이드바 메뉴로 Gov 대화를 떠나면 맨 위 메뉴로 옮긴 것이라 [대화로 돌아가기]를 두지 않는다', async () => {
  const store = await startGovChat()
  await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /신청 문서 작성/ })))
  expect(returnLink()).toBeNull()
  expect(store.getState().chat.returnToGovChat).toBe(false)
})

it('대화 카드에서 넘어온 작업 화면 묶음에만 [대화로 돌아가기]를 두고, 묶음을 벗어나면 다시 와도 두지 않는다', async () => {
  const store = await startGovChat()
  await act(async () => fireEvent.click(screen.getByRole('link', { name: '신청 문서 화면에서 확인하기' })))
  expect(returnLink()?.getAttribute('href')).toBe('/app/chat')
  // 같은 신청 문서 화면 안에서 옮기면 그대로 둡니다.
  await act(async () => navigateTo('/app/application-preparations/12'))
  expect(returnLink()).not.toBeNull()
  // 다른 메뉴로 옮기면 지우고, 신청 문서 화면에 다시 와도 남지 않습니다.
  await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /중복 지원·수혜 검토/ })))
  expect(returnLink()).toBeNull()
  await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /신청 문서 작성/ })))
  expect(returnLink()).toBeNull()
  expect(store.getState().chat.returnToGovChat).toBe(false)
})

it('[대화로 돌아가기]는 같은 대화로 돌아오고 표시를 지운다', async () => {
  const store = await startGovChat()
  await act(async () => fireEvent.click(screen.getByRole('link', { name: '신청 문서 화면에서 확인하기' })))
  await act(async () => fireEvent.click(returnLink()!))
  expect(screen.getAllByText('양식을 확인하고 신청 준비를 시작해 주세요.').length).toBeGreaterThan(0)
  expect(returnLink()).toBeNull()
  expect(store.getState().chat.returnToGovChat).toBe(false)
})
