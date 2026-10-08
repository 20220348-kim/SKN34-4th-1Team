import {
  reviewQuestionKinds, reviewStages, type Participation, type ReviewAnswer, type ReviewAnswerVerdict, type ReviewConsequenceMoment, type ReviewQuestionKind, type ReviewRun,
} from './CombinationReview'

export type ReviewStageResult = NonNullable<ReviewRun['analysis']>['pairs'][number]['stages'][number]
export type ReviewJudgment = ReviewStageResult['judgment']
export type ReviewStage = ReviewStageResult['stage']

export const reviewStageLabels: Record<ReviewStage, string> = { APPLICATION: '신청', SELECTION: '선정', COMMITMENT: '확약', AGREEMENT: '협약', EXECUTION: '수행', FUNDING: '교부' }
export const reviewJudgmentLabels: Record<ReviewJudgment, string> = {
  RESTRICTION_APPLIES: '제한 적용', PERMISSION_IN_SCOPE: '명시된 범위 내 허용', NEEDS_FACTS: '사용자 정보 부족',
  INSUFFICIENT_EVIDENCE: '공식 근거 부족', CONFLICTING_EVIDENCE: '규정 충돌',
}

/** 판정 다섯 가지를 세 묶음으로 보여 줍니다: 주의(제한 · 충돌) · 확인 필요(정보 · 근거 부족) · 가능(명시된 범위 내 허용). */
export type ReviewVerdict = 'warn' | 'info' | 'ok'
export const reviewVerdictLabels: Record<ReviewVerdict, string> = { warn: '주의', info: '확인 필요', ok: '가능' }
export function reviewVerdictOf(judgment: ReviewJudgment): ReviewVerdict {
  if (judgment === 'RESTRICTION_APPLIES' || judgment === 'CONFLICTING_EVIDENCE') return 'warn'
  return judgment === 'PERMISSION_IN_SCOPE' ? 'ok' : 'info'
}

export type ReviewHeadline = { verdict: ReviewVerdict; title: string; reason: string }

const stageNames = (stages: readonly ReviewStageResult[]) =>
  [...new Set(stages.map((stage) => stage.stage))].sort((a, b) => reviewStages.indexOf(a) - reviewStages.indexOf(b)).map((stage) => reviewStageLabels[stage]).join(' · ')

const allUnknown = (participation: Participation) => Object.values(participation).every((answer) => answer === 'UNKNOWN')

/**
 * 결과 맨 위 결론 문장입니다. AI 요약 대신 단계 판정 조합으로 정해, 같은 판정이면 늘 같은 문장이 나옵니다.
 * 제한 → 충돌 → 모두 허용 → 그 밖(정보 · 근거 부족 포함) 순으로 고릅니다.
 */
export function reviewHeadline(stages: readonly ReviewStageResult[], participations: readonly Participation[] = []): ReviewHeadline {
  const restricted = stages.filter((stage) => stage.judgment === 'RESTRICTION_APPLIES')
  const conflicting = stages.filter((stage) => stage.judgment === 'CONFLICTING_EVIDENCE')
  if (restricted.length > 0) return {
    verdict: 'warn', title: '함께 진행하면 문제가 될 수 있는 단계가 있어요',
    reason: `${stageNames(restricted)} 단계에 공고가 정한 제한이 적용돼요.${conflicting.length > 0 ? ` ${stageNames(conflicting)} 단계는 공고 내용이 서로 달라요.` : ''}`,
  }
  if (conflicting.length > 0) return {
    verdict: 'warn', title: '공고 내용이 서로 달라 기관 확인이 필요해요',
    reason: `${stageNames(conflicting)} 단계의 규정이 서로 맞지 않아 어느 쪽이 적용되는지 정할 수 없어요.`,
  }
  if (stages.length > 0 && stages.every((stage) => stage.judgment === 'PERMISSION_IN_SCOPE')) return {
    verdict: 'ok', title: '찾은 원문 범위에서는 함께 진행을 막는 조항이 없었어요',
    reason: '공고가 명시한 범위 안의 허용이에요. 전체 신청 자격이나 동시 수혜를 보장하지는 않아요.',
  }
  const needsFacts = stages.filter((stage) => stage.judgment === 'NEEDS_FACTS')
  const noEvidence = stages.filter((stage) => stage.judgment === 'INSUFFICIENT_EVIDENCE')
  const detail = needsFacts.length > 0 && participations.length > 0 && participations.every(allUnknown) ? '내 참여 상태가 모두 미확인이에요.'
    : needsFacts.length > 0 && noEvidence.length > 0 ? `${stageNames(needsFacts)} 단계는 내 정보가, ${stageNames(noEvidence)} 단계는 공식 근거가 더 필요해요.`
      : needsFacts.length > 0 ? `${stageNames(needsFacts)} 단계는 내 정보가 더 필요해요.`
        : noEvidence.length > 0 ? `${stageNames(noEvidence)} 단계는 공식 근거가 더 필요해요.`
          : '판단한 단계가 없어요.'
  return { verdict: 'info', title: '두 공고를 함께 진행해도 되는지 아직 정할 수 없어요', reason: `공고에서 서로를 막는 조항은 찾지 못했고, ${detail}` }
}

export type ReviewQuestion = { stage: ReviewStage; text: string }

/**
 * "먼저 확인할 것" 목록입니다. 단계마다 아직 나오지 않은 첫 질문 하나를 고르고, 주의 단계 → 확인 필요 → 가능 · 단계 순으로 둡니다.
 * all은 모든 단계 질문을 중복 없이 모은 전체 목록입니다(앞뒤 공백만 다른 질문은 같은 질문으로 봅니다).
 */
export function reviewQuestions(stages: readonly ReviewStageResult[], limit: number = reviewStages.length): { priority: ReviewQuestion[]; all: ReviewQuestion[] } {
  const verdictRank: Record<ReviewVerdict, number> = { warn: 0, info: 1, ok: 2 }
  const ordered = [...stages].sort((a, b) => verdictRank[reviewVerdictOf(a.judgment)] - verdictRank[reviewVerdictOf(b.judgment)]
    || reviewStages.indexOf(a.stage) - reviewStages.indexOf(b.stage))
  const seen = new Set<string>()
  const all: ReviewQuestion[] = []
  const firstByStage: ReviewQuestion[] = []
  for (const stage of ordered) {
    let picked = false
    for (const question of stage.questions) {
      const text = question.trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      all.push({ stage: stage.stage, text })
      if (!picked) { firstByStage.push({ stage: stage.stage, text }); picked = true }
    }
  }
  return { priority: firstByStage.slice(0, limit), all }
}

// ---- 세 질문 방식(combination-review-v3) ----

export const reviewQuestionLabels: Record<ReviewQuestionKind, string> = {
  APPLY: '둘 다 신청할 수 있나요?', CONCURRENT: '둘 다 되면 함께 수행할 수 있나요?', SAME_SUBJECT: '같은 과제·비용으로 두 번 받는 것은 아닌가요?',
}
/** 결론 문장 · 요약 칩 · "○○ 질문에도 인용"에 쓰는 짧은 이름입니다. 셋 다 받침으로 끝나 조사 "은"을 씁니다. */
export const reviewQuestionShortLabels: Record<ReviewQuestionKind, string> = { APPLY: '신청', CONCURRENT: '함께 수행', SAME_SUBJECT: '같은 과제·비용' }
export const reviewAnswerVerdictLabels: Record<ReviewAnswerVerdict, string> = {
  ALLOWED: '가능', CONDITIONAL: '조건부', NOT_ALLOWED: '불가', NO_RULE: '규정 없음', ASK_INSTITUTION: '기관 확인',
}
export const reviewConsequenceMomentLabels: Record<ReviewConsequenceMoment, string> = {
  EVALUATION: '평가', SELECTION: '선정', AGREEMENT: '협약', EXECUTION: '수행', SETTLEMENT: '정산·지급', AFTER: '사후',
}

/** 판정의 색 단계입니다: 불가(warn) · 기관 확인(ask) · 조건부(conditional) · 규정 없음(neutral, 허용 아님) · 가능(ok). */
export type ReviewAnswerTone = 'warn' | 'ask' | 'conditional' | 'neutral' | 'ok'
const answerTones: Record<ReviewAnswerVerdict, ReviewAnswerTone> = {
  NOT_ALLOWED: 'warn', ASK_INSTITUTION: 'ask', CONDITIONAL: 'conditional', NO_RULE: 'neutral', ALLOWED: 'ok',
}
export function reviewAnswerToneOf(verdict: ReviewAnswerVerdict): ReviewAnswerTone {
  return answerTones[verdict]
}

/** 실행 분석이 세 질문 방식(v3)이면 사업쌍의 답을 질문 순서로 돌려줍니다. 여섯 단계 방식(v2)이면 null입니다. */
export function reviewAnswersOf(analysis: ReviewRun['analysis']): ReviewAnswer[] | null {
  const answers = analysis?.pairs.flatMap((pair) => pair.answers ?? []) ?? []
  if (answers.length === 0) return null
  return [...answers].sort((a, b) => reviewQuestionKinds.indexOf(a.question) - reviewQuestionKinds.indexOf(b.question))
}

export type ReviewAnswerHeadline = { tone: ReviewAnswerTone; title: string; reason: string }

/** 결론에서 판정을 고르는 순서입니다. 앞선 판정이 있으면 그 판정이 결론 문장이 됩니다. */
const verdictPriority: readonly ReviewAnswerVerdict[] = ['NOT_ALLOWED', 'ASK_INSTITUTION', 'CONDITIONAL', 'NO_RULE', 'ALLOWED']
const notAllowedTitles: Record<ReviewQuestionKind, string> = {
  APPLY: '두 공고에 함께 신청할 수 없어요', CONCURRENT: '둘 다 되어도 함께 수행할 수 없어요', SAME_SUBJECT: '같은 과제·비용으로 두 번 받을 수 없어요',
}
const groupSentences: Record<ReviewAnswerVerdict, (names: string) => string> = {
  NOT_ALLOWED: (names) => `${names}도 불가예요.`,
  ASK_INSTITUTION: (names) => `${names}은 기관 확인이 필요해요.`,
  CONDITIONAL: (names) => `${names}은 조건에 따라 달라요.`,
  NO_RULE: (names) => `${names}은 관련 규정을 찾지 못했어요.`,
  ALLOWED: (names) => `${names}은 가능해요.`,
}
const loneReasons: Record<ReviewAnswerVerdict, string> = {
  NOT_ALLOWED: '세 질문 모두 공고가 정한 제한이 적용돼요.',
  ASK_INSTITUTION: '규정이 서로 맞지 않거나 기관이 정하는 부분이에요. 아래 문장으로 기관에 물어보세요.',
  CONDITIONAL: '아래 조건 가운데 내 상황에 맞는 것을 확인해 주세요.',
  NO_RULE: '규정을 찾지 못한 것이 허용을 뜻하지는 않아요.',
  ALLOWED: '공고가 명시한 범위 안의 판단이에요. 신청 자격이나 선정을 보장하지는 않아요.',
}

/**
 * 세 질문 결과의 결론 문장입니다. AI 요약 대신 세 판정의 조합으로 정해 같은 판정이면 늘 같은 문장이 나옵니다.
 * 불가 → 기관 확인 → 조건부 → 규정 없음 → 가능 순으로 가장 앞선 판정이 제목이 되고, 나머지 질문은 같은 순서로 이유에 적습니다.
 */
export function reviewAnswerHeadline(answers: readonly ReviewAnswer[]): ReviewAnswerHeadline {
  const ordered = [...answers].sort((a, b) => reviewQuestionKinds.indexOf(a.question) - reviewQuestionKinds.indexOf(b.question))
  const top = verdictPriority.find((verdict) => ordered.some((answer) => answer.verdict === verdict)) ?? 'NO_RULE'
  const group = (verdict: ReviewAnswerVerdict) => ordered.filter((answer) => answer.verdict === verdict).map((answer) => answer.question)
  const names = (questions: readonly ReviewQuestionKind[]) => questions.map((question) => reviewQuestionShortLabels[question]).join(' · ')
  const topQuestions = group(top)
  const all = topQuestions.length === ordered.length
  const title = top === 'NOT_ALLOWED' ? notAllowedTitles[topQuestions[0]!]
    : top === 'ASK_INSTITUTION' ? `${names(topQuestions)}은 기관 확인이 필요해요`
      : top === 'CONDITIONAL' ? `${names(topQuestions)}은 조건에 따라 달라요`
        : top === 'NO_RULE' ? (all ? '두 공고에서 관련 규정을 찾지 못했어요' : `${names(topQuestions)}에 관한 규정을 찾지 못했어요`)
          : '찾은 원문 범위에서는 세 질문 모두 가능해요'
  const rest = [
    ...(top === 'NOT_ALLOWED' && topQuestions.length > 1 ? [groupSentences.NOT_ALLOWED(names(topQuestions.slice(1)))] : []),
    ...verdictPriority.filter((verdict) => verdict !== top).flatMap((verdict) => {
      const questions = group(verdict)
      return questions.length > 0 ? [groupSentences[verdict](names(questions))] : []
    }),
  ]
  const reason = rest.length > 0 && !(top === 'NOT_ALLOWED' && all) ? rest.join(' ') : loneReasons[top]
  return { tone: reviewAnswerToneOf(top), title, reason }
}
