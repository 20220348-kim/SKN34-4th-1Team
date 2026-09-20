import type {
  PartnerProposal,
  PartnerProposalBox,
  PartnerProposalBoxPage,
  PartnerProposalInput,
} from '../entities/PartnerProposal'

/** 보내기 실패 사유는 화면이 다르게 안내해야 하므로 예외가 아닌 결과로 구분합니다. */
export type SendPartnerProposalResult =
  | { outcome: 'sent'; proposal: PartnerProposal }
  | { outcome: 'company-required' }
  | { outcome: 'recruitment-not-found' }
  | { outcome: 'own-recruitment' }
  | { outcome: 'recruitment-closed' }
  | { outcome: 'already-sent' }

export type RespondPartnerProposalResult =
  | { outcome: 'updated'; proposal: PartnerProposal }
  | { outcome: 'not-pending' }
  | { outcome: 'forbidden' }
  | { outcome: 'not-found' }

export type PartnerProposalAction = 'accept' | 'decline' | 'withdraw'

/** 파트너 제안 기능이 Data Layer의 HTTP 세부사항과 분리되도록 하는 Domain 포트입니다. 모든 요청은 세션이 필요합니다. */
export interface PartnerProposalRepository {
  send(recruitmentId: number, input: PartnerProposalInput, signal?: AbortSignal): Promise<SendPartnerProposalResult>
  respond(id: number, action: PartnerProposalAction, signal?: AbortSignal): Promise<RespondPartnerProposalResult>
  browseBox(box: PartnerProposalBox, signal?: AbortSignal): Promise<PartnerProposalBoxPage>
}
