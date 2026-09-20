import type {
  PartnerRecruitment,
  PartnerRecruitmentContentInput,
  PartnerRecruitmentInput,
  PartnerRecruitmentSummary,
} from '../../domain/entities/PartnerRecruitment'
import type { PartnerRecruitmentPage, PartnerRecruitmentQuery } from '../../domain/entities/PartnerRecruitmentQuery'
import type {
  ClosePartnerRecruitmentResult,
  CreatePartnerRecruitmentResult,
  PartnerRecruitmentRepository,
  UpdatePartnerRecruitmentResult,
} from '../../domain/repositories/PartnerRecruitmentRepository'
import { AccountApiError } from '../api/accountApi'
import {
  browsePartnerRecruitmentsApi,
  closePartnerRecruitmentApi,
  createPartnerRecruitmentApi,
  getPartnerRecruitmentApi,
  PartnerRecruitmentApiError,
  updatePartnerRecruitmentApi,
} from '../api/partnerRecruitmentApi'
import { toPartnerRecruitment, toPartnerRecruitmentPage } from '../models/PartnerRecruitmentDto'

/** Core API 모집글 DTO를 Domain 값으로 바꾸고, 화면이 구분해 안내할 실패는 결과로 돌려주는 adapter입니다. */
export class PartnerRecruitmentRepositoryImpl implements PartnerRecruitmentRepository {
  async browse(query: PartnerRecruitmentQuery, signal?: AbortSignal): Promise<PartnerRecruitmentPage<PartnerRecruitmentSummary>> {
    return toPartnerRecruitmentPage(await browsePartnerRecruitmentsApi(query, signal))
  }

  /** 없는 글(404)은 null입니다. */
  async getDetail(id: number, signal?: AbortSignal): Promise<PartnerRecruitment | null> {
    try {
      return toPartnerRecruitment(await getPartnerRecruitmentApi(id, signal))
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404 && error.code === 'RECRUITMENT_NOT_FOUND') return null
      throw error
    }
  }

  async create(input: PartnerRecruitmentInput, signal?: AbortSignal): Promise<CreatePartnerRecruitmentResult> {
    try {
      return { outcome: 'created', recruitment: toPartnerRecruitment(await createPartnerRecruitmentApi(input, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.code === 'COMPANY_REQUIRED') return { outcome: 'company-required' }
        if (error.code === 'RECRUITMENT_PROGRAM_NOT_FOUND') return { outcome: 'program-not-found' }
        if (error.code === 'RECRUITMENT_PROGRAM_CLOSED') return { outcome: 'program-closed' }
        if (error.code === 'RECRUITMENT_DEADLINE_NOT_ALLOWED') {
          return {
            outcome: 'deadline-not-allowed',
            latestAllowedDeadline: error instanceof PartnerRecruitmentApiError ? error.latestAllowedDeadline : null,
          }
        }
        if (error.code === 'RECRUITMENT_ALREADY_EXISTS') return { outcome: 'already-exists' }
      }
      throw error
    }
  }

  async update(id: number, input: PartnerRecruitmentContentInput, signal?: AbortSignal): Promise<UpdatePartnerRecruitmentResult> {
    try {
      return { outcome: 'updated', recruitment: toPartnerRecruitment(await updatePartnerRecruitmentApi(id, input, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.code === 'RECRUITMENT_NOT_FOUND') return { outcome: 'not-found' }
        if (error.code === 'RECRUITMENT_ACTION_FORBIDDEN') return { outcome: 'forbidden' }
        if (error.code === 'RECRUITMENT_CLOSED') return { outcome: 'closed' }
        if (error.code === 'RECRUITMENT_DEADLINE_NOT_ALLOWED') {
          return {
            outcome: 'deadline-not-allowed',
            latestAllowedDeadline: error instanceof PartnerRecruitmentApiError ? error.latestAllowedDeadline : null,
          }
        }
      }
      throw error
    }
  }

  async close(id: number, signal?: AbortSignal): Promise<ClosePartnerRecruitmentResult> {
    try {
      return { outcome: 'closed', recruitment: toPartnerRecruitment(await closePartnerRecruitmentApi(id, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.code === 'RECRUITMENT_NOT_FOUND') return { outcome: 'not-found' }
        if (error.code === 'RECRUITMENT_ACTION_FORBIDDEN') return { outcome: 'forbidden' }
        if (error.code === 'RECRUITMENT_CLOSED') return { outcome: 'already-closed' }
      }
      throw error
    }
  }
}
