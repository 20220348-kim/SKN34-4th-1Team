// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import type { AdminAccountDetail, AdminAccountPage, AdminAccountStats, AdminAccountSummary } from './domain/entities/AdminAccount'
import { adminAccountDetailMessages } from './presentation/features/admin/viewmodel/useAdminAccountDetailViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { chooseOption, selectedValue } from './test/selectField'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const adminAccount: Account = { email: 'admin@govbiz.local', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, company: null }

const member: AdminAccountSummary = {
  id: 11,
  email: 'member@company.co.kr',
  role: 'USER',
  tier: 'COMPANY',
  status: 'ACTIVE',
  emailVerified: false,
  hasPassword: true,
  loginMethods: ['EMAIL'],
  company: { companyName: '테스트기업 주식회사', businessNumber: '1248100998' },
  createdAt: '2026-09-01T10:00:00',
  lastLoginAt: '2026-09-10T14:05:30',
  suspendedAt: null,
}

const kakaoMember: AdminAccountSummary = {
  id: 12,
  email: 'kakao@kakao.com',
  role: 'USER',
  tier: 'MEMBER',
  status: 'SUSPENDED',
  emailVerified: true,
  hasPassword: false,
  loginMethods: ['KAKAO'],
  company: null,
  createdAt: '2026-09-05T09:00:00',
  lastLoginAt: null,
  suspendedAt: '2026-09-10T15:00:00',
}

const accountPage: AdminAccountPage = { accounts: [member, kakaoMember], total: 2, page: 1, pageSize: 20, totalPages: 1 }
const stats: AdminAccountStats = { total: 2, companyRegistered: 1, socialLinked: 1, suspended: 1, admins: 1, joinedRecently: 2, recentJoinDays: 7 }
const allAccountsQuery = { keyword: '', status: '', role: '', loginMethod: '', sort: 'RECENT', page: 1 }

function detailOf(account: AdminAccountSummary, overrides: Partial<AdminAccountDetail> = {}): AdminAccountDetail {
  return {
    account,
    company: account.company === null ? null : { ...account.company, region: '서울특별시', industry: '정보통신업', foundedYear: 2021 },
    activity: { recruitmentCount: 2, openRecruitmentCount: 1, sentProposalCount: 3, activeSessionCount: 1 },
    actions: [],
    isSelf: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  vi.spyOn(appContainer.resolve('browseAdminAccountsUseCase'), 'execute').mockResolvedValue(accountPage)
  vi.spyOn(appContainer.resolve('getAdminAccountStatsUseCase'), 'execute').mockResolvedValue(stats)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('관리자 계정 관리', () => {
  it('목록은 요약·검색 결과·계정 표를 보여 주고 조건을 바꾸면 첫 페이지부터 다시 읽는다', async () => {
    const browse = appContainer.resolve('browseAdminAccountsUseCase').execute as ReturnType<typeof vi.fn>
    renderApp('/app/admin/accounts')

    expect(await screen.findByRole('heading', { level: 2, name: '검색 결과 2건' })).toBeTruthy()
    expect(within(await screen.findByRole('group', { name: '계정 요약' })).getByText('최근 7일 가입')).toBeTruthy()
    const table = screen.getByRole('region', { name: '계정 표 가로 스크롤' })
    expect(within(table).getByRole('link', { name: 'member@company.co.kr' }).getAttribute('href')).toBe('/app/admin/accounts/detail?accountId=11')
    expect(within(table).getByText('테스트기업 주식회사')).toBeTruthy()
    expect(within(table).getByText('2026-09-10 14:05')).toBeTruthy()
    // 로그인한 적 없는 계정은 기록 없음, 소셜 전용 계정은 로그인 방법에 공급자만 보입니다.
    expect(within(table).getByText('기록 없음')).toBeTruthy()
    expect(within(table).getByText('카카오')).toBeTruthy()
    expect(browse).toHaveBeenLastCalledWith(allAccountsQuery, expect.any(AbortSignal))

    chooseOption(screen.getByRole('combobox', { name: '상태' }), 'SUSPENDED')
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'SUSPENDED', page: 1 }), expect.any(AbortSignal),
    ))
    chooseOption(screen.getByRole('combobox', { name: '로그인 방법' }), 'KAKAO')
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'SUSPENDED', loginMethod: 'KAKAO' }), expect.any(AbortSignal),
    ))

    // 검색어는 조회를 눌러야 적용됩니다.
    const search = screen.getByRole('form', { name: '계정 검색' })
    fireEvent.change(within(search).getByRole('searchbox', { name: '계정 검색' }), { target: { value: ' kakao ' } })
    expect(browse).not.toHaveBeenCalledWith(expect.objectContaining({ keyword: 'kakao' }), expect.anything())
    fireEvent.click(within(search).getByRole('button', { name: '조회' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      { keyword: 'kakao', status: 'SUSPENDED', role: '', loginMethod: 'KAKAO', sort: 'RECENT', page: 1 }, expect.any(AbortSignal),
    ))

    fireEvent.click(screen.getByRole('button', { name: '조건 초기화' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(allAccountsQuery, expect.any(AbortSignal)))
    expect((within(search).getByRole('searchbox', { name: '계정 검색' }) as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('button', { name: '조건 초기화' })).toBeNull()
  })

  it('주소의 조건으로 목록을 열고 모르는 값은 기본값으로 둔다', async () => {
    const browse = appContainer.resolve('browseAdminAccountsUseCase').execute as ReturnType<typeof vi.fn>
    renderApp('/app/admin/accounts?status=SUSPENDED&role=BOGUS&sort=LAST_LOGIN&page=2')

    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      { keyword: '', status: 'SUSPENDED', role: '', loginMethod: '', sort: 'LAST_LOGIN', page: 2 }, expect.any(AbortSignal),
    ))
    expect(selectedValue(screen.getByRole('combobox', { name: '정렬' }))).toBe('LAST_LOGIN')
    expect(selectedValue(screen.getByRole('combobox', { name: '권한' }))).toBe('')
  })

  it('상세에서 사유를 적어 정지하면 최신 상세와 결과 안내를 보여 준다', async () => {
    vi.spyOn(appContainer.resolve('getAdminAccountDetailUseCase'), 'execute').mockResolvedValue(detailOf(member))
    const suspended = detailOf({ ...member, status: 'SUSPENDED', suspendedAt: '2026-09-11T09:30:00' }, {
      activity: { recruitmentCount: 2, openRecruitmentCount: 1, sentProposalCount: 3, activeSessionCount: 0 },
      actions: [{ id: 1, action: 'SUSPEND', reason: '스팸 제안 반복', adminEmail: 'admin@govbiz.local', createdAt: '2026-09-11T09:30:00' }],
    })
    const act = vi.spyOn(appContainer.resolve('takeAdminAccountActionUseCase'), 'execute').mockResolvedValue({ outcome: 'done', detail: suspended })
    renderApp('/app/admin/accounts/detail?accountId=11')

    const info = await screen.findByRole('region', { name: '계정 정보' })
    expect(within(info).getByRole('heading', { name: 'member@company.co.kr' })).toBeTruthy()
    // 머리글의 상위 화면 이름(계정 관리)을 누르면 목록으로 돌아갑니다.
    expect(within(screen.getByRole('navigation', { name: '상위 화면' })).getByRole('link', { name: '계정 관리' }).getAttribute('href')).toBe('/app/admin/accounts')
    expect(within(screen.getByRole('region', { name: '기업 정보' })).getByText('124-81-00998')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '활동' })).getByText('2건 (모집 중 1건)')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '조치 기록' })).getByText('조치 기록이 없습니다.')).toBeTruthy()

    fireEvent.click(within(info).getByRole('button', { name: '정지' }))
    const dialog = screen.getByRole('dialog', { name: '계정을 정지할까요?' })
    const confirm = within(dialog).getByRole('button', { name: '정지' }) as HTMLButtonElement
    // 사유가 없으면 보내지 않습니다.
    expect(confirm.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('사유 (조치 기록에 남습니다)'), { target: { value: '  스팸 제안 반복 ' } })
    fireEvent.click(confirm)

    await waitFor(() => expect(act).toHaveBeenCalledWith(11, 'suspend', '스팸 제안 반복'))
    expect(await screen.findByText(adminAccountDetailMessages.done.suspend)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    const updated = screen.getByRole('region', { name: '계정 정보' })
    expect(within(updated).getByRole('button', { name: '정지 해제' })).toBeTruthy()
    expect(within(updated).queryByRole('button', { name: '강제 로그아웃' })).toBeNull()
    expect(within(updated).getByText('2026-09-11 09:30')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '조치 기록' })).getByText('스팸 제안 반복')).toBeTruthy()
  })

  it('다른 관리자가 먼저 상태를 바꿨으면 안내하고 상세를 다시 읽는다', async () => {
    const getDetail = vi.spyOn(appContainer.resolve('getAdminAccountDetailUseCase'), 'execute')
      .mockResolvedValueOnce(detailOf(member))
      .mockResolvedValueOnce(detailOf({ ...member, status: 'SUSPENDED', suspendedAt: '2026-09-11T09:30:00' }))
    vi.spyOn(appContainer.resolve('takeAdminAccountActionUseCase'), 'execute').mockResolvedValue({ outcome: 'conflict' })
    renderApp('/app/admin/accounts/detail?accountId=11')

    fireEvent.click(within(await screen.findByRole('region', { name: '계정 정보' })).getByRole('button', { name: '강제 로그아웃' }))
    const dialog = screen.getByRole('dialog', { name: '모든 기기에서 로그아웃할까요?' })
    fireEvent.change(within(dialog).getByLabelText('사유 (조치 기록에 남습니다)'), { target: { value: '기기 분실 신고' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '강제 로그아웃' }))

    expect(await screen.findByText(adminAccountDetailMessages.conflict)).toBeTruthy()
    await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2))
    expect(await within(screen.getByRole('region', { name: '계정 정보' })).findByRole('button', { name: '정지 해제' })).toBeTruthy()
  })

  it('내 계정은 조치 버튼 대신 까닭을 보여 주고, 없는 계정은 안내한다', async () => {
    const self: AdminAccountSummary = { ...member, id: 1, email: 'admin@govbiz.local', role: 'ADMIN', tier: 'ADMIN', company: null }
    vi.spyOn(appContainer.resolve('getAdminAccountDetailUseCase'), 'execute')
      .mockImplementation(async (id) => (id === 1 ? detailOf(self, { isSelf: true }) : null))
    renderApp('/app/admin/accounts/detail?accountId=1')

    const info = await screen.findByRole('region', { name: '계정 정보' })
    expect(within(info).queryByRole('group', { name: '계정 조치' })).toBeNull()
    expect(within(info).getByText(/자기 계정에는 조치할 수 없습니다/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '기업 정보' })).getByText('등록한 기업이 없습니다.')).toBeTruthy()

    cleanup()
    renderApp('/app/admin/accounts/detail?accountId=99')
    expect(await screen.findByText(/계정을 찾을 수 없습니다/)).toBeTruthy()
  })
})

function renderApp(initialEntry: string, account: Account = adminAccount) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}
