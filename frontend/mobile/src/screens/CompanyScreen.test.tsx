import { fireEvent, render, waitFor } from '@testing-library/react-native'
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
  fireEvent.press(view.getByText('소재지를 선택해 주세요')); fireEvent.press(view.getByText('서울특별시'))
  fireEvent.press(view.getByText('업종을 선택해 주세요')); fireEvent.press(view.getByText('제조업'))
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
