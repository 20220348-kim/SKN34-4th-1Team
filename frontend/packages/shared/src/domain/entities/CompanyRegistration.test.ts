import { describe, expect, it } from 'vitest'

import type { BusinessLookup } from './Company'
import { businessStatusNotes, canRegisterBusiness, companyRegistrationMessages } from './CompanyRegistration'

const business = (overrides: Pick<BusinessLookup, 'businessStatus' | 'businessStatusCode' | 'isActive' | 'canRegister'>): BusinessLookup =>
  ({ businessNumber: '1248100998', companyName: '테스트 기업', ...overrides })

describe('canRegisterBusiness', () => {
  it('계속·휴업 사업자는 등록할 수 있고 폐업 사업자는 등록할 수 없다', () => {
    expect(canRegisterBusiness(business({ businessStatus: '계속사업자', businessStatusCode: '01', isActive: true, canRegister: true }))).toBe(true)
    expect(canRegisterBusiness(business({ businessStatus: '휴업자', businessStatusCode: '02', isActive: false, canRegister: true }))).toBe(true)
    expect(canRegisterBusiness(business({ businessStatus: '폐업자', businessStatusCode: '03', isActive: false, canRegister: false }))).toBe(false)
  })
})

describe('기업 등록 안내 문구', () => {
  it('등록할 수 없는 사업자는 조회한 상태를 넣어 알리고, 상태를 모르면 폐업으로 알린다', () => {
    expect(companyRegistrationMessages.businessClosed('폐업자')).toBe('폐업자 상태의 사업자는 등록할 수 없어요.')
    expect(companyRegistrationMessages.businessClosed(null)).toBe('폐업한 사업자는 등록할 수 없어요.')
  })

  it('휴업 안내는 등록은 되지만 파트너 기능이 잠긴다고 말한다', () => {
    expect(businessStatusNotes['02']).toMatch(/^등록은 할 수 있어요\./)
    expect(businessStatusNotes['02']).toContain('파트너 모집글과 제안')
    expect(businessStatusNotes['03']).toMatch(/등록할 수 없어요/)
  })
})
