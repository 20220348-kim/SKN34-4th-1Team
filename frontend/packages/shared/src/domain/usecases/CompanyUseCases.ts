import {
  type CompanyProfileInput,
  isValidBusinessNumber,
  normalizeBusinessNumber,
} from '../entities/Company'
import type { CompanyRepository } from '../repositories/CompanyRepository'

/** 사업자등록번호를 숫자 10자리로 정규화한 뒤 등록 여부와 상호를 조회합니다. */
export class LookupBusinessUseCase {
  private readonly repository: Pick<CompanyRepository, 'lookupBusiness'>

  constructor(repository: Pick<CompanyRepository, 'lookupBusiness'>) {
    this.repository = repository
  }

  execute(businessNumber: string, signal?: AbortSignal) {
    if (!isValidBusinessNumber(businessNumber)) throw new RangeError('businessNumber must be 10 digits')
    return this.repository.lookupBusiness(normalizeBusinessNumber(businessNumber), signal)
  }
}

export class GetMyCompanyUseCase {
  private readonly repository: Pick<CompanyRepository, 'getMyCompany'>

  constructor(repository: Pick<CompanyRepository, 'getMyCompany'>) {
    this.repository = repository
  }

  execute(signal?: AbortSignal) {
    return this.repository.getMyCompany(signal)
  }
}

/** 서버가 등록 시점에 다시 조회하므로 상호는 보내지 않고 번호와 담당자 입력만 보냅니다. */
export class RegisterCompanyUseCase {
  private readonly repository: Pick<CompanyRepository, 'registerCompany'>

  constructor(repository: Pick<CompanyRepository, 'registerCompany'>) {
    this.repository = repository
  }

  execute(businessNumber: string, profile: CompanyProfileInput, signal?: AbortSignal) {
    if (!isValidBusinessNumber(businessNumber)) throw new RangeError('businessNumber must be 10 digits')
    return this.repository.registerCompany(normalizeBusinessNumber(businessNumber), profile, signal)
  }
}

export class UpdateCompanyUseCase {
  private readonly repository: Pick<CompanyRepository, 'updateCompany'>

  constructor(repository: Pick<CompanyRepository, 'updateCompany'>) {
    this.repository = repository
  }

  execute(profile: CompanyProfileInput, signal?: AbortSignal) {
    return this.repository.updateCompany(profile, signal)
  }
}
