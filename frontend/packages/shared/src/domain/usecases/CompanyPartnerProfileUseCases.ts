import {
  type CompanyPartnerProfile,
  type CompanyPartnerProfileInput,
  findCompanyPartnerProfileProblem,
} from '../entities/CompanyPartnerProfile'
import type { CompanyRepository } from '../repositories/CompanyRepository'

/** 협업·파트너 설정을 읽습니다. 기업이 없으면 null입니다. */
export class GetCompanyPartnerProfileUseCase {
  private readonly repository: Pick<CompanyRepository, 'getPartnerProfile'>

  constructor(repository: Pick<CompanyRepository, 'getPartnerProfile'>) {
    this.repository = repository
  }

  execute(signal?: AbortSignal): Promise<CompanyPartnerProfile | null> {
    return this.repository.getPartnerProfile(signal)
  }
}

/** 화면 검증을 통과한 설정만 서버로 보냅니다. 서버가 같은 규칙으로 한 번 더 검사합니다. */
export class UpdateCompanyPartnerProfileUseCase {
  private readonly repository: Pick<CompanyRepository, 'updatePartnerProfile'>

  constructor(repository: Pick<CompanyRepository, 'updatePartnerProfile'>) {
    this.repository = repository
  }

  execute(input: CompanyPartnerProfileInput, signal?: AbortSignal): Promise<CompanyPartnerProfile> {
    const problem = findCompanyPartnerProfileProblem(input)
    if (problem !== null) throw new RangeError(`partner profile field ${problem} is invalid`)
    return this.repository.updatePartnerProfile(
      {
        roles: [...new Set(input.roles)],
        interestAreas: input.interestAreas.map((area) => area.trim()).filter((area) => area !== ''),
        introduction: input.introduction.trim(),
        capabilities: input.capabilities.map((item) => item.trim()),
      },
      signal,
    )
  }
}
