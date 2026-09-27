export type ApplicationOnlineInputGuide = {
  preparationId: number
  inputRevision: number
  totalCount: number
  readyCount: number
  needsReviewCount: number
  missingCount: number
  directInputCount: number
  externalMappingVerified: boolean
  officialApplicationUrl: string | null
  items: { fieldId: string; label: string; required: boolean; status: 'READY' | 'NEEDS_REVIEW' | 'MISSING' | 'DIRECT_INPUT'; answer: string | null; inputMode: 'UNKNOWN'; options: string[]; copyable: boolean }[]
  savedAnswers: { fieldId: string; label: string; answer: string }[]
}

/** 저장 Fact 내보내기이며 외부 입력 타입/매핑 검토 완료를 뜻하지 않는다. */
export function formatSavedApplicationAnswers(guide: ApplicationOnlineInputGuide): string {
  return guide.savedAnswers.map(({ label, answer }) => `Q. ${label}\nA. ${answer}`).join('\n\n')
}
