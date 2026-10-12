import type { SupportProgramConversationContext, SupportProgramConversationField } from './SupportProgramConversation'
import type { SupportProgramSearchExclusionCounts } from './SupportProgramSearchResult'

/**
 * 추천 결과가 없을 때 사용자가 골라 다시 찾을 수 있는 조건 빼기입니다.
 *
 * 조건을 자동으로 풀지 않습니다. 고른 조건 빼기는 확인 카드를 거쳐야 검색하며, AI를 다시 부르지 않고 마지막 검색 조건에서
 * 해당 조건만 지운 제안을 만듭니다. 서버가 알려 준 "이 사유로 뺀 후보 수"가 0이면 그 조건 빼기는 도움이 되지 않으므로
 * 보이지 않고, 수를 모르면(이전 서버·저장된 대화) 조건이 있는 빼기를 모두 보입니다.
 */
export type SupportProgramSearchRelaxationKind = 'REGION' | 'COMPANY_PROFILE' | 'ACCEPTING_ONLY'

export type SupportProgramSearchRelaxation = {
  kind: SupportProgramSearchRelaxationKind
  label: string
  /** 이 조건 때문에 추천에서 뺀 후보 수입니다. 조건을 빼고 다시 찾은 결과 수가 아니며, 모르면 null입니다. */
  excludedCount: number | null
}

/** 마지막 검색 조건과 서버가 알려 준 제외 후보 수로 보여 줄 조건 빼기를 뺀 후보가 많은 순서로 고릅니다. */
export function supportProgramSearchRelaxations(
  context: SupportProgramConversationContext,
  counts: SupportProgramSearchExclusionCounts | null | undefined,
): SupportProgramSearchRelaxation[] {
  const conditions = context.companyConditions
  const relaxations: SupportProgramSearchRelaxation[] = []
  if (conditions.region && (!counts || counts.region > 0)) {
    relaxations.push({ kind: 'REGION', label: '지역 조건 빼고 찾기', excludedCount: counts?.region ?? null })
  }
  const profileLabel = companyProfileLabel(context)
  if (profileLabel && (!counts || counts.target > 0)) {
    relaxations.push({ kind: 'COMPANY_PROFILE', label: `${profileLabel} 조건 빼고 찾기`, excludedCount: counts?.target ?? null })
  }
  // 마감·예정 공고 중 관련 공고가 몇 건인지는 검색해 봐야 알 수 있어 수를 붙이지 않습니다.
  if (context.acceptingOnly) relaxations.push({ kind: 'ACCEPTING_ONLY', label: '마감·예정 공고도 찾기', excludedCount: null })
  return relaxations
    .map((relaxation, index) => ({ relaxation, index }))
    .sort((left, right) => (right.relaxation.excludedCount ?? -1) - (left.relaxation.excludedCount ?? -1) || left.index - right.index)
    .map(({ relaxation }) => relaxation)
}

/** 추천에서 뺀 사유를 한 문장으로 알립니다. 수를 모르면 null입니다. 원인을 하나로 단정하지 않고 센 그대로 적습니다. */
export function supportProgramZeroResultExplanation(counts: SupportProgramSearchExclusionCounts | null | undefined): string | null {
  if (!counts) return null
  if (counts.candidateCount === 0) return '검색어와 관련된 공고 후보를 찾지 못했어요.'
  const reasons = [
    counts.lowRelevance > 0 ? `요청과 관련이 낮은 공고 ${counts.lowRelevance}건` : null,
    counts.target > 0 ? `지원 대상이 회사 조건과 맞지 않는 공고 ${counts.target}건` : null,
    counts.region > 0 ? `회사 지역과 맞지 않는 공고 ${counts.region}건` : null,
  ].filter((reason): reason is string => reason !== null)
  if (!reasons.length) return null
  return `관련 후보 ${counts.candidateCount}건을 살펴봤지만 ${reasons.join(', ')}이라 추천하지 않았어요.`
}

/** 마지막 검색 조건에서 고른 조건만 지운 새 조건과 바뀐 항목입니다. 검색어와 나머지 조건은 그대로 둡니다. */
export function relaxSupportProgramSearch(
  context: SupportProgramConversationContext,
  kind: SupportProgramSearchRelaxationKind,
): { context: SupportProgramConversationContext; changedFields: SupportProgramConversationField[] } {
  const conditions = context.companyConditions
  if (kind === 'ACCEPTING_ONLY') return { context: { ...context, acceptingOnly: false, companyConditions: { ...conditions } }, changedFields: ['ACCEPTING_ONLY'] }
  if (kind === 'REGION') return { context: { ...context, companyConditions: { ...conditions, region: null } }, changedFields: ['REGION'] }
  const changedFields: SupportProgramConversationField[] = []
  if (conditions.industry) changedFields.push('INDUSTRY')
  if (conditions.establishedOn) changedFields.push('ESTABLISHED_ON')
  if (conditions.foundedYear != null) changedFields.push('FOUNDED_YEAR')
  return {
    context: { ...context, companyConditions: { ...conditions, industry: null, establishedOn: null, foundedYear: null } },
    changedFields,
  }
}

/** 지원 대상 판정에 쓰는 회사 조건(업종·설립)의 이름입니다. 둘 다 없으면 null입니다. */
function companyProfileLabel(context: SupportProgramConversationContext): string | null {
  const conditions = context.companyConditions
  const founding = Boolean(conditions.establishedOn) || conditions.foundedYear != null
  if (conditions.industry && founding) return '업종·설립'
  if (conditions.industry) return '업종'
  return founding ? '설립' : null
}
