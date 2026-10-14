import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native'
import { Modal } from 'react-native'
import { companyIndustries, companyRegions } from '@govbiz/shared/domain/entities/Company'
import { apiRequest, ApiError } from '../api/client'
import { useAuth } from '../auth/session'
import { CompanyScreen } from './CompanyScreen'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ apiRequest: jest.fn(), ApiError: class extends Error {
  status: number; code: string | null
  constructor(status: number, message: string, code: string | null = null) { super(message); this.status = status; this.code = code }
}, errorMessage: () => '기업 정보를 불러오지 못했습니다.' }))

beforeEach(() => {
  jest.mocked(apiRequest).mockReset()
  jest.mocked(useAuth).mockReturnValue({ session: { accessToken: 'test-token' }, status: 'signedIn', invalidateSession: jest.fn(), refreshSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
})

test('a confirmed absent company opens registration', async () => {
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED'))
  const view = render(<CompanyScreen />)
  await waitFor(() => expect(view.getByLabelText('사업자등록번호')).toBeTruthy())
})

const business = (businessStatus: string, businessStatusCode: '01' | '02' | '03', canRegister: boolean) => ({
  businessNumber: '1234567890', companyName: '한빛정밀', businessStatus, businessStatusCode, isActive: businessStatusCode === '01', canRegister,
})

async function lookUp(lookup: ReturnType<typeof business>) {
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (path === '/api/v1/me/company/partner-profile') return Promise.resolve({ isSet: false, roles: [], interestAreas: [], introduction: '', capabilities: [], updatedAt: null })
    if (path.startsWith('/api/v1/me/company/lookup?')) return Promise.resolve(lookup)
    if (options?.method === 'POST') return Promise.resolve({ ...(options.body as object), companyName: lookup.companyName,
      businessStatus: lookup.businessStatus, businessStatusCode: lookup.businessStatusCode,
      businessVerifiedAt: '2026-10-04T10:00:00+09:00', updatedAt: '2026-10-04T10:00:00+09:00' })
    return Promise.reject(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED'))
  })
  const view = render(<CompanyScreen />)
  fireEvent.changeText(await view.findByLabelText('사업자등록번호'), '1234567890')
  fireEvent.press(view.getByText('사업자 정보 조회'))
  await view.findByText(lookup.businessStatus)
  return view
}

function submitProfile(view: ReturnType<typeof render>) {
  fireEvent.press(view.getByLabelText('소재지: 소재지를 선택해 주세요')); fireEvent.press(view.getByRole('radio', { name: '서울특별시' }))
  fireEvent.press(view.getByLabelText('업종: 업종을 선택해 주세요')); fireEvent.press(view.getByRole('radio', { name: '제조업' }))
  fireEvent.changeText(view.getByLabelText('설립연도'), '2020')
  fireEvent.press(view.getByRole('button', { name: '기업 등록' }))
}

test('a suspended business can register as on the web and learns that partner features stay locked', async () => {
  const view = await lookUp(business('휴업자', '02', true))
  expect(view.getByText('등록은 할 수 있어요. 파트너 모집글과 제안은 사업을 다시 시작한 뒤 쓸 수 있어요.')).toBeTruthy()
  expect(view.queryByText(/등록할 수 없어요/)).toBeNull()
  submitProfile(view)
  await view.findByText('기업 프로필을 저장했습니다.')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/company', expect.objectContaining({ method: 'POST',
    body: { businessNumber: '1234567890', region: '서울특별시', industry: '제조업', foundedYear: 2020, homepageUrl: null } }))
})

test('a closed business is told why it cannot register and the registration action stays disabled', async () => {
  const view = await lookUp(business('폐업자', '03', false))
  expect(view.getByText('폐업자 상태의 사업자는 등록할 수 없어요.')).toBeTruthy()
  expect(view.getByRole('button', { name: '기업 등록' })).toBeDisabled()
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

test('a registration failure is explained with the shared business registration message', async () => {
  const view = await lookUp(business('계속사업자', '01', true))
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(409, 'taken', 'BUSINESS_NUMBER_ALREADY_REGISTERED'))
  submitProfile(view)
  await view.findByText('이 사업자는 다른 계정에 등록돼 있어요. 담당자가 바뀌었다면 알려 주세요.')
})

test('a network failure or unknown endpoint cannot be misrepresented as an absent company', async () => {
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(404, 'missing route'))
  const view = render(<CompanyScreen />)
  await waitFor(() => expect(view.getByText('기업 정보를 불러오지 못했습니다.')).toBeTruthy())
  expect(view.queryByLabelText('사업자등록번호')).toBeNull()
  expect(view.getByText('다시 불러오기')).toBeTruthy()
})

test.each([
  ['BIZNO_NOT_CONFIGURED', '사업자 정보 조회 서비스 설정이 준비되지 않았습니다. 관리자에게 문의해 주세요.'],
  ['BIZNO_UNAVAILABLE', '사업자 정보 조회 서비스를 이용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.'],
])('explains lookup failure %s without accepting an unverified company', async (code, message) => {
  jest.mocked(apiRequest).mockImplementation(path => path.startsWith('/api/v1/me/company/lookup?')
    ? Promise.reject(new ApiError(503, 'lookup unavailable', code))
    : Promise.reject(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED')))
  const view = render(<CompanyScreen />)
  fireEvent.changeText(await view.findByLabelText('사업자등록번호'), '1234567890')
  fireEvent.press(view.getByText('사업자 정보 조회'))
  await view.findByText(message)
  expect(view.getByRole('button', { name: '기업 등록' })).toBeDisabled()
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

test('partner settings load after company registration and are absent from the registration form', async () => {
  const view = await lookUp(business('계속사업자', '01', true))
  expect(view.queryByText('협업·파트너 설정')).toBeNull()
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith('/partner-profile'))).toBe(false)
  submitProfile(view)
  await view.findByLabelText('협업·파트너 설정 수정')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/company/partner-profile', expect.objectContaining({ accessToken: 'test-token' }))
})

test('the signed-out company guide points to the current Menu and My Profile entry', () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as unknown as ReturnType<typeof useAuth>)
  const login = jest.fn()
  const view = render(<CompanyScreen onLogin={login} />)
  expect(view.getByText('메뉴 → 내 프로필에서 로그인한 뒤 기업 정보를 등록해 주세요.')).toBeTruthy()
  expect(view.queryByText(/전체 →/)).toBeNull()
  fireEvent.press(view.getByRole('button', { name: '로그인하기' }))
  expect(login).toHaveBeenCalledTimes(1)
  expect(apiRequest).not.toHaveBeenCalled()
})

const registeredCompany = { businessNumber: '1234567890', companyName: '한빛정밀', businessStatus: '계속사업자', businessStatusCode: '01',
  region: '서울특별시', industry: '제조업', foundedYear: 2020, homepageUrl: null,
  businessVerifiedAt: '2026-10-04T10:00:00+09:00', updatedAt: '2026-10-04T10:00:00+09:00' }
const emptyPartnerProfile = { isSet: false, roles: [], interestAreas: [], introduction: '', capabilities: [], updatedAt: null }

async function editProfile() {
  jest.mocked(apiRequest).mockImplementation(async (path, options) => path.endsWith('/partner-profile') ? emptyPartnerProfile
    : options?.method === 'PUT' ? { ...registeredCompany, ...(options.body as object) } : registeredCompany)
  const view = render(<CompanyScreen />)
  await view.findByText('미설정')
  return view
}

function visibleSheet(view: ReturnType<typeof render>) {
  const sheet = view.UNSAFE_getAllByType(Modal).find(item => item.props.visible && item.props.transparent)
  if (!sheet) throw new Error('No open selection sheet')
  return sheet
}

test.each([
  ['소재지', '소재지를 선택해 주세요', companyRegions, '부산광역시'],
  ['업종', '업종을 선택해 주세요', companyIndustries, '정보통신업'],
] as const)('registration selects %s in a native sheet without inserting choices in the form', async (label, placeholder, options, selected) => {
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED'))
  const view = render(<CompanyScreen />)
  await view.findByLabelText('사업자등록번호')
  expect(view.queryAllByRole('radio')).toHaveLength(0)
  const foundedYear = view.getByLabelText('설립연도')
  fireEvent.press(view.getByLabelText(`${label}: ${placeholder}`))
  const sheet = visibleSheet(view)
  expect(within(sheet).getAllByRole('radio')).toHaveLength(options.length)
  expect(within(sheet).getAllByRole('radio').every(option => option.props.accessibilityState.checked === false)).toBe(true)
  expect(view.getByLabelText('설립연도')).toBe(foundedYear)
  fireEvent.press(within(sheet).getByRole('radio', { name: selected }))
  expect(view.queryAllByRole('radio')).toHaveLength(0)
  fireEvent.press(view.getByLabelText(`${label}: ${selected}`))
  expect(within(visibleSheet(view)).getByRole('radio', { name: selected, checked: true })).toBeTruthy()
  expect(jest.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method)).toHaveLength(0)
})

test.each(['header', 'backdrop', 'deviceBack'] as const)('%s closes the company selection sheet while preserving the current value', async close => {
  const view = await editProfile()
  fireEvent.press(view.getByLabelText('소재지: 서울특별시'))
  const sheet = visibleSheet(view)
  expect(within(sheet).getByRole('radio', { name: '서울특별시', checked: true })).toBeTruthy()
  if (close === 'header') fireEvent.press(within(sheet).getByRole('button', { name: '닫기' }))
  else if (close === 'backdrop') fireEvent.press(within(sheet).getByLabelText('시트 닫기', { includeHiddenElements: true }))
  else act(() => sheet.props.onRequestClose())
  expect(view.queryAllByRole('radio')).toHaveLength(0)
  expect(view.getByLabelText('소재지: 서울특별시')).toBeTruthy()
  expect(jest.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method)).toHaveLength(0)
  fireEvent.press(view.getByLabelText('소재지: 서울특별시'))
  expect(within(visibleSheet(view)).getByRole('radio', { name: '서울특별시', checked: true })).toBeTruthy()
})

test('editing selects both company fields and preserves the existing PUT contract', async () => {
  const view = await editProfile()
  fireEvent.press(view.getByLabelText('소재지: 서울특별시'))
  fireEvent.press(view.getByRole('radio', { name: '부산광역시' }))
  fireEvent.press(view.getByLabelText('업종: 제조업'))
  expect(view.getByRole('radio', { name: '제조업', checked: true })).toBeTruthy()
  fireEvent.press(view.getByRole('radio', { name: '정보통신업' }))
  fireEvent.press(view.getByRole('button', { name: '기업 정보 저장' }))
  await view.findByText('기업 프로필을 저장했습니다.')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/company', expect.objectContaining({ method: 'PUT', accessToken: 'test-token',
    body: { region: '부산광역시', industry: '정보통신업', foundedYear: 2020, homepageUrl: null } }))
  expect(jest.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
})

test('the company pickers cannot open during a business lookup', async () => {
  let completeLookup!: (value: ReturnType<typeof business>) => void
  jest.mocked(apiRequest).mockImplementation(path => path.startsWith('/api/v1/me/company/lookup?')
    ? new Promise(resolve => { completeLookup = resolve }) : Promise.reject(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED')))
  const view = render(<CompanyScreen />)
  fireEvent.changeText(await view.findByLabelText('사업자등록번호'), '1234567890')
  fireEvent.press(view.getByRole('button', { name: '사업자 정보 조회' }))
  expect(view.getByLabelText('소재지: 소재지를 선택해 주세요')).toBeDisabled()
  expect(view.getByLabelText('업종: 업종을 선택해 주세요')).toBeDisabled()
  fireEvent.press(view.getByLabelText('소재지: 소재지를 선택해 주세요'))
  expect(view.queryAllByRole('radio')).toHaveLength(0)
  await act(async () => completeLookup(business('계속사업자', '01', true)))
  expect(view.getByLabelText('소재지: 소재지를 선택해 주세요')).not.toBeDisabled()
})

test('changing the account closes the sheet and clears the former company selections', async () => {
  const view = await editProfile()
  fireEvent.press(view.getByLabelText('소재지: 서울특별시'))
  jest.mocked(useAuth).mockReturnValue({ session: { accessToken: 'other-token' }, status: 'signedIn',
    invalidateSession: jest.fn(), refreshSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(apiRequest).mockRejectedValue(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED'))
  view.rerender(<CompanyScreen />)
  await view.findByLabelText('사업자등록번호')
  expect(view.queryAllByRole('radio')).toHaveLength(0)
  expect(view.getByLabelText('소재지: 소재지를 선택해 주세요')).toBeTruthy()
  expect(view.getByLabelText('업종: 업종을 선택해 주세요')).toBeTruthy()
  fireEvent.press(view.getByLabelText('소재지: 소재지를 선택해 주세요'))
  expect(view.getAllByRole('radio').every(option => option.props.accessibilityState.checked === false)).toBe(true)
})
