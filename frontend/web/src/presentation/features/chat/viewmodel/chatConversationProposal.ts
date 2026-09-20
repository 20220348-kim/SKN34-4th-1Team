import type {
  SupportProgramConversationContext,
  SupportProgramInterpretation,
  SupportProgramPendingClarification,
} from '../../../../domain/entities/SupportProgramConversation'

export const companyConditionFields = [
  { key: 'region', label: '현재 소재지' },
  { key: 'industry', label: '업종' },
  { key: 'establishedOn', label: '설립일' },
  { key: 'foundedYear', label: '설립연도' },
  { key: 'supportPurpose', label: '지원 목적' },
] as const

export type ChatConversationProposal = {
  kind: 'ready'
  query: string | null
  acceptingOnly: boolean
  changes: { label: string; after: string | null }[]
  hasRetainedConditions: boolean
  appliedConditions: { label: string; value: string }[]
  canConfirm: boolean
  hasUnsentMessage: boolean
} | {
  kind: 'clarification'
  question: string | null
}

type ProposalSource = {
  isBusy: boolean
  confirmedContext: SupportProgramConversationContext
  interpretation: {
    request?: { context: SupportProgramConversationContext }
    result?: SupportProgramInterpretation
  }
  pendingClarification: SupportProgramPendingClarification | null
  canSearch: boolean
  hasUnsentMessage: boolean
}

/** 확정 상태는 바꾸지 않고, 현재 표시할 제안과 조건 차이만 계산합니다. */
export function createChatConversationProposal({
  isBusy, confirmedContext, interpretation, pendingClarification, canSearch, hasUnsentMessage,
}: ProposalSource): ChatConversationProposal | null {
  if (isBusy) return null

  const result = interpretation.result
  if (result?.status === 'ANSWERED') return null
  if (!result) {
    return pendingClarification ? { kind: 'clarification', question: pendingClarification.question } : null
  }
  if (result.status === 'CLARIFICATION_REQUIRED') {
    return { kind: 'clarification', question: result.clarificationQuestion }
  }

  // 비교 기준은 현재 폼이 아니라 해석 요청 당시의 확정 조건입니다.
  const current = interpretation.request?.context ?? confirmedContext
  const proposed = result.proposedContext
  const changes = [
    ...companyConditionFields.map((field) => ({ label: field.label,
      before: current.companyConditions[field.key] == null ? null : String(current.companyConditions[field.key]),
      after: proposed.companyConditions[field.key] == null ? null : String(proposed.companyConditions[field.key]) })),
    { label: '접수 상태', before: current.acceptingOnly ? '접수 중만' : '전체', after: proposed.acceptingOnly ? '접수 중만' : '전체' },
  ].filter((row) => row.before !== row.after).map(({ label, after }) => ({ label, after }))
  const hasRetainedConditions = companyConditionFields.some((field) => (
    current.companyConditions[field.key] != null
    && current.companyConditions[field.key] === proposed.companyConditions[field.key]
  )) || (!proposed.acceptingOnly && current.acceptingOnly === proposed.acceptingOnly)
  const appliedConditions = companyConditionFields.flatMap((field) => {
    const value = proposed.companyConditions[field.key]
    return value == null ? [] : [{ label: field.label, value: String(value) }]
  })

  return { kind: 'ready', query: proposed.query, acceptingOnly: proposed.acceptingOnly,
    changes, hasRetainedConditions, appliedConditions, canConfirm: canSearch && !hasUnsentMessage, hasUnsentMessage }
}
