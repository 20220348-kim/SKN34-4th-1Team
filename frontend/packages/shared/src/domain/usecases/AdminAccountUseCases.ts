import {
  adminActionReasonMaxLength,
  type AdminAccountActionKind,
  type AdminAccountQuery,
} from '../entities/AdminAccount'
import type { AdminAccountRepository } from '../repositories/AdminAccountRepository'

/** 목록 위 요약 수치를 읽습니다. */
export class GetAdminAccountStatsUseCase {
  private readonly repository: Pick<AdminAccountRepository, 'getStats'>

  constructor(repository: Pick<AdminAccountRepository, 'getStats'>) {
    this.repository = repository
  }

  execute(signal?: AbortSignal) {
    return this.repository.getStats(signal)
  }
}

/** 검색어는 앞뒤 공백을 지우고 보냅니다. 페이지가 잘못되면 첫 페이지로 봅니다. */
export class BrowseAdminAccountsUseCase {
  private readonly repository: Pick<AdminAccountRepository, 'browse'>

  constructor(repository: Pick<AdminAccountRepository, 'browse'>) {
    this.repository = repository
  }

  execute(query: AdminAccountQuery, signal?: AbortSignal) {
    const page = Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
    return this.repository.browse({ ...query, keyword: query.keyword.trim(), page }, signal)
  }
}

export class GetAdminAccountDetailUseCase {
  private readonly repository: Pick<AdminAccountRepository, 'getDetail'>

  constructor(repository: Pick<AdminAccountRepository, 'getDetail'>) {
    this.repository = repository
  }

  execute(id: number, signal?: AbortSignal) {
    if (!Number.isInteger(id) || id < 1) throw new RangeError('account id must be a positive integer')
    return this.repository.getDetail(id, signal)
  }
}

/** 사유는 앞뒤 공백을 지운 1~500자만 보냅니다. 서버가 대상 규칙(자기 계정·관리자 계정·현재 상태)을 다시 확인합니다. */
export class TakeAdminAccountActionUseCase {
  private readonly repository: Pick<AdminAccountRepository, 'act'>

  constructor(repository: Pick<AdminAccountRepository, 'act'>) {
    this.repository = repository
  }

  execute(id: number, kind: AdminAccountActionKind, reason: string, signal?: AbortSignal) {
    if (!Number.isInteger(id) || id < 1) throw new RangeError('account id must be a positive integer')
    const normalized = reason.trim()
    if (normalized.length === 0 || normalized.length > adminActionReasonMaxLength) {
      throw new RangeError(`reason must be 1~${adminActionReasonMaxLength} characters`)
    }
    return this.repository.act(id, kind, normalized, signal)
  }
}
