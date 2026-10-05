import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { RefreshControl } from 'react-native'
import { ApiError, apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { DailyReportScreen } from './DailyReportScreen'
import { useDailyReportPush } from '../notifications/DailyReportPushProvider'
import { documentProgram } from '../test/applicationDocumentFixtures'

jest.mock('expo-router', () => ({ useFocusEffect: (effect: () => () => void) => {
  const React = jest.requireActual<typeof import('react')>('react')
  React.useEffect(effect, [effect])
} }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../notifications/DailyReportPushProvider', () => ({ useDailyReportPush: jest.fn(() => ({
  settings: { enabled: false, available: true, schedulerEnabled: true, sendHour: 8 }, busy: false, error: null, refresh: jest.fn(), toggle: jest.fn(),
})) }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))

const settings = {
  supportPurpose: '', enabled: false, emailConfirmed: false,
  emailDeliveryAvailable: true, schedulerEnabled: true, sendHour: 8,
}
const company = {
  businessNumber: '1234567890', companyName: '새봄테크', businessStatus: '계속사업자', businessStatusCode: '01',
  region: '서울', industry: '정보통신업', foundedYear: 2023, homepageUrl: null,
  businessVerifiedAt: '2026-09-29T09:00:00+09:00', updatedAt: '2026-09-29T09:00:00+09:00',
}
const report = {
  id: 1, reportDate: '2026-09-29', status: 'READY', deliveryStatus: 'SENT',
  companyName: '새봄테크', region: '서울', industry: '정보통신업', supportPurpose: '',
  generatedAt: '2026-09-29T08:00:00+09:00', warnings: [], errorMessage: null,
  programs: [{
    sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123', title: '스마트공장 고도화 지원',
    sourceUrl: 'https://www.bizinfo.go.kr/detail?id=PBLN_123', applicationPeriod: '2026-09-08 ~ 2026-10-03',
    relevanceScore: 92, matchedReasons: ['서울 소재 제조 기업 조건과 일치'],
    eligibilityStatus: 'MATCH', eligibilityNote: '', evidenceStatus: 'UNSUPPORTED', evidenceAnswer: null, citations: [],
  }],
}
const notificationSettings = {
  deadlineReminder: { enabled: false, daysBefore: 3, email: false, push: false },
  emailConfirmed: false, emailDeliveryAvailable: true, pushDeliveryAvailable: true,
  pushDeviceRegistered: false, schedulerEnabled: true, sendHour: 9,
}
const callbacks = { onLogin: jest.fn(), onCompany: jest.fn(), onSearch: jest.fn(), onOpenProgram: jest.fn() }
const invalidateSession = jest.fn().mockResolvedValue(undefined)
const refreshSession = jest.fn()

function signedIn(token = 'first-account') {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: token, account: { email: 'report@example.test' } },
    invalidateSession, refreshSession } as unknown as ReturnType<typeof useAuth>)
}

function respond(path: string, options?: { accessToken?: string }) {
  if (path.endsWith('/settings')) return Promise.resolve(settings)
  if (path.endsWith('/latest')) return Promise.resolve({ report: null })
  if (path === '/api/v1/me/company') return Promise.resolve(company)
  if (path === '/api/v1/me/saved-programs') return Promise.resolve({ programs: [] })
  if (path === '/api/v1/me/notification-settings') return Promise.resolve(notificationSettings)
  throw new Error(`Unexpected request: ${path}, ${options?.accessToken}`)
}

beforeEach(() => {
  Object.values(callbacks).forEach((callback) => callback.mockClear())
  invalidateSession.mockClear(); refreshSession.mockClear()
  jest.mocked(apiRequest).mockReset().mockImplementation(respond)
  signedIn()
  jest.mocked(useDailyReportPush).mockReturnValue({ settings: { enabled: false, available: true, schedulerEnabled: true, sendHour: 8 },
    busy: false, error: null, refresh: jest.fn(), toggle: jest.fn() })
})

test('push notification fetches its exact report instead of the latest report or paid preview', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path === '/api/v1/me/daily-reports/1' ? Promise.resolve({ report }) : respond(path))
  render(<DailyReportScreen {...callbacks} reportId="1" />)
  await screen.findByText('9월 29일 리포트')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/daily-reports/1', expect.objectContaining({ accessToken: 'first-account' }))
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith('/latest') || path.endsWith('/preview'))).toBe(false)
})

test('push-only subscription shows next report timing without requiring email verification', async () => {
  jest.mocked(useDailyReportPush).mockReturnValue({ settings: { enabled: true, available: true, schedulerEnabled: true, sendHour: 8 },
    busy: false, error: null, refresh: jest.fn(), toggle: jest.fn() })
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('다음 리포트는 서울 시간 오전 8시 이후 생성될 예정이에요.')
  fireEvent.press(screen.getByLabelText('수신 설정'))
  expect(screen.getByText('이 기기 앱 알림 끄기')).toBeTruthy()
  expect(screen.getByText('서울 시간 오전 8시 이후 생성되는 리포트를 알려드려요.')).toBeTruthy()
})

test('an afternoon send hour reads as 오후 in the next report message and the email delivery switch', async () => {
  const subscribed = { ...settings, enabled: true, emailConfirmed: true, sendHour: 13 }
  jest.mocked(apiRequest).mockImplementation((path) => path.endsWith('/settings') ? Promise.resolve(subscribed) : respond(path))
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('다음 리포트는 서울 시간 오후 1시 이후 생성될 예정이에요.')
  fireEvent.press(screen.getByLabelText('수신 설정'))
  expect(screen.getByText('매일 오후 1시 이후 정기 이메일 받기')).toBeTruthy()
  expect(screen.queryByText(/오전 13시|매일 13시/)).toBeNull()
})

test('loads the latest owned report and retains its source identity for the detail action', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.endsWith('/latest') ? Promise.resolve({ report }) : respond(path))
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('9월 29일 리포트')
  expect(screen.getByText('관련도 92')).toBeTruthy()
  expect(screen.queryByText('92%')).toBeNull()
  expect(screen.getByText(/메일 서버 접수/)).toBeTruthy()
  fireEvent.press(screen.getByText('상세 보기'))
  expect(callbacks.onOpenProgram).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123' })
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith('/preview'))).toBe(false)
})

test('a saved-list failure keeps the report readable and only a saved-state retry enables bookmarks', async () => {
  let savedReads = 0
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (options?.method === 'DELETE') return Promise.resolve(undefined)
    if (path.endsWith('/latest')) return Promise.resolve({ report })
    if (path === '/api/v1/me/saved-programs') {
      savedReads += 1
      return savedReads === 1 ? Promise.reject(new ApiError(503, '관심 공고 조회 실패'))
        : Promise.resolve({ programs: [{ program: documentProgram, savedAt: '2026-10-04T09:00:00+09:00' }] })
    }
    return respond(path)
  })
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByLabelText('저장 상태 다시 확인')
  expect(screen.getByText('스마트공장 고도화 지원')).toBeTruthy()
  const unknown = screen.getByLabelText('스마트공장 고도화 지원 저장 상태 확인 필요')
  expect(unknown.props.accessibilityState.disabled).toBe(true)
  expect(unknown.props.accessibilityState.selected).toBeUndefined()
  fireEvent.press(unknown)
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST' || options?.method === 'DELETE')).toBe(false)
  fireEvent.press(screen.getByLabelText('상세 보기'))
  expect(callbacks.onOpenProgram).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123' })
  fireEvent.press(screen.getByLabelText('저장 상태 다시 확인'))
  await waitFor(() => expect(screen.getByLabelText('스마트공장 고도화 지원 관심 공고에서 빼기').props.accessibilityState.disabled).toBe(false))
  expect(screen.getByLabelText('스마트공장 고도화 지원 관심 공고에서 빼기').props.accessibilityState.selected).toBe(true)
  expect(savedReads).toBe(2)
  expect(jest.mocked(apiRequest).mock.calls.filter(([path]) => path.endsWith('/latest')).length).toBe(1)
  expect(screen.queryByLabelText('저장 상태 다시 확인')).toBeNull()
  fireEvent.press(screen.getByLabelText('스마트공장 고도화 지원 관심 공고에서 빼기'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/saved-programs?sourceCode=BIZINFO&sourceProgramId=PBLN_123',
    expect.objectContaining({ method: 'DELETE', accessToken: 'first-account' })))
  await screen.findByLabelText('스마트공장 고도화 지원 관심 공고에 저장')
})

test('a pending saved-list response cannot hide the loaded report or leak after switching accounts', async () => {
  let finish!: (value: unknown) => void
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (path.endsWith('/latest') && options?.accessToken === 'first-account') return Promise.resolve({ report })
    if (path === '/api/v1/me/saved-programs' && options?.accessToken === 'first-account') return new Promise(resolve => { finish = resolve })
    return respond(path, options)
  })
  const view = render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('스마트공장 고도화 지원')
  expect(screen.getByLabelText('관심 공고 저장 상태 확인 중')).toBeTruthy()
  expect(screen.getByLabelText('스마트공장 고도화 지원 저장 상태 확인 필요').props.accessibilityState.disabled).toBe(true)
  signedIn('second-account')
  view.rerender(<DailyReportScreen {...callbacks} />)
  await screen.findByText('수신 설정을 켜면 정기 리포트를 받을 수 있어요.')
  await act(async () => finish({ programs: [] }))
  expect(screen.queryByText('스마트공장 고도화 지원')).toBeNull()
  expect(screen.queryByLabelText('저장 상태 다시 확인')).toBeNull()
})

test('an invalid saved-list response is an explicit partial error and a saved-state 401 still invalidates the session', async () => {
  let savedReads = 0
  jest.mocked(apiRequest).mockImplementation((path) => {
    if (path.endsWith('/latest')) return Promise.resolve({ report })
    if (path === '/api/v1/me/saved-programs') {
      savedReads += 1
      return savedReads === 1 ? Promise.resolve({ programs: 'invalid' }) : Promise.reject(new ApiError(401, '로그인 만료'))
    }
    return respond(path)
  })
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByLabelText('저장 상태 다시 확인')
  expect(screen.getByText('스마트공장 고도화 지원')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('저장 상태 다시 확인'))
  await waitFor(() => expect(invalidateSession).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText('스마트공장 고도화 지원 저장 상태 확인 필요').props.accessibilityState.disabled).toBe(true)
})

test.each(['예산 소진 시까지', '예산소진시까지', '상시 접수', '상시'])('shows rolling period %s as open without an invented deadline', async (applicationPeriod) => {
  jest.mocked(apiRequest).mockImplementation((path) => path.endsWith('/latest') ? Promise.resolve({ report: {
    ...report, programs: [{ ...report.programs[0], applicationPeriod }],
  } }) : respond(path))
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText(applicationPeriod)
  expect(screen.getByText('접수 중')).toBeTruthy()
  expect(screen.queryByText(/^D-\d+$/)).toBeNull()
  expect(screen.queryByText('접수 상태 미확인')).toBeNull()
})

test.each(['공고문 참조', '상시 접수 (접수 종료)'])('keeps unresolved or ended rolling period %s from being labelled open', async (applicationPeriod) => {
  jest.mocked(apiRequest).mockImplementation((path) => path.endsWith('/latest') ? Promise.resolve({ report: {
    ...report, programs: [{ ...report.programs[0], applicationPeriod }],
  } }) : respond(path))
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText(applicationPeriod)
  expect(screen.getByText('접수 상태 미확인')).toBeTruthy()
  expect(screen.queryByText('접수 중')).toBeNull()
})

test('shows actionable report limitations without repeated green notices or raw collection timestamps', async () => {
  const warnings = [
    '관련도 점수는 검색 조건과 공고의 관련성입니다. 선정확률이나 신청 자격 확정이 아닙니다.',
    '정확한 설립일·매출·인력·제외 요건은 확인하지 않았습니다. 첨부 PDF·HWP와 제출서류 전체는 직접 확인해 주세요.',
    '일부 제공처가 준비 중이거나 최근 수집에 실패했습니다. 현재 검색 가능한 기존 공고만 포함합니다.',
    '기업마당 최근 수집 성공: 2026-09-29T18:46:03.298857+09:00',
  ]
  jest.mocked(apiRequest).mockImplementation((path) => path.endsWith('/latest')
    ? Promise.resolve({ report: { ...report, warnings } }) : respond(path))
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('스마트공장 고도화 지원')
  expect(screen.getByText('일부 제공처 공고가 이번 추천에서 빠졌을 수 있어요.', { exact: false })).toBeTruthy()
  expect(screen.queryByText(/최근 수집 성공/)).toBeNull()
  expect(screen.queryByText(/정확한 설립일·매출/)).toBeNull()
  expect(screen.getByText(/신청 자격과 서류는 공고 원문에서 확인해 주세요/)).toBeTruthy()
})

test('keeps the original empty layout but only offers arrival guidance when all delivery gates are enabled', async () => {
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('수신 설정을 켜면 정기 리포트를 받을 수 있어요.')
  expect(screen.getByText('완성도 67%')).toBeTruthy()
  fireEvent.press(screen.getByText('지원사업 검색하기'))
  expect(callbacks.onSearch).toHaveBeenCalledTimes(1)
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith('/preview'))).toBe(false)
})

test('a missing company keeps the registration action and does not hide other load errors', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path === '/api/v1/me/company'
    ? Promise.reject(new ApiError(404, '미등록', 'COMPANY_NOT_REGISTERED')) : respond(path))
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('기업 정보를 등록하면 지역·업종 조건으로 리포트를 받을 수 있어요.')
  fireEvent.press(screen.getByText('기업 등록하기'))
  expect(callbacks.onCompany).toHaveBeenCalledTimes(1)
  expect(screen.getByText('완성도 0%')).toBeTruthy()
})

test('email verification is explicit and enabling delivery requires consent before saving', async () => {
  const confirmed = { ...settings, emailConfirmed: true }
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (path.endsWith('/settings')) return Promise.resolve(options?.method === 'PUT' ? { ...confirmed, enabled: true } : confirmed)
    return respond(path)
  })
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('수신 설정을 켜면 정기 리포트를 받을 수 있어요.')
  fireEvent.press(screen.getByLabelText('수신 설정'))
  fireEvent.press(screen.getByLabelText('정기 이메일 수신'))
  fireEvent.press(screen.getByText('수신 설정 저장'))
  expect(await screen.findByText('정기 이메일 수신 동의에 체크해 주세요.')).toBeTruthy()
  expect(jest.mocked(apiRequest).mock.calls.some(([path, options]) => path.endsWith('/settings') && options?.method === 'PUT')).toBe(false)
  fireEvent.press(screen.getByLabelText('정기 이메일 수신 동의'))
  fireEvent.press(screen.getByText('수신 설정 저장'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/daily-reports/settings',
    expect.objectContaining({ method: 'PUT', accessToken: 'first-account', body: { supportPurpose: '', enabled: true, consent: true } })))
  await screen.findByText('수신 설정을 저장했어요. 이미 생성된 리포트의 조건은 바뀌지 않아요.')
})

test('email confirmation request is sent only after pressing its action', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.endsWith('/verify-email') ? Promise.resolve(undefined) : respond(path))
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('수신 설정을 켜면 정기 리포트를 받을 수 있어요.')
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith('/verify-email'))).toBe(false)
  fireEvent.press(screen.getByLabelText('수신 설정'))
  fireEvent.press(screen.getByText('이메일 주소 확인 메일 보내기'))
  await screen.findByText('확인 메일을 요청했어요. 메일에서 주소 확인을 마친 뒤 이 화면으로 돌아오세요.')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/daily-reports/verify-email',
    expect.objectContaining({ method: 'POST', accessToken: 'first-account' }))
})

test('does not display a previous account report after the account changes', async () => {
  let resolveOld!: (value: unknown) => void
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (path.endsWith('/latest') && options?.accessToken === 'first-account') {
      return new Promise((resolve) => { resolveOld = resolve })
    }
    return respond(path)
  })
  const view = render(<DailyReportScreen {...callbacks} />)
  signedIn('second-account')
  view.rerender(<DailyReportScreen {...callbacks} />)
  await screen.findByText('수신 설정을 켜면 정기 리포트를 받을 수 있어요.')
  resolveOld({ report })
  expect(screen.queryByText('스마트공장 고도화 지원')).toBeNull()
})

test('refresh keeps an already loaded report visible until the replacement response arrives', async () => {
  let resolveRefresh!: (value: unknown) => void
  let settingsReads = 0
  jest.mocked(apiRequest).mockImplementation((path) => {
    if (path.endsWith('/settings')) {
      settingsReads += 1
      return settingsReads === 1 ? Promise.resolve(settings)
        : new Promise((resolve) => { resolveRefresh = resolve })
    }
    if (path.endsWith('/latest')) return Promise.resolve({ report })
    return respond(path)
  })
  render(<DailyReportScreen {...callbacks} />)
  await screen.findByText('스마트공장 고도화 지원')
  fireEvent(screen.UNSAFE_getByType(RefreshControl), 'refresh')
  expect(screen.getByText('스마트공장 고도화 지원')).toBeTruthy()
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true)
  resolveRefresh(settings)
  await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false))
  expect(settingsReads).toBe(2)
})

test('signed-out users see a login action without a private data request', () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
  render(<DailyReportScreen {...callbacks} />)
  fireEvent.press(screen.getByText('로그인하기'))
  expect(callbacks.onLogin).toHaveBeenCalledTimes(1)
  expect(apiRequest).not.toHaveBeenCalled()
})


test('All settings opens the form directly and saves through the existing API without loading reports', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => path.endsWith('/settings') && options?.method === 'PUT'
    ? Promise.resolve({ ...settings, supportPurpose: '제품 개발' }) : respond(path))
  render(<DailyReportScreen {...callbacks} settingsOnly />)
  await screen.findByLabelText('지원 목적 (선택, 최대 100자)')
  expect(await screen.findByLabelText('관심 공고 마감 알림')).toBeTruthy()
  expect(screen.queryByLabelText('수신 설정')).toBeNull()
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith('/latest') || path.endsWith('/preview') || path.includes('/saved-programs'))).toBe(false)
  fireEvent.changeText(screen.getByLabelText('지원 목적 (선택, 최대 100자)'), '제품 개발')
  fireEvent.press(screen.getByLabelText('수신 설정 저장'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/daily-reports/settings', expect.objectContaining({
    accessToken: 'first-account', method: 'PUT', body: { supportPurpose: '제품 개발', enabled: false, consent: false },
  })))
  await screen.findByText('수신 설정을 저장했어요. 이미 생성된 리포트의 조건은 바뀌지 않아요.')
})
