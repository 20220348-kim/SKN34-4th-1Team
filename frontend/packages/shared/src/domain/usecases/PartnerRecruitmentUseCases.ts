import {
  companyAgeYearsRange,
  ownPartnerRoles,
  recruitmentBodyMaxLength,
  recruitmentCapabilityMaxCount,
  recruitmentCapabilityMaxLength,
  recruitmentTitleMaxLength,
  seekingCountRange,
  type PartnerRecruitmentContentInput,
  type PartnerRecruitmentInput,
} from '../entities/PartnerRecruitment'
import type { PartnerRecruitmentQuery } from '../entities/PartnerRecruitmentQuery'
import type { PartnerRecruitmentRepository } from '../repositories/PartnerRecruitmentRepository'

/** 검색어·지역은 앞뒤 공백을 지우고 보냅니다. 페이지가 잘못되면 첫 페이지로 봅니다. */
export class BrowsePartnerRecruitmentsUseCase {
  private readonly repository: Pick<PartnerRecruitmentRepository, 'browse'>

  constructor(repository: Pick<PartnerRecruitmentRepository, 'browse'>) {
    this.repository = repository
  }

  execute(query: PartnerRecruitmentQuery, signal?: AbortSignal) {
    const page = Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
    const regions = query.regions.map((region) => region.trim()).filter((region) => region !== '')
    return this.repository.browse({ ...query, keyword: query.keyword.trim(), regions, page }, signal)
  }
}

export class GetPartnerRecruitmentDetailUseCase {
  private readonly repository: Pick<PartnerRecruitmentRepository, 'getDetail'>

  constructor(repository: Pick<PartnerRecruitmentRepository, 'getDetail'>) {
    this.repository = repository
  }

  execute(id: number, signal?: AbortSignal) {
    if (!Number.isInteger(id) || id < 1) throw new RangeError('recruitment id must be a positive integer')
    return this.repository.getDetail(id, signal)
  }
}

/** 화면 검증을 통과한 입력만 보냅니다. 서버가 공고·마감일·중복을 다시 확인합니다. */
export class CreatePartnerRecruitmentUseCase {
  private readonly repository: Pick<PartnerRecruitmentRepository, 'create'>

  constructor(repository: Pick<PartnerRecruitmentRepository, 'create'>) {
    this.repository = repository
  }

  execute(input: PartnerRecruitmentInput, signal?: AbortSignal) {
    const normalized: PartnerRecruitmentInput = {
      ...input,
      sourceCode: input.sourceCode.trim(),
      sourceProgramId: input.sourceProgramId.trim(),
      title: input.title.trim(),
      body: input.body.trim(),
      region: input.region.trim(),
      capabilities: [...new Set(input.capabilities.map((capability) => capability.trim()).filter(Boolean))],
    }
    const problem = validatePartnerRecruitmentInput(normalized)
    if (problem) throw new RangeError(problem)
    return this.repository.create(normalized, signal)
  }
}

/** 수정은 작성과 같은 내용 규칙을 쓰되 공고는 바꾸지 않습니다. 서버가 작성자·모집 상태·마감일을 다시 확인합니다. */
export class UpdatePartnerRecruitmentUseCase {
  private readonly repository: Pick<PartnerRecruitmentRepository, 'update'>

  constructor(repository: Pick<PartnerRecruitmentRepository, 'update'>) {
    this.repository = repository
  }

  execute(id: number, input: PartnerRecruitmentContentInput, signal?: AbortSignal) {
    if (!Number.isInteger(id) || id < 1) throw new RangeError('recruitment id must be a positive integer')
    const normalized: PartnerRecruitmentContentInput = {
      ...input,
      title: input.title.trim(),
      body: input.body.trim(),
      region: input.region.trim(),
      capabilities: [...new Set(input.capabilities.map((capability) => capability.trim()).filter(Boolean))],
    }
    const problem = validatePartnerRecruitmentContent(normalized)
    if (problem) throw new RangeError(problem)
    return this.repository.update(id, normalized, signal)
  }
}

export class ClosePartnerRecruitmentUseCase {
  private readonly repository: Pick<PartnerRecruitmentRepository, 'close'>

  constructor(repository: Pick<PartnerRecruitmentRepository, 'close'>) {
    this.repository = repository
  }

  execute(id: number, signal?: AbortSignal) {
    if (!Number.isInteger(id) || id < 1) throw new RangeError('recruitment id must be a positive integer')
    return this.repository.close(id, signal)
  }
}

/** 화면과 UseCase가 함께 쓰는 입력 규칙입니다. 문제가 없으면 null입니다. */
export function validatePartnerRecruitmentInput(input: PartnerRecruitmentInput): string | null {
  if (!input.sourceCode || !input.sourceProgramId) return 'program'
  return validatePartnerRecruitmentContent(input)
}

/** 공고를 뺀 내용 규칙입니다. 작성·수정이 함께 씁니다. */
export function validatePartnerRecruitmentContent(input: PartnerRecruitmentContentInput): string | null {
  if (!input.title || input.title.length > recruitmentTitleMaxLength) return 'title'
  if (!input.body || input.body.length > recruitmentBodyMaxLength) return 'body'
  if (!ownPartnerRoles.includes(input.ownRole)) return 'ownRole'
  if (!Number.isInteger(input.seekingCount) || input.seekingCount < seekingCountRange.min || input.seekingCount > seekingCountRange.max) {
    return 'seekingCount'
  }
  if (!input.region) return 'region'
  if (input.minimumCompanyAgeYears !== null && (!Number.isInteger(input.minimumCompanyAgeYears)
    || input.minimumCompanyAgeYears < companyAgeYearsRange.min || input.minimumCompanyAgeYears > companyAgeYearsRange.max)) {
    return 'minimumCompanyAgeYears'
  }
  if (input.capabilities.length > recruitmentCapabilityMaxCount
    || input.capabilities.some((capability) => capability.length > recruitmentCapabilityMaxLength)) {
    return 'capabilities'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recruitmentDeadline)) return 'recruitmentDeadline'
  return null
}
