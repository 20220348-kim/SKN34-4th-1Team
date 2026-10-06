import type { ApplicationDocumentGenerationJob, ApplicationFormField } from './ApplicationPreparation'

/** UNKNOWN으로 저장되는 미정과 비어 있는 답변은 실제 문서 기입 대상이 아닙니다. */
export function isWritableApplicationAnswer(field: Pick<ApplicationFormField, 'documentWritable'>, value: string | null | undefined): boolean {
  const answer = value?.trim() ?? ''
  return field.documentWritable !== false && answer !== '' && answer !== '미정'
}

/** 무응답·미정은 원본 저장, 실제 답변은 기입 대상으로 안내한다. 필수 누락은 생성을 막지 않는다. */
export function applicationDraftMode(answers: ReadonlyArray<{
  field: Pick<ApplicationFormField, 'documentWritable'>; value: string | null | undefined
}>): 'original' | 'writing' | 'manualOnly' {
  let provided = false
  for (const { field, value } of answers) {
    const answer = value?.trim() ?? ''
    if (isWritableApplicationAnswer(field, answer)) return 'writing'
    if (answer !== '' && answer !== '미정') provided = true
  }
  return provided ? 'manualOnly' : 'original'
}

/** 서버 작업 표가 기록하는 단계 순서입니다. 화면은 단계를 추측하지 않고 이 값만 표시합니다. */
export const generationStages = [
  ['PREPARING', '답변 확인'],
  ['MAPPING', '입력칸 위치 찾기'],
  ['WRITING', '입력칸 기입'],
  ['SAVING', '파일 저장'],
] as const

/**
 * 실패 안내 묶음입니다. 다시 시도로 풀리는 일시 오류(temporary)에만 [다시 시도]를 둡니다.
 * formLimit 양식 한계 · reanalysis 양식 재분석 필요 · userFix 답변을 고치면 풀림 · serviceDown 서비스 중단 · outcomeUnknown 결과 확인 중.
 */
export type FailureGroup = 'formLimit' | 'reanalysis' | 'userFix' | 'temporary' | 'serviceDown' | 'outcomeUnknown'

/** 실패 코드(앞의 APPLICATION_DOCUMENT_ 생략) → 묶음입니다. 표에 없는 코드는 일시 오류로 둡니다. */
const failureGroups: Record<string, FailureGroup> = {
  LIMIT_EXCEEDED: 'formLimit', UNSUPPORTED: 'formLimit', UNMAPPED_INPUT: 'formLimit',
  // 기입할 칸이 원래 없어 재분석으로 풀릴 가능성이 낮습니다. 유료 재분석 대신 원본에 직접 작성하게 합니다.
  NO_WRITABLE_INPUT: 'formLimit',
  MAPPING_FAILED: 'reanalysis', SOURCE_CHANGED: 'reanalysis', FORM_REANALYSIS_REQUIRED: 'reanalysis',
  INPUT_REQUIRED: 'userFix', OVERFLOW: 'userFix', APPLICATION_PREPARATION_REVISION_CONFLICT: 'userFix',
  MCP_NOT_READY: 'serviceDown',
  OUTCOME_UNKNOWN: 'outcomeUnknown', RUN_OUTCOME_UNKNOWN: 'outcomeUnknown',
}

/** 실패 안내의 제목입니다. 결과 화면의 실패 카드와 목록 카드가 같은 문구를 씁니다. */
export function generationFailureTitle(job: ApplicationDocumentGenerationJob): string {
  const code = failureCodeOf(job)
  switch (failureGroupOf(job)) {
    case 'formLimit': return '이 양식은 자동으로 채우기 어려워요'
    case 'reanalysis': return '양식을 다시 분석해야 해요'
    case 'userFix': return code === 'INPUT_REQUIRED' ? '답변을 확인한 뒤 다시 만들어 주세요' : code === 'OVERFLOW' ? '답변이 입력칸보다 길어요' : '답변이 바뀌었어요'
    case 'serviceDown': return '지금은 초안 만들기를 쓸 수 없어요'
    case 'outcomeUnknown': return '초안 결과를 확인하고 있어요'
    default: return '일시적인 문제로 초안을 만들지 못했어요'
  }
}

export function failureCodeOf(job: ApplicationDocumentGenerationJob) {
  return (job.failureCode ?? '').replace(/^APPLICATION_DOCUMENT_/, '')
}

export function failureGroupOf(job: ApplicationDocumentGenerationJob): FailureGroup {
  if (job.status === 'UNKNOWN') return 'outcomeUnknown'
  return failureGroups[failureCodeOf(job)] ?? 'temporary'
}
