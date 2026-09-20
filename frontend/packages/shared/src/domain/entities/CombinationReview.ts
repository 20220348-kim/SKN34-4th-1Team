export const reviewStages = ['APPLICATION', 'SELECTION', 'COMMITMENT', 'AGREEMENT', 'EXECUTION', 'FUNDING'] as const
export type ParticipationAnswer = 'UNKNOWN' | 'YES' | 'NO'
export type Participation = {
  applicationSubmitted: ParticipationAnswer; selected: ParticipationAnswer
  commitmentSubmitted: ParticipationAnswer; agreementSigned: ParticipationAnswer
  executionStatus: 'UNKNOWN' | 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'STOPPED'
  fundingReceived: ParticipationAnswer
}
export type ReviewProgram = {
  sourceCode: string; sourceProgramId: string; subProgramId: string | null; participation: Participation
}
export type ReviewDraft = { title: string; programs: ReviewProgram[] }
export type ReviewSummary = { id: number; title: string; inputRevision: number; createdAt: string; updatedAt: string }
export type CombinationReview = ReviewSummary & ReviewDraft
export type ReviewPage<T> = { items: T[]; nextBeforeId: number | null }
export type RunRequest = { expectedRevision: number; requestKey: string; additionalFacts: string }
export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'UNKNOWN'
export type RunSummary = { id: number; inputRevision: number; status: RunStatus; failureCode: string | null; startedAt: string; finishedAt: string | null }
export type ReviewRun = RunSummary & {
  reviewId: number; requestKey: string
  input: ReviewDraft & { additionalFacts: string; asOfDate: string }
  evidence: null | {
    documents: { programIndex: number; sourceUrl: string; sourcePageUrl: string | null; fileName: string; format: string; rawHash: string; textHash: string; parserVersion: string; fetchedAt: string }[]
    blocks: { id: string; programIndex: number; documentHash: string; locator: string; text: string }[]
    coverageWarnings: string[]; reviewStatus: 'AUTOMATIC_UNREVIEWED'
  }
  configuration: null | { contractVersion: string; model: string; promptVersion: string }
  analysis: null | {
    summary: string
    pairs: { firstProgramIndex: number; secondProgramIndex: number; stages: {
      stage: typeof reviewStages[number]
      judgment: 'RESTRICTION_APPLIES' | 'PERMISSION_IN_SCOPE' | 'NEEDS_FACTS' | 'INSUFFICIENT_EVIDENCE' | 'CONFLICTING_EVIDENCE'
      scope: string; explanation: string; questions: string[]; requiresInstitutionConfirmation: boolean
      citations: { evidenceId: string; quote: string }[]
    }[] }[]
    limitations: string[]
  }
}

export function unknownParticipation(): Participation {
  return { applicationSubmitted: 'UNKNOWN', selected: 'UNKNOWN', commitmentSubmitted: 'UNKNOWN', agreementSigned: 'UNKNOWN', executionStatus: 'UNKNOWN', fundingReceived: 'UNKNOWN' }
}
export function reviewProgramKey(program: Pick<ReviewProgram, 'sourceCode' | 'sourceProgramId'>): string {
  return `${program.sourceCode}:${program.sourceProgramId}`
}
export function supportsAutomaticReview(program: Pick<ReviewProgram, 'sourceCode' | 'sourceProgramId' | 'subProgramId'>): boolean {
  const supportedIdentity = program.sourceCode === 'BIZINFO'
    ? /^PBLN_[0-9]{1,32}$/.test(program.sourceProgramId)
    : ['KSTARTUP', 'MSIT', 'CNTRADE_NOTICE'].includes(program.sourceCode) && /^[1-9][0-9]{0,254}$/.test(program.sourceProgramId)
  return supportedIdentity && program.subProgramId === null
}
export function validateReviewDraft(draft: ReviewDraft): ReviewDraft {
  const title = draft.title.trim()
  if (!title || [...title].length > 200 || /\p{C}/u.test(title)) throw new Error('제목은 제어문자 없이 1~200자로 입력해 주세요.')
  if (draft.programs.length !== 2) throw new Error('비교할 서로 다른 사업을 2개 선택해 주세요.')
  if (new Set(draft.programs.map(reviewProgramKey)).size !== draft.programs.length) throw new Error('같은 공고를 중복 선택할 수 없습니다.')
  return structuredClone({ title, programs: draft.programs })
}
