import type {
  AdminAccountActionKind,
  AdminAccountDetail,
  AdminAccountPage,
  AdminAccountQuery,
  AdminAccountStats,
} from '../../domain/entities/AdminAccount'
import type { AdminAccountActionResult, AdminAccountRepository } from '../../domain/repositories/AdminAccountRepository'
import { AccountApiError } from '../api/accountApi'
import {
  browseAdminAccountsApi,
  getAdminAccountApi,
  getAdminAccountStatsApi,
  takeAdminAccountActionApi,
} from '../api/adminAccountApi'
import { toAdminAccountDetail, toAdminAccountPage, toAdminAccountStats } from '../models/AdminAccountDto'

/** Core API 관리자 계정 DTO를 Domain 값으로 바꾸고, 화면이 구분해 안내할 실패는 결과로 돌려주는 adapter입니다. */
export class AdminAccountRepositoryImpl implements AdminAccountRepository {
  async getStats(signal?: AbortSignal): Promise<AdminAccountStats> {
    return toAdminAccountStats(await getAdminAccountStatsApi(signal))
  }

  async browse(query: AdminAccountQuery, signal?: AbortSignal): Promise<AdminAccountPage> {
    return toAdminAccountPage(await browseAdminAccountsApi(query, signal))
  }

  /** 없거나 삭제된 계정(404)은 null입니다. */
  async getDetail(id: number, signal?: AbortSignal): Promise<AdminAccountDetail | null> {
    try {
      return toAdminAccountDetail(await getAdminAccountApi(id, signal))
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404 && error.code === 'ADMIN_ACCOUNT_NOT_FOUND') return null
      throw error
    }
  }

  async act(id: number, kind: AdminAccountActionKind, reason: string, signal?: AbortSignal): Promise<AdminAccountActionResult> {
    try {
      return { outcome: 'done', detail: toAdminAccountDetail(await takeAdminAccountActionApi(id, kind, reason, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.code === 'ADMIN_ACCOUNT_NOT_FOUND') return { outcome: 'not-found' }
        if (error.code === 'ADMIN_SELF_ACTION') return { outcome: 'self-action' }
        if (error.code === 'ADMIN_TARGET_PROTECTED') return { outcome: 'protected' }
        if (error.code === 'ADMIN_ACCOUNT_STATE_CONFLICT') return { outcome: 'conflict' }
      }
      throw error
    }
  }
}
