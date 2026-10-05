// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { AccountApiError } from './data/api/accountApi'
import type { Account } from './domain/entities/Account'
import type { AdminAuditLogPage, AdminAuditLogRecord } from './domain/entities/AdminAuditLog'
import { adminAccessMessages } from './presentation/features/admin/viewmodel/adminAccountAccess'
import { adminAuditLogMessages } from './presentation/features/admin/viewmodel/useAdminAuditLogListViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { chooseOption } from './test/selectField'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const adminAccount: Account = { email: 'admin@govbiz.local', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, company: null, accountType: null, onboarded: true }
const memberAccount: Account = { ...adminAccount, email: 'member@company.co.kr', role: 'USER', tier: 'MEMBER' }

const detailRecord: AdminAuditLogRecord = {
  id: 42,
  action: 'ACCOUNT_DETAIL',
  actorAccountId: 1,
  actorEmail: 'admin@govbiz.local',
  targetAccountId: 11,
  requestSummary: null,
  clientIp: '198.51.100.7',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
  createdAt: '2026-09-06T12:00:09.123456',
}

const listRecord: AdminAuditLogRecord = {
  ...detailRecord,
  id: 41,
  action: 'ACCOUNT_LIST',
  actorAccountId: 7,
  actorEmail: null,
  targetAccountId: null,
  requestSummary: 'keywordLength=5, sort=RECENT, page=1, pageSize=20, returned=3',
  userAgent: null,
  createdAt: '2026-09-06T11:59:00',
}

const allRecords = { actorAccountId: null, targetAccountId: null, action: '', from: '', to: '' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('관리자 감사 기록', () => {
  it('최신 기록을 표로 보여 주고 대상 회원은 상세로 연결한다', async () => {
    const browse = mockBrowse({ records: [detailRecord, listRecord], nextCursor: null })
    renderApp('/app/admin/audit-logs')

    expect(screen.getByRole('heading', { level: 1, name: '감사 기록' })).toBeTruthy()
    const table = await screen.findByRole('region', { name: '감사 기록 표 가로 스크롤' })
    const [detailRow, listRow] = within(table).getAllByRole('row').slice(1)
    expect(within(detailRow!).getByText('2026.09.06 12:00:09')).toBeTruthy()
    expect(within(detailRow!).getByText('회원 상세 조회')).toBeTruthy()
    expect(within(detailRow!).getByText('admin@govbiz.local')).toBeTruthy()
    expect(within(detailRow!).getByText('ID 1')).toBeTruthy()
    expect(within(detailRow!).getByRole('link', { name: 'ID 11' }).getAttribute('href')).toBe('/app/admin/accounts/detail?accountId=11')
    expect(within(detailRow!).getByText('198.51.100.7')).toBeTruthy()
    expect(within(detailRow!).getByTitle('Mozilla/5.0 (Windows NT 10.0)')).toBeTruthy()
    // 계정 행이 없어진 처리자와 여러 회원을 본 목록 조회도 빈칸 없이 보입니다.
    expect(within(listRow!).getByText('계정 정보 없음')).toBeTruthy()
    expect(within(listRow!).getByText('여러 회원')).toBeTruthy()
    expect(within(listRow!).getByText('keywordLength=5, sort=RECENT, page=1, pageSize=20, returned=3')).toBeTruthy()
    expect(browse).toHaveBeenCalledWith(allRecords, null, expect.any(AbortSignal))
    expect(screen.queryByRole('navigation', { name: '감사 기록 쪽' })).toBeNull()
  })

  it('조건은 조회를 눌러 적용하고 주소에 남기며, 잘못된 조건은 보내지 않는다', async () => {
    const browse = mockBrowse({ records: [detailRecord], nextCursor: null })
    renderApp('/app/admin/audit-logs')
    await screen.findByRole('region', { name: '감사 기록 표 가로 스크롤' })
    const form = screen.getByRole('form', { name: '감사 기록 검색' })

    fireEvent.change(within(form).getByLabelText('대상 ID'), { target: { value: '11a' } })
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    expect(within(list()).getByRole('alert').textContent).toBe(adminAuditLogMessages.issues['invalid-account-id'])

    fireEvent.change(within(form).getByLabelText('대상 ID'), { target: { value: ' 11 ' } })
    fireEvent.change(within(form).getByLabelText('시작일'), { target: { value: '2026-09-30' } })
    fireEvent.change(within(form).getByLabelText('종료일'), { target: { value: '2026-09-01' } })
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    expect(within(list()).getByRole('alert').textContent).toBe(adminAuditLogMessages.issues['reversed-period'])
    expect(browse).toHaveBeenCalledTimes(1)

    fireEvent.change(within(form).getByLabelText('시작일'), { target: { value: '2026-09-01' } })
    fireEvent.change(within(form).getByLabelText('종료일'), { target: { value: '2026-09-30' } })
    chooseOption(within(form).getByRole('combobox', { name: '작업' }), 'ACCOUNT_DETAIL')
    fireEvent.change(within(form).getByLabelText('관리자 ID'), { target: { value: '1' } })
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))

    const filtered = { actorAccountId: 1, targetAccountId: 11, action: 'ACCOUNT_DETAIL', from: '2026-09-01', to: '2026-09-30' }
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(filtered, null, expect.any(AbortSignal)))
    expect(screen.getByTestId('location').textContent)
      .toBe('/app/admin/audit-logs?from=2026-09-01&to=2026-09-30&action=ACCOUNT_DETAIL&actorAccountId=1&targetAccountId=11')
    expect(within(list()).queryByRole('alert')).toBeNull()

    // 같은 조건으로 다시 조회하면 최신 기록을 다시 읽습니다.
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    await waitFor(() => expect(browse).toHaveBeenCalledTimes(3))

    fireEvent.click(within(form).getByRole('button', { name: '조건 초기화' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(allRecords, null, expect.any(AbortSignal)))
    expect((within(form).getByLabelText('대상 ID') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('location').textContent).toBe('/app/admin/audit-logs')
  })

  it('주소의 조건으로 열고 모르는 값은 버린다', async () => {
    const browse = mockBrowse({ records: [], nextCursor: null })
    renderApp('/app/admin/audit-logs?action=BOGUS&targetAccountId=11&actorAccountId=-3&from=2026-02-30&to=2026-09-30')

    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      { ...allRecords, targetAccountId: 11, to: '2026-09-30' }, null, expect.any(AbortSignal),
    ))
    expect(await screen.findByText(adminAuditLogMessages.empty)).toBeTruthy()
  })

  it('이전·다음으로 쪽을 오가며 앞 쪽의 마지막 기록 다음부터 읽는다', async () => {
    const browse = vi.spyOn(appContainer.resolve('browseAdminAuditLogsUseCase'), 'execute')
      .mockImplementation(async (_query, before) => (before === null
        ? { records: [detailRecord], nextCursor: 42 }
        : { records: [listRecord], nextCursor: null }))
    renderApp('/app/admin/audit-logs')

    const paging = await screen.findByRole('navigation', { name: '감사 기록 쪽' })
    expect((within(paging).getByRole('button', { name: '이전' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(paging).getByText('1쪽')).toBeTruthy()
    fireEvent.click(within(paging).getByRole('button', { name: '다음' }))

    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(allRecords, 42, expect.any(AbortSignal)))
    expect(await screen.findByText('여러 회원')).toBeTruthy()
    expect(within(paging).getByText('2쪽')).toBeTruthy()
    expect((within(paging).getByRole('button', { name: '다음' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(paging).getByRole('button', { name: '이전' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(allRecords, null, expect.any(AbortSignal)))
    expect(await screen.findByText('ID 11')).toBeTruthy()
  })

  it('불러오지 못하면 다시 시도를, 관리자 권한이 없으면 권한 안내를 보여 준다', async () => {
    const browse = vi.spyOn(appContainer.resolve('browseAdminAuditLogsUseCase'), 'execute')
      .mockRejectedValueOnce(new AccountApiError(503, 'ADMIN_ACCESS_LOG_UNAVAILABLE'))
      .mockResolvedValueOnce({ records: [detailRecord], nextCursor: null })
    renderApp('/app/admin/audit-logs')

    expect(await screen.findByText(adminAuditLogMessages.failed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('region', { name: '감사 기록 표 가로 스크롤' })).toBeTruthy()
    expect(browse).toHaveBeenCalledTimes(2)

    cleanup()
    browse.mockRejectedValue(new AccountApiError(403, 'ADMIN_ACCESS_DENIED'))
    renderApp('/app/admin/audit-logs')
    expect((await screen.findByText(adminAccessMessages.forbidden)).getAttribute('role')).toBe('alert')
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
  })

  it('세션이 끝났으면(401) 지금 주소로 돌아오는 로그인으로 보낸다', async () => {
    vi.spyOn(appContainer.resolve('browseAdminAuditLogsUseCase'), 'execute').mockRejectedValue(new AccountApiError(401, null))
    const { store } = renderApp('/app/admin/audit-logs?action=ACCOUNT_DETAIL')

    expect(await screen.findByRole('form', { name: '로그인' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe(`/login?next=${encodeURIComponent('/app/admin/audit-logs?action=ACCOUNT_DETAIL')}`)
    expect(store.getState().auth.status).toBe('anonymous')
  })

  it('회원은 감사 기록 화면을 열지 못하고 요청도 보내지 않는다', async () => {
    const browse = mockBrowse({ records: [detailRecord], nextCursor: null })
    renderApp('/app/admin/audit-logs', memberAccount)

    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toBe('/app/admin/audit-logs'))
    expect(screen.queryByRole('heading', { name: '감사 기록' })).toBeNull()
    expect(browse).not.toHaveBeenCalled()
  })
})

function list() {
  return screen.getByRole('region', { name: '감사 기록 목록' })
}

function mockBrowse(page: AdminAuditLogPage) {
  return vi.spyOn(appContainer.resolve('browseAdminAuditLogsUseCase'), 'execute').mockResolvedValue(page)
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderApp(initialEntry: string, account: Account = adminAccount) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  const rendered = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </Provider>,
  )
  return { store, ...rendered }
}
