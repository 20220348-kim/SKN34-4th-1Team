export const reviewStages = ['APPLICATION', 'SELECTION', 'COMMITMENT', 'AGREEMENT', 'EXECUTION', 'FUNDING'] as const
/** 세 질문 방식(combination-review-v3)의 질문입니다. 응답은 늘 이 순서로 한 번씩 답합니다. */
export const reviewQuestionKinds = ['APPLY', 'CONCURRENT', 'SAME_SUBJECT'] as const
export const reviewAnswerVerdicts = ['ALLOWED', 'CONDITIONAL', 'NOT_ALLOWED', 'NO_RULE', 'ASK_INSTITUTION'] as const
export const reviewConsequenceMoments = ['EVALUATION', 'SELECTION', 'AGREEMENT', 'EXECUTION', 'SETTLEMENT', 'AFTER'] as const
export type ReviewQuestionKind = typeof reviewQuestionKinds[number]
export type ReviewAnswerVerdict = typeof reviewAnswerVerdicts[number]
export type ReviewConsequenceMoment = typeof reviewConsequenceMoments[number]
export type ReviewCitation = { evidenceId: string; quote: string }
/** 질문 하나의 답입니다. 조건부는 조건별 결과를, 기관 확인은 기관에 물어볼 문장을 함께 줍니다. */
export type ReviewAnswer = {
  question: ReviewQuestionKind; verdict: ReviewAnswerVerdict; explanation: string
  conditions: { condition: string; result: 'ALLOWED' | 'NOT_ALLOWED'; citations: ReviewCitation[] }[]
  consequences: { moment: ReviewConsequenceMoment; action: string; citations: ReviewCitation[] }[]
  institutionQuestion: string
  citations: ReviewCitation[]
}
export type ParticipationAnswer = 'UNKNOWN' | 'YES' | 'NO'
/** 두 사업의 관계(선택 입력)입니다. 같은 과제·제품인지, 같은 비용 항목에 쓰는지 예·아니오·모름으로 받습니다. */
export type ReviewRelation = { sameProject: ParticipationAnswer; sameCost: ParticipationAnswer }
export type Participation = {
  applicationSubmitted: ParticipationAnswer; selected: ParticipationAnswer
  commitmentSubmitted: ParticipationAnswer; agreementSigned: ParticipationAnswer
  executionStatus: 'UNKNOWN' | 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'STOPPED'
  fundingReceived: ParticipationAnswer
}
export type ReviewProgram = {
  sourceCode: string; sourceProgramId: string; subProgramId: string | null; participation: Participation
}
/** relation이 없으면 모두 모름으로 봅니다(관계 칸이 생기기 전 저장 입력 · 서버 응답). */
export type ReviewDraft = { title: string; programs: ReviewProgram[]; relation?: ReviewRelation }
export type ReviewSummary = { id: number; title: string; inputRevision: number; createdAt: string; updatedAt: string }
export type CombinationReview = ReviewSummary & ReviewDraft
export type ReviewPage<T> = { items: T[]; nextBeforeId: number | null }
export type RunRequest = { expectedRevision: number; requestKey: string; additionalFacts: string }
export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'UNKNOWN'
export type RunSummary = { id: number; inputRevision: number; status: RunStatus; failureCode: string | null; startedAt: string; finishedAt: string | null }
/** 목록 행입니다. latestRun은 가장 최근에 접수한 실행이며 실행 전이면 null입니다. */
export type ReviewListItem = ReviewSummary & { latestRun: RunSummary | null }
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
    /** 여섯 단계 방식(v2) 실행은 stages, 세 질문 방식(v3) 실행은 answers를 채우고 다른 쪽은 비어 있습니다. answers가 없던 응답은 v2입니다. */
    pairs: { firstProgramIndex: number; secondProgramIndex: number; stages: {
      stage: typeof reviewStages[number]
      judgment: 'RESTRICTION_APPLIES' | 'PERMISSION_IN_SCOPE' | 'NEEDS_FACTS' | 'INSUFFICIENT_EVIDENCE' | 'CONFLICTING_EVIDENCE'
      scope: string; explanation: string; questions: string[]; requiresInstitutionConfirmation: boolean
      citations: ReviewCitation[]
    }[]; answers?: ReviewAnswer[] }[]
    limitations: string[]
  }
}

export function unknownParticipation(): Participation {
  return { applicationSubmitted: 'UNKNOWN', selected: 'UNKNOWN', commitmentSubmitted: 'UNKNOWN', agreementSigned: 'UNKNOWN', executionStatus: 'UNKNOWN', fundingReceived: 'UNKNOWN' }
}
export function unknownRelation(): ReviewRelation {
  return { sameProject: 'UNKNOWN', sameCost: 'UNKNOWN' }
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
  return structuredClone({ title, programs: draft.programs, ...(draft.relation ? { relation: draft.relation } : {}) })
}
