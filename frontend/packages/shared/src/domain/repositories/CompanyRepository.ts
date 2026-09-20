import type { BusinessLookup, Company, CompanyProfileInput } from '../entities/Company'
import type { CompanyPartnerProfile, CompanyPartnerProfileInput } from '../entities/CompanyPartnerProfile'

/** 조회·등록 실패 사유는 화면이 다르게 안내해야 하므로 예외가 아닌 결과로 구분합니다. */
export type BusinessLookupResult =
  | { outcome: 'found'; business: BusinessLookup }
  | { outcome: 'not-found' }
  | { outcome: 'lookup-unavailable' }

export type RegisterCompanyResult =
  | { outcome: 'registered'; company: Company }
  | { outcome: 'business-not-found' }
  | { outcome: 'business-not-active'; businessStatus: string | null }
  | { outcome: 'business-number-taken' }
  | { outcome: 'already-registered' }
  | { outcome: 'lookup-unavailable' }

/** 기업 기능이 Data Layer의 HTTP 세부사항과 분리되도록 하는 Domain 포트입니다. */
export interface CompanyRepository {
  lookupBusiness(businessNumber: string, signal?: AbortSignal): Promise<BusinessLookupResult>
  /** 아직 등록하지 않았으면 null입니다. */
  getMyCompany(signal?: AbortSignal): Promise<Company | null>
  registerCompany(businessNumber: string, profile: CompanyProfileInput, signal?: AbortSignal): Promise<RegisterCompanyResult>
  updateCompany(profile: CompanyProfileInput, signal?: AbortSignal): Promise<Company>
  /** 협업·파트너 설정입니다. 기업이 없으면 null, 저장한 적이 없으면 `isSet=false`와 기본값입니다. */
  getPartnerProfile(signal?: AbortSignal): Promise<CompanyPartnerProfile | null>
  updatePartnerProfile(input: CompanyPartnerProfileInput, signal?: AbortSignal): Promise<CompanyPartnerProfile>
}
