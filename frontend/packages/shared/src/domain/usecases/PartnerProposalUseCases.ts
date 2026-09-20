import {
  proposalMessageMaxLength,
  type PartnerProposalBox,
  type PartnerProposalInput,
} from '../entities/PartnerProposal'
import type { PartnerProposalAction, PartnerProposalRepository } from '../repositories/PartnerProposalRepository'

function requirePositiveId(id: number, name: string) {
  if (!Number.isInteger(id) || id < 1) throw new RangeError(`${name} must be a positive integer`)
}

/** 메시지는 앞뒤 공백을 지운 뒤 1~500자만 보냅니다. 서버가 모집글 상태·중복을 다시 확인합니다. */
export class SendPartnerProposalUseCase {
  private readonly repository: Pick<PartnerProposalRepository, 'send'>

  constructor(repository: Pick<PartnerProposalRepository, 'send'>) {
    this.repository = repository
  }

  execute(recruitmentId: number, input: PartnerProposalInput, signal?: AbortSignal) {
    requirePositiveId(recruitmentId, 'recruitmentId')
    const message = input.message.trim()
    if (!message || message.length > proposalMessageMaxLength) throw new RangeError('message')
    return this.repository.send(recruitmentId, { message, shareProfile: input.shareProfile }, signal)
  }
}

/** 수락·거절은 모집글 작성자가, 철회는 제안자가 대기 중일 때만 합니다. 권한은 서버가 판정합니다. */
export class RespondPartnerProposalUseCase {
  private readonly repository: Pick<PartnerProposalRepository, 'respond'>

  constructor(repository: Pick<PartnerProposalRepository, 'respond'>) {
    this.repository = repository
  }

  execute(id: number, action: PartnerProposalAction, signal?: AbortSignal) {
    requirePositiveId(id, 'proposalId')
    return this.repository.respond(id, action, signal)
  }
}

export class BrowsePartnerProposalsUseCase {
  private readonly repository: Pick<PartnerProposalRepository, 'browseBox'>

  constructor(repository: Pick<PartnerProposalRepository, 'browseBox'>) {
    this.repository = repository
  }

  execute(box: PartnerProposalBox, signal?: AbortSignal) {
    return this.repository.browseBox(box, signal)
  }
}
