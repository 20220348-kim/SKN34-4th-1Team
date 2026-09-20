import type { Company, CompanyProfileInput } from '../../domain/entities/Company'
import type { CompanyPartnerProfile, CompanyPartnerProfileInput } from '../../domain/entities/CompanyPartnerProfile'
import type {
  BusinessLookupResult,
  CompanyRepository,
  RegisterCompanyResult,
} from '../../domain/repositories/CompanyRepository'
import { AccountApiError } from '../api/accountApi'
import {
  CompanyApiError,
  getMyCompanyApi,
  getPartnerProfileApi,
  lookupBusinessApi,
  registerCompanyApi,
  updateCompanyApi,
  updatePartnerProfileApi,
} from '../api/companyApi'
import { toBusinessLookup, toCompany, toCompanyPartnerProfile } from '../models/CompanyDto'

/** Core API 기업 DTO를 Domain 값으로 바꾸고, 화면이 구분해 안내할 실패는 결과로 돌려주는 adapter입니다. */
export class CompanyRepositoryImpl implements CompanyRepository {
  async lookupBusiness(businessNumber: string, signal?: AbortSignal): Promise<BusinessLookupResult> {
    try {
      return { outcome: 'found', business: toBusinessLookup(await lookupBusinessApi(businessNumber, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.status === 404 && error.code === 'BUSINESS_NOT_FOUND') return { outcome: 'not-found' }
        if (isLookupUnavailable(error)) return { outcome: 'lookup-unavailable' }
      }
      throw error
    }
  }

  /** 아직 등록하지 않은 회원(404)은 null입니다. */
  async getMyCompany(signal?: AbortSignal): Promise<Company | null> {
    try {
      return toCompany(await getMyCompanyApi(signal))
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404 && error.code === 'COMPANY_NOT_REGISTERED') return null
      throw error
    }
  }

  async registerCompany(
    businessNumber: string,
    profile: CompanyProfileInput,
    signal?: AbortSignal,
  ): Promise<RegisterCompanyResult> {
    try {
      return { outcome: 'registered', company: toCompany(await registerCompanyApi(businessNumber, profile, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.code === 'BUSINESS_NOT_FOUND') return { outcome: 'business-not-found' }
        if (error.code === 'BUSINESS_NOT_ACTIVE') {
          return { outcome: 'business-not-active', businessStatus: error instanceof CompanyApiError ? error.businessStatus : null }
        }
        if (error.code === 'BUSINESS_NUMBER_ALREADY_REGISTERED') return { outcome: 'business-number-taken' }
        if (error.code === 'COMPANY_ALREADY_REGISTERED') return { outcome: 'already-registered' }
        if (isLookupUnavailable(error)) return { outcome: 'lookup-unavailable' }
      }
      throw error
    }
  }

  async updateCompany(profile: CompanyProfileInput, signal?: AbortSignal): Promise<Company> {
    return toCompany(await updateCompanyApi(profile, signal))
  }

  /** 기업이 없어 404 `COMPANY_NOT_REGISTERED`면 null입니다. */
  async getPartnerProfile(signal?: AbortSignal): Promise<CompanyPartnerProfile | null> {
    try {
      return toCompanyPartnerProfile(await getPartnerProfileApi(signal))
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404 && error.code === 'COMPANY_NOT_REGISTERED') return null
      throw error
    }
  }

  async updatePartnerProfile(input: CompanyPartnerProfileInput, signal?: AbortSignal): Promise<CompanyPartnerProfile> {
    return toCompanyPartnerProfile(await updatePartnerProfileApi(input, signal))
  }
}

/** 사업자등록번호 조회 자체가 안 되는 경우입니다. 키 미설정·연결 실패·시간 초과·응답 오류를 한 안내로 묶습니다. */
function isLookupUnavailable(error: AccountApiError): boolean {
  return error.code !== null && error.code.startsWith('BIZNO_')
}
