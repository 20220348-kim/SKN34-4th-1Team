import { apiRequest, ApiError } from './client'
import { getCompany, lookupCompanyBusiness, saveCompanyProfile, getCompanyPartnerProfile, saveCompanyPartnerProfile } from './company'

jest.mock('./client', () => ({ apiRequest: jest.fn(), ApiError: jest.requireActual('./client').ApiError }))
const profile = { region: '서울', industry: '제조업', foundedYear: 2020, homepageUrl: null }
const company = { businessNumber: '1234567890', companyName: '테스트 기업', businessStatus: '계속사업자', ...profile,
  businessVerifiedAt: '2026-10-04T10:00:00+09:00', updatedAt: '2026-10-04T10:00:00+09:00' }
beforeEach(() => jest.mocked(apiRequest).mockReset())

test('company response validation and model conversion stay inside the authenticated API boundary', async () => {
  jest.mocked(apiRequest).mockResolvedValue(company)
  const signal = new AbortController().signal
  await expect(getCompany('owner', signal)).resolves.toMatchObject({ ...company, businessStatusCode: '01' })
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/company', { accessToken: 'owner', signal })
  jest.mocked(apiRequest).mockResolvedValue({ ...company, foundedYear: '2020' })
  await expect(getCompany('owner')).rejects.toThrow()
})

test('business lookup converts legacy business status and preserves failures', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ businessNumber: company.businessNumber, companyName: company.companyName, businessStatus: company.businessStatus, isActive: true })
  await expect(lookupCompanyBusiness('owner', company.businessNumber)).resolves.toMatchObject({ businessStatusCode: '01', canRegister: true })
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/company/lookup?businessNumber=1234567890', expect.objectContaining({ accessToken: 'owner' }))
  const failure = new Error('lookup unavailable')
  jest.mocked(apiRequest).mockRejectedValue(failure)
  await expect(lookupCompanyBusiness('owner', company.businessNumber)).rejects.toBe(failure)
})

test('registration and profile update retain their distinct HTTP inputs', async () => {
  jest.mocked(apiRequest).mockResolvedValue(company)
  await saveCompanyProfile('owner', profile, company.businessNumber)
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/me/company', expect.objectContaining({ method: 'POST', body: { ...profile, businessNumber: company.businessNumber } }))
  await saveCompanyProfile('owner', profile)
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/me/company', expect.objectContaining({ method: 'PUT', body: profile }))
})

const partnerProfile = { isSet: true, roles: ['LEAD'], interestAreas: ['기술'], introduction: '기업 소개', capabilities: ['AI'], updatedAt: null }

test('partner profile GET validates the shared DTO and copies its arrays at the Bearer boundary', async () => {
  jest.mocked(apiRequest).mockResolvedValue(partnerProfile)
  const signal = new AbortController().signal
  const result = await getCompanyPartnerProfile('owner', signal)
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/company/partner-profile', { accessToken: 'owner', signal })
  expect(result).toEqual(partnerProfile)
  expect(result!.roles).not.toBe(partnerProfile.roles)
  expect(result!.capabilities).not.toBe(partnerProfile.capabilities)
  jest.mocked(apiRequest).mockResolvedValue({ ...partnerProfile, roles: ['UNKNOWN'] })
  await expect(getCompanyPartnerProfile('owner')).rejects.toThrow()
})

test('an unset profile is returned as such and only a confirmed absent company is null', async () => {
  const unset = { isSet: false, roles: [], interestAreas: [], introduction: '', capabilities: [], updatedAt: null }
  jest.mocked(apiRequest).mockResolvedValueOnce(unset)
  await expect(getCompanyPartnerProfile('owner')).resolves.toEqual(unset)
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(404, 'missing', 'COMPANY_NOT_REGISTERED'))
  await expect(getCompanyPartnerProfile('owner')).resolves.toBeNull()
  const unknownRoute = new ApiError(404, 'unknown route')
  jest.mocked(apiRequest).mockRejectedValueOnce(unknownRoute)
  await expect(getCompanyPartnerProfile('owner')).rejects.toBe(unknownRoute)
  const unavailable = new Error('offline')
  jest.mocked(apiRequest).mockRejectedValueOnce(unavailable)
  await expect(getCompanyPartnerProfile('owner')).rejects.toBe(unavailable)
})

test('partner profile PUT reuses shared normalization and never sends an invalid input', async () => {
  jest.mocked(apiRequest).mockResolvedValue(partnerProfile)
  const signal = new AbortController().signal
  await saveCompanyPartnerProfile('owner', { roles: ['LEAD', 'LEAD'], interestAreas: [' 기술 ', ''], introduction: ' 기업 소개 ', capabilities: [' AI '] }, signal)
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/company/partner-profile', { method: 'PUT', accessToken: 'owner', signal,
    body: { roles: ['LEAD'], interestAreas: ['기술'], introduction: '기업 소개', capabilities: ['AI'] } })
  jest.mocked(apiRequest).mockClear()
  expect(() => saveCompanyPartnerProfile('owner', { roles: [], interestAreas: [], introduction: '', capabilities: [] })).toThrow(RangeError)
  expect(() => saveCompanyPartnerProfile('owner', { roles: ['LEAD'], interestAreas: [], introduction: '', capabilities: ['AI', 'AI'] })).toThrow(RangeError)
  expect(apiRequest).not.toHaveBeenCalled()
})

test('partner profile PUT preserves failures and rejects malformed success responses', async () => {
  const input = { roles: ['LEAD'] as const, interestAreas: [], introduction: '', capabilities: [] }
  const failure = new ApiError(401, 'expired')
  jest.mocked(apiRequest).mockRejectedValueOnce(failure)
  await expect(saveCompanyPartnerProfile('owner', { ...input, roles: [...input.roles] })).rejects.toBe(failure)
  jest.mocked(apiRequest).mockResolvedValueOnce({ ...partnerProfile, capabilities: 'AI' })
  await expect(saveCompanyPartnerProfile('owner', { ...input, roles: [...input.roles] })).rejects.toThrow()
})
