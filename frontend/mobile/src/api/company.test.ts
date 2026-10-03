import { apiRequest } from './client'
import { getCompany, lookupCompanyBusiness, saveCompanyProfile } from './company'

jest.mock('./client', () => ({ apiRequest: jest.fn() }))
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
