import type { SupportProgram } from '../../../domain/entities/SupportProgram'

/** 카드·채팅 문구·스크린 리더가 같은 자격 판정 기준으로 결과를 구분합니다. */
export function getSupportProgramEligibilityKind(program: SupportProgram): 'matched' | 'reviewRequired' | 'unevaluated' {
  if (program.eligibilityReview?.status === 'MATCH') return 'matched'
  if (!program.eligibilityReview && program.recommendationScore === null) return 'unevaluated'
  return 'reviewRequired'
}

export function groupSupportProgramsByEligibility(programs: SupportProgram[]) {
  const matched: SupportProgram[] = []
  const reviewRequired: SupportProgram[] = []
  const latest: SupportProgram[] = []
  for (const program of programs) {
    const kind = getSupportProgramEligibilityKind(program)
    if (kind === 'matched') matched.push(program)
    else if (kind === 'unevaluated') latest.push(program)
    else reviewRequired.push(program)
  }
  return { matched, reviewRequired, latest }
}

export function formatSupportProgramEligibilityCounts(programs: SupportProgram[]) {
  const groups = groupSupportProgramsByEligibility(programs)
  return [
    `조건 확인 공고 ${groups.matched.length}건`,
    `확인 필요 공고 ${groups.reviewRequired.length}건`,
    ...(groups.latest.length ? [`최신 공고 ${groups.latest.length}건(자격 미평가)`] : []),
  ].join(', ')
}
