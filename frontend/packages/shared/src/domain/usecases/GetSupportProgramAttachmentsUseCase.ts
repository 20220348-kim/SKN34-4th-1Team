import type { SupportProgramAttachment } from '../entities/SupportProgram'
import type {
  SupportProgramIdentity,
  SupportProgramRepository,
} from '../repositories/SupportProgramRepository'

type SupportProgramAttachmentRepository = Pick<SupportProgramRepository, 'getAttachments'>

/** 공고 상세에 보여 줄 공식 첨부 목록을 가져오는 유스케이스입니다. */
export class GetSupportProgramAttachmentsUseCase {
  private readonly repository: SupportProgramAttachmentRepository

  constructor(repository: SupportProgramAttachmentRepository) {
    this.repository = repository
  }

  execute(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<SupportProgramAttachment[]> {
    return this.repository.getAttachments(identity, signal)
  }
}
