import type {
  PartnerProposalBox,
  PartnerProposalBoxPage,
  PartnerProposalInput,
} from '../../domain/entities/PartnerProposal'
import type {
  PartnerProposalAction,
  PartnerProposalRepository,
  RespondPartnerProposalResult,
  SendPartnerProposalResult,
} from '../../domain/repositories/PartnerProposalRepository'
import { AccountApiError } from '../api/accountApi'
import {
  browsePartnerProposalsApi,
  respondPartnerProposalApi,
  sendPartnerProposalApi,
} from '../api/partnerProposalApi'
import { toPartnerProposal, toPartnerProposalBoxPage } from '../models/PartnerProposalDto'

/** Core API 제안 DTO를 Domain 값으로 바꾸고, 화면이 구분해 안내할 실패는 결과로 돌려주는 adapter입니다. */
export class PartnerProposalRepositoryImpl implements PartnerProposalRepository {
  async send(recruitmentId: number, input: PartnerProposalInput, signal?: AbortSignal): Promise<SendPartnerProposalResult> {
    try {
      return { outcome: 'sent', proposal: toPartnerProposal(await sendPartnerProposalApi(recruitmentId, input, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.code === 'COMPANY_REQUIRED') return { outcome: 'company-required' }
        if (error.code === 'RECRUITMENT_NOT_FOUND') return { outcome: 'recruitment-not-found' }
        if (error.code === 'PROPOSAL_OWN_RECRUITMENT') return { outcome: 'own-recruitment' }
        if (error.code === 'RECRUITMENT_CLOSED') return { outcome: 'recruitment-closed' }
        if (error.code === 'PROPOSAL_ALREADY_SENT') return { outcome: 'already-sent' }
      }
      throw error
    }
  }

  async respond(id: number, action: PartnerProposalAction, signal?: AbortSignal): Promise<RespondPartnerProposalResult> {
    try {
      return { outcome: 'updated', proposal: toPartnerProposal(await respondPartnerProposalApi(id, action, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.code === 'PROPOSAL_NOT_PENDING') return { outcome: 'not-pending' }
        if (error.code === 'PROPOSAL_ACTION_FORBIDDEN') return { outcome: 'forbidden' }
        if (error.code === 'PROPOSAL_NOT_FOUND') return { outcome: 'not-found' }
      }
      throw error
    }
  }

  async browseBox(box: PartnerProposalBox, signal?: AbortSignal): Promise<PartnerProposalBoxPage> {
    return toPartnerProposalBoxPage(await browsePartnerProposalsApi(box, signal))
  }
}
