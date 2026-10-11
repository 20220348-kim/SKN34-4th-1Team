import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert, Modal } from 'react-native'
import { apiRequest, ApiError } from '../api/client'
import { useAuth } from '../auth/session'
import { CompanyScreen } from '../screens/CompanyScreen'
import { CompanyPartnerProfileSection } from './CompanyPartnerProfileSection'

jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
const profilePath = '/api/v1/me/company/partner-profile'
const saved = { isSet: true, roles: ['LEAD'], interestAreas: ['기술'], introduction: '웹에서 저장한 소개', capabilities: ['AI'], updatedAt: '2026-10-11T12:00:00' }
const company = { businessNumber: '1234567890', companyName: '테스트 기업', businessStatus: '계속사업자', businessStatusCode: '01',
  region: '서울특별시', industry: '제조업', foundedYear: 2020, homepageUrl: null, businessVerifiedAt: '2026-10-11T12:00:00', updatedAt: '2026-10-11T12:00:00' }
const invalidateSession = jest.fn()
function auth(token = 'owner') {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: token }, invalidateSession, refreshSession: jest.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof useAuth>)
}
beforeEach(() => {
  invalidateSession.mockReset().mockResolvedValue(undefined)
  auth()
  jest.mocked(apiRequest).mockReset().mockImplementation(async (path, options) => {
    if (path === '/api/v1/me/company') return company
    return options?.method === 'PUT' ? { ...saved, ...(options.body as object) } : saved
  })
})
afterEach(() => jest.restoreAllMocks())
const puts = () => jest.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method === 'PUT')
async function open() {
  fireEvent.press(await screen.findByLabelText('협업·파트너 설정 수정'))
}
function save() { fireEvent.press(screen.getByLabelText('협업·파트너 설정 저장')) }
function requestClose() {
  const sheet = screen.UNSAFE_getAllByType(Modal).find(item => item.props.visible && item.props.transparent)
  act(() => sheet!.props.onRequestClose())
}

test('the saved web profile is shown read-only until explicitly edited', async () => {
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await screen.findByText(saved.introduction)
  expect(screen.getByText('주관기관')).toBeTruthy()
  expect(screen.getByText('기술')).toBeTruthy()
  expect(screen.getByText('AI')).toBeTruthy()
  expect(screen.getByText('저장됨')).toBeTruthy()
  expect(screen.queryByLabelText('한 줄 소개 (선택)')).toBeNull()
  expect(puts()).toHaveLength(0)
  await open()
  expect(screen.getByLabelText('참여 가능 역할 주관기관').props.accessibilityState.checked).toBe(true)
  expect(screen.getByLabelText('관심 분야 기술').props.accessibilityState.checked).toBe(true)
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.value).toBe(saved.introduction)
})

test('an unset profile has no default role and must pass the shared required-role validation', async () => {
  jest.mocked(apiRequest).mockResolvedValueOnce({ isSet: false, roles: [], interestAreas: [], introduction: '', capabilities: [], updatedAt: null })
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await screen.findByText('미설정')
  await open(); save()
  expect(screen.getByText('참여 가능 역할을 하나 이상 골라 주세요.')).toBeTruthy()
  expect(puts()).toHaveLength(0)
  fireEvent.press(screen.getByLabelText('참여 가능 역할 참여기관')); save()
  await screen.findByText('협업·파트너 설정을 저장했습니다.')
  expect(puts()[0][1]?.body).toEqual({ roles: ['PARTICIPANT'], interestAreas: [], introduction: '', capabilities: [] })
})

test('Cancel restores the saved values without writing or replacing the saved card', async () => {
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '저장하지 않은 소개')
  fireEvent.press(screen.getByLabelText('참여 가능 역할 참여기관'))
  fireEvent.press(screen.getByLabelText('관심 분야 금융'))
  fireEvent.press(screen.getByLabelText('AI 보유 역량 삭제'))
  fireEvent.changeText(screen.getByLabelText('보유 역량 입력'), '새 역량')
  fireEvent.press(screen.getByRole('button', { name: '취소' }))
  expect(puts()).toHaveLength(0)
  expect(screen.getByText(saved.introduction)).toBeTruthy()
  expect(screen.queryByText('저장하지 않은 소개')).toBeNull()
  await open()
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.value).toBe(saved.introduction)
  expect(screen.getByLabelText('관심 분야 금융').props.accessibilityState.checked).toBe(false)
  expect(screen.getByLabelText('참여 가능 역할 참여기관').props.accessibilityState.checked).toBe(false)
  expect(screen.getByLabelText('AI 보유 역량 삭제')).toBeTruthy()
  expect(screen.getByLabelText('보유 역량 입력').props.value).toBe('')
})

test.each(['header', 'backdrop', 'deviceBack'] as const)('%s close asks before discarding changed values', async close => {
  const alert = jest.spyOn(Alert, 'alert')
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '미저장 입력')
  if (close === 'header') fireEvent.press(screen.getByRole('button', { name: '닫기' }))
  else if (close === 'backdrop') fireEvent.press(screen.getByLabelText('시트 닫기', { includeHiddenElements: true }))
  else requestClose()
  expect(alert).toHaveBeenCalledWith('수정한 협업 설정을 취소할까요?', expect.any(String), expect.any(Array))
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.value).toBe('미저장 입력')
  const discard = alert.mock.calls[0][2]!.find(button => button.text === '변경 취소')!
  act(() => discard.onPress!())
  expect(screen.queryByLabelText('한 줄 소개 (선택)')).toBeNull()
  expect(puts()).toHaveLength(0)
  expect(screen.getByText(saved.introduction)).toBeTruthy()
})

test('Save includes the final capability draft and shows the validated returned profile', async () => {
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  fireEvent.press(screen.getByLabelText('참여 가능 역할 참여기관'))
  fireEvent.press(screen.getByLabelText('관심 분야 기술'))
  fireEvent.press(screen.getByLabelText('관심 분야 금융'))
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), ' 바꾼 소개 ')
  fireEvent.press(screen.getByLabelText('AI 보유 역량 삭제'))
  fireEvent.changeText(screen.getByLabelText('보유 역량 입력'), ' 데이터 분석 ')
  save()
  await screen.findByText('협업·파트너 설정을 저장했습니다.')
  expect(puts()).toHaveLength(1)
  expect(puts()[0]).toEqual([profilePath, expect.objectContaining({ accessToken: 'owner', body: {
    roles: ['LEAD', 'PARTICIPANT'], interestAreas: ['금융'], introduction: '바꾼 소개', capabilities: ['데이터 분석'],
  } })])
  expect(screen.getByText('바꾼 소개')).toBeTruthy()
  expect(screen.getByText('데이터 분석')).toBeTruthy()
  await open()
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.value).toBe('바꾼 소개')
})

test('interest-area and capability limits are enforced without discarding entered text', async () => {
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  fireEvent.press(screen.getByLabelText('관심 분야 금융'))
  fireEvent.press(screen.getByLabelText('관심 분야 경영'))
  fireEvent.press(screen.getByLabelText('관심 분야 수출'))
  expect(screen.getByText('관심 분야는 3개까지 고를 수 있습니다.')).toBeTruthy()
  expect(screen.getByLabelText('관심 분야 수출').props.accessibilityState.checked).toBe(false)
  fireEvent.changeText(screen.getByLabelText('보유 역량 입력'), ' AI ')
  fireEvent.press(screen.getByRole('button', { name: '역량 추가' }))
  expect(screen.getAllByLabelText('AI 보유 역량 삭제')).toHaveLength(1)
  for (const capability of ['설계', '제조', '분석', '마케팅']) {
    fireEvent.changeText(screen.getByLabelText('보유 역량 입력'), capability)
    fireEvent.press(screen.getByRole('button', { name: '역량 추가' }))
  }
  fireEvent.changeText(screen.getByLabelText('보유 역량 입력'), '추가 역량')
  fireEvent.press(screen.getByRole('button', { name: '역량 추가' })); save()
  expect(screen.getByText('보유 역량은 30자 이내로 5개까지 넣을 수 있습니다.')).toBeTruthy()
  expect(screen.getByLabelText('보유 역량 입력').props.value).toBe('추가 역량')
  expect(puts()).toHaveLength(0)
  fireEvent.press(screen.getByLabelText('AI 보유 역량 삭제')); save()
  await screen.findByText('협업·파트너 설정을 저장했습니다.')
  expect(puts()[0][1]?.body).toEqual(expect.objectContaining({ capabilities: ['설계', '제조', '분석', '마케팅', '추가 역량'] }))
})

test('oversized text cannot be submitted even if a synthetic input bypasses native maxLength', async () => {
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.maxLength).toBe(200)
  expect(screen.getByLabelText('보유 역량 입력').props.maxLength).toBe(30)
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '가'.repeat(201)); save()
  expect(screen.getByText('한 줄 소개는 200자 이하로 입력해 주세요.')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '가'.repeat(200))
  fireEvent.changeText(screen.getByLabelText('보유 역량 입력'), '나'.repeat(31)); save()
  expect(screen.getByText('보유 역량은 30자 이내로 5개까지 넣을 수 있습니다.')).toBeTruthy()
  expect(puts()).toHaveLength(0)
})

test('a failed load is explicit and retry does not present an empty profile as success', async () => {
  jest.mocked(apiRequest).mockRejectedValueOnce(new Error('network unavailable'))
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await screen.findByLabelText('협업·파트너 설정 다시 불러오기')
  expect(screen.queryByText('미설정')).toBeNull()
  expect(screen.queryByLabelText('협업·파트너 설정 수정')).toBeNull()
  fireEvent.press(screen.getByLabelText('협업·파트너 설정 다시 불러오기'))
  await screen.findByText(saved.introduction)
  expect(apiRequest).toHaveBeenCalledTimes(2)
})

test('a confirmed absent company offers company refresh and an expired session is invalidated', async () => {
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED'))
  const refresh = jest.fn()
  const view = render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={refresh} />)
  fireEvent.press(await screen.findByRole('button', { name: '기업 정보 다시 확인' }))
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText('협업·파트너 설정 수정')).toBeNull()
  view.unmount()
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(401, 'expired'))
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={refresh} />)
  await screen.findByLabelText('협업·파트너 설정 다시 불러오기')
  expect(invalidateSession).toHaveBeenCalledTimes(1)
})

test('a rejected save preserves its draft and retry sends the same normalized values', async () => {
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '저장할 소개')
  jest.mocked(apiRequest).mockRejectedValueOnce(new Error('failed save'))
  save()
  await screen.findByText('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.value).toBe('저장할 소개')
  expect(screen.queryByText('협업·파트너 설정을 저장했습니다.')).toBeNull()
  save()
  await screen.findByText('협업·파트너 설정을 저장했습니다.')
  expect(puts()).toHaveLength(2)
  expect(puts()[0][1]?.body).toEqual(puts()[1][1]?.body)
})

test('an in-flight save blocks double submission and accidental closure', async () => {
  let resolve!: (value: unknown) => void
  const alert = jest.spyOn(Alert, 'alert')
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '저장 중인 소개')
  jest.mocked(apiRequest).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  save(); save()
  expect(puts()).toHaveLength(1)
  expect(screen.getByLabelText('협업·파트너 설정 저장')).toBeDisabled()
  expect(screen.getByRole('button', { name: '취소' })).toBeDisabled()
  requestClose()
  expect(alert).not.toHaveBeenCalled()
  expect(screen.getByLabelText('한 줄 소개 (선택)')).toBeTruthy()
  await act(async () => resolve({ ...saved, introduction: '저장 중인 소개' }))
  await screen.findByText('협업·파트너 설정을 저장했습니다.')
})

test('switching accounts aborts an old save and cannot invalidate or overwrite the new owner', async () => {
  let rejectOld!: (cause: unknown) => void
  jest.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path === '/api/v1/me/company') return company
    if (options?.method === 'PUT') return new Promise((_, reject) => { rejectOld = reject })
    return options?.accessToken === 'new-owner' ? { ...saved, introduction: '새 계정 소개' } : saved
  })
  const view = render(<CompanyScreen />)
  await open()
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '이전 계정 미저장 소개')
  save()
  const oldSignal = puts()[0][1]!.signal!
  auth('new-owner'); view.rerender(<CompanyScreen />)
  await screen.findByText('새 계정 소개')
  expect(oldSignal.aborted).toBe(true)
  await act(async () => rejectOld(new ApiError(401, 'old expired')))
  expect(invalidateSession).not.toHaveBeenCalled()
  expect(screen.queryByText(saved.introduction)).toBeNull()
  expect(screen.queryByText('협업·파트너 설정을 저장했습니다.')).toBeNull()
})

test('basic company mutation disables opening partner editing without hiding the saved profile', async () => {
  const view = render(<CompanyPartnerProfileSection token="owner" disabled onRefreshCompany={jest.fn()} />)
  await screen.findByText(saved.introduction)
  expect(screen.getByLabelText('협업·파트너 설정 수정')).toBeDisabled()
  fireEvent.press(screen.getByLabelText('협업·파트너 설정 수정'))
  expect(screen.queryByLabelText('한 줄 소개 (선택)')).toBeNull()
  view.rerender(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.value).toBe(saved.introduction)
  expect(apiRequest).toHaveBeenCalledTimes(1)
})

test('an expired current-owner save invalidates the session and keeps the failed draft', async () => {
  render(<CompanyPartnerProfileSection token="owner" onRefreshCompany={jest.fn()} />)
  await open()
  fireEvent.changeText(screen.getByLabelText('한 줄 소개 (선택)'), '저장할 소개')
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(401, 'expired'))
  save()
  await screen.findByText('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  expect(invalidateSession).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('한 줄 소개 (선택)').props.value).toBe('저장할 소개')
  expect(screen.queryByText('협업·파트너 설정을 저장했습니다.')).toBeNull()
})

test('switching accounts cancels an old load and never exposes its late profile', async () => {
  let resolveOld!: (value: unknown) => void
  jest.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path === '/api/v1/me/company') return company
    if (options?.accessToken === 'new-owner') return { ...saved, introduction: '새 계정 소개' }
    return new Promise(resolve => { resolveOld = resolve })
  })
  const view = render(<CompanyScreen />)
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(profilePath, expect.anything()))
  const oldSignal = jest.mocked(apiRequest).mock.calls.find(([path]) => path === profilePath)![1]!.signal!
  auth('new-owner'); view.rerender(<CompanyScreen />)
  await screen.findByText('새 계정 소개')
  expect(oldSignal.aborted).toBe(true)
  await act(async () => resolveOld(saved))
  expect(screen.queryByText(saved.introduction)).toBeNull()
  expect(screen.getByText('새 계정 소개')).toBeTruthy()
})
