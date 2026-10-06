// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { supportProgramDetails, supportPrograms } from './data/fixtures/supportPrograms'
import type { Account } from './domain/entities/Account'
import type { SavedSupportProgram } from './domain/entities/SavedSupportProgram'
import { savedSupportProgramMessages } from './presentation/features/saved-programs/viewmodel/useSavedProgramCalendarViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { searchStarted, searchSucceeded } from './presentation/features/chat/state/chatSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const memberAccount: Account = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const program = supportPrograms[0]!
const saved: SavedSupportProgram[] = [
  { savedAt: '2026-09-12T10:00:00', program },
  { savedAt: '2026-09-10T09:30:00', program: { ...supportPrograms[1]!, applicationEndDate: null } },
]
const detailPath = `/app/support-programs/detail?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.id })}`

beforeEach(() => {
  // 달력은 이번 달만 보여 주므로 fixture 공고의 접수 기간 안으로 날짜만 고정합니다. 타이머는 실제로 실행합니다.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-10T03:00:00Z'))
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('관심 공고함', () => {
  it('AI 검색의 반복 공고에서 관심을 함께 반영하고 상세·관심 공고함에서도 유지한다', async () => {
    let stored = false
    const browse = vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute')
      .mockImplementation(async () => stored ? [saved[0]!] : [])
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0]!)
    vi.spyOn(appContainer.resolve('checkSavedSupportProgramUseCase'), 'execute').mockImplementation(async () => stored)
    const save = vi.spyOn(appContainer.resolve('saveSupportProgramUseCase'), 'execute').mockImplementation(async () => {
      stored = true
      return { outcome: 'saved', saved: saved[0]! }
    })
    const remove = vi.spyOn(appContainer.resolve('removeSavedSupportProgramUseCase'), 'execute').mockImplementation(async () => { stored = false })
    const store = createAppStore()
    renderApp('/app/chat', memberAccount, null, store)
    // AI 호출 없이 서버 검색 결과가 Redux에 도착한 다음부터 검증합니다.
    act(() => {
      for (const query of ['서울 지원', '창업 지원']) {
        const started = searchStarted(query)
        store.dispatch(started)
        store.dispatch(searchSucceeded({ requestId: started.payload.requestId, programs: [program], totalCount: 1,
          resultToken: null, expiresAt: null }))
      }
    })
    const resultButtons = () => screen.getAllByRole('button', { name: /관심 공고 저장/ })
    await waitFor(() => expect(resultButtons().every((button) => !button.hasAttribute('disabled'))).toBe(true))
    expect(browse).toHaveBeenCalledOnce()
    expect(resultButtons()).toHaveLength(2)
    fireEvent.click(resultButtons()[0]!)
    await waitFor(() => expect(resultButtons().every((button) => button.getAttribute('aria-pressed') === 'true')).toBe(true))
    expect(save).toHaveBeenCalledOnce()
    fireEvent.click(resultButtons()[1]!)
    await waitFor(() => expect(resultButtons().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true))
    expect(remove).toHaveBeenCalledOnce()
    fireEvent.click(resultButtons()[0]!)
    await waitFor(() => expect(resultButtons()[0]!.getAttribute('aria-pressed')).toBe('true'))

    fireEvent.click(screen.getAllByRole('link', { name: '상세 조건 보기' })[0]!)
    const detailToggle = await screen.findByRole('button', { name: '관심 공고에서 빼기' })
    expect(detailToggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(detailToggle)
    await screen.findByRole('button', { name: '관심 공고에 담기' })
    fireEvent.click(screen.getByRole('link', { name: '검색 결과로 돌아가기' }))
    await waitFor(() => expect(resultButtons().every((button) => !button.hasAttribute('disabled'))).toBe(true))
    expect(resultButtons().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
    fireEvent.click(resultButtons()[0]!)
    await waitFor(() => expect(resultButtons()[0]!.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(within(screen.getByRole('complementary', { name: '작업 사이드바' })).getByRole('link', { name: '관심 공고함' }))
    expect(await screen.findByRole('link', { name: program.title })).toBeTruthy()
  })

  it('사이드바 메뉴가 관심 공고함을 열고 담은 공고를 최근 순서로 보여 준다', async () => {
    vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute').mockResolvedValue(saved)
    renderApp('/app/chat', memberAccount)

    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    const menu = within(sidebar).getByRole('link', { name: '관심 공고함' })
    expect(menu.getAttribute('href')).toBe('/app/saved-programs')
    fireEvent.click(menu)

    expect(screen.getByRole('heading', { level: 1, name: '관심 공고함' })).toBeTruthy()
    expect(within(sidebar).getByRole('link', { name: '관심 공고함' }).getAttribute('aria-current')).toBe('page')
    await screen.findAllByRole('link', { name: program.title })
    // 기본 보기는 목록(마감 임박순)입니다. 표 행에 담은 날과 [관심 공고에서 빼기][상세 보기]가 있습니다.
    expect(screen.getByRole('tab', { name: '목록' }).getAttribute('aria-selected')).toBe('true')
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('article')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('link', { name: program.title }).getAttribute('href')).toBe(detailPath)
    expect(within(table).getByText('09.12 담음')).toBeTruthy()
    expect(within(table).getByText('기간 없음')).toBeTruthy()
    expect(within(table).getAllByRole('button', { name: '관심 공고에서 빼기' })).toHaveLength(2)
    expect(within(table).queryByRole('link', { name: '상세 보기' })).toBeNull()
  })

  it('담은 공고가 없으면 안내와 지원사업 찾기 링크를 보여 주고, 실패하면 다시 시도한다', async () => {
    const browse = vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute')
      .mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([])
    renderApp('/app/saved-programs', memberAccount)

    expect((await screen.findByRole('alert')).textContent).toContain(savedSupportProgramMessages.failed)
    // 브라우저 제목은 사이드바 메뉴와 같은 화면 이름입니다.
    expect(document.title).toBe('관심 공고함 · GovBiz')
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    // 빈 화면은 공용 EmptyState입니다: 지금 상태(제목) + 한 줄 설명 + 다음 행동 하나.
    const empty = await screen.findByRole('region', { name: savedSupportProgramMessages.emptyTitle })
    expect(empty.textContent).toContain(savedSupportProgramMessages.emptyDescription)
    expect(screen.getByRole('link', { name: '지원사업 찾기' }).getAttribute('href')).toBe('/app/chat')
    expect(browse).toHaveBeenCalledTimes(2)
  })

  it('관심 공고함에서 연 상세는 관심 공고함으로 돌아가고, 저장 버튼으로 담기·빼기를 오간다', async () => {
    vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute').mockResolvedValue(saved)
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0]!)
    vi.spyOn(appContainer.resolve('checkSavedSupportProgramUseCase'), 'execute').mockResolvedValue(true)
    const remove = vi.spyOn(appContainer.resolve('removeSavedSupportProgramUseCase'), 'execute').mockResolvedValue(undefined)
    const save = vi.spyOn(appContainer.resolve('saveSupportProgramUseCase'), 'execute').mockResolvedValue({ outcome: 'saved', saved: saved[0]! })
    renderApp('/app/saved-programs', memberAccount)

    fireEvent.click(await screen.findByRole('link', { name: program.title }))
    await screen.findByRole('heading', { name: program.title })
    // 상세 위 돌아가기 링크가 관심 공고함을 가리킵니다.
    expect(screen.getByRole('link', { name: '관심 공고함으로 돌아가기' }).getAttribute('href')).toBe('/app/saved-programs')
    expect(screen.queryByRole('link', { name: '검색 결과로 돌아가기' })).toBeNull()
    // 관심 공고함에서 연 상세는 사이드바도 관심 공고함이 켜진 채이고, 검색 탭 줄은 없습니다.
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    expect(within(sidebar).getByRole('link', { name: '관심 공고함' }).getAttribute('aria-current')).toBe('page')
    expect(within(sidebar).getByRole('button', { name: '지원사업 새검색' }).getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('tablist', { name: '지원사업 검색 방식' })).toBeNull()

    // 저장 버튼은 책갈피 아이콘 하나이고 이름·눌림 상태로 담김 여부를 알립니다.
    const toggle = await screen.findByRole('button', { name: '관심 공고에서 빼기' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('관심 공고에서 빼기')
    expect(toggle.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
    expect(screen.queryByRole('link', { name: '관심 공고함 보기' })).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ sourceCode: program.sourceCode, sourceProgramId: program.id }, expect.any(AbortSignal)))
    // 알림 문장은 접어 두었으므로 버튼 이름·눌림 상태로만 결과를 확인합니다.
    const unsaved = await screen.findByRole('button', { name: '관심 공고에 담기' })
    expect(unsaved.getAttribute('aria-pressed')).toBe('false')
    expect(unsaved.querySelector('svg')?.getAttribute('fill')).toBe('none')
    fireEvent.click(unsaved)
    await waitFor(() => expect(save).toHaveBeenCalledWith({ sourceCode: program.sourceCode, sourceProgramId: program.id }, expect.any(AbortSignal)))
    expect((await screen.findByRole('button', { name: '관심 공고에서 빼기' })).getAttribute('aria-pressed')).toBe('true')
    // 로그인 상태에서는 신청 문서 작성으로 바로 갑니다.
    expect(screen.getByRole('link', { name: '이 공고로 신청 문서 작성' }).getAttribute('href')).toBe(
      `/app/application-preparations/new?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.id })}`,
    )
  })

  it('작업 채팅에서 연 상세는 지원사업 찾기로 돌아간다', async () => {
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0]!)
    vi.spyOn(appContainer.resolve('checkSavedSupportProgramUseCase'), 'execute').mockResolvedValue(false)
    renderApp(detailPath, memberAccount, { searchReturnTo: '/app/chat' })

    await screen.findByRole('heading', { name: program.title })
    expect(screen.getByRole('link', { name: '검색 결과로 돌아가기' }).getAttribute('href')).toBe('/app/chat')
    expect((await screen.findByRole('button', { name: '관심 공고에 담기' })).getAttribute('aria-pressed')).toBe('false')
  })
})

function renderApp(initialEntry: string, account: Account | null, state: unknown = null, store = createAppStore()) {
  store.dispatch(sessionRestored(account))
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[{ pathname: initialEntry.split('?')[0]!, search: initialEntry.includes('?') ? `?${initialEntry.split('?')[1]}` : '', state }]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}
