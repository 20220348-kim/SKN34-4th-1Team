import type {
  SupportProgramEvidenceQuestion,
  SupportProgramEvidenceQuestionResult,
  SupportProgramRepository,
} from '../repositories/SupportProgramRepository'

type SupportProgramEvidenceRepository = Pick<
  SupportProgramRepository,
  'answerEvidenceQuestion'
>

/** 사용자가 선택한 공고의 공식 원문만 근거로 질문에 답하는 유스케이스입니다. */
export class AskSupportProgramEvidenceQuestionUseCase {
  private readonly repository: SupportProgramEvidenceRepository

  constructor(repository: SupportProgramEvidenceRepository) {
    this.repository = repository
  }

  execute(
    command: SupportProgramEvidenceQuestion,
    signal?: AbortSignal,
  ): Promise<SupportProgramEvidenceQuestionResult> {
    return this.repository.answerEvidenceQuestion({
      ...command,
      question: command.question.trim(),
    }, signal)
  }
}
