import { render, waitFor } from '@testing-library/react-native'
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

test('a network failure or unknown endpoint cannot be misrepresented as an absent company', async () => {
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(404, 'missing route'))
  const view = render(<CompanyScreen />)
  await waitFor(() => expect(view.getByText('기업 정보를 불러오지 못했습니다.')).toBeTruthy())
  expect(view.queryByLabelText('사업자등록번호')).toBeNull()
  expect(view.getByText('다시 불러오기')).toBeTruthy()
})
