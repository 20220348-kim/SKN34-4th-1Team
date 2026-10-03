export const applicationServiceFields = ['GENERAL', 'CONSULTING', 'TECHNICAL_SUPPORT', 'MARKETING'] as const
export type ApplicationServiceField = typeof applicationServiceFields[number]

export const applicationProgressStages = ['PREPARING', 'APPLIED', 'DOCUMENT_REVIEW', 'PRESENTATION_REVIEW', 'SELECTED', 'REJECTED'] as const
export type ApplicationProgressStage = typeof applicationProgressStages[number]

export const applicationServiceFieldLabels: Record<ApplicationServiceField, string> = {
  GENERAL: '일반 신청',
  CONSULTING: '컨설팅',
  TECHNICAL_SUPPORT: '기술지원',
  MARKETING: '마케팅',
}

export type ApplicationFormSection = {
  key: string
  title: string
  locator: string
  description: string
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'INPUT_CONFIRMED'
  fields: ApplicationFormField[]
  facts: ApplicationPreparationFact[]
}

export type ApplicationFormField = { key: string; label: string; guidance: string; required: boolean; options?: string[]; documentWritable?: boolean }
export type ApplicationFactStatus = 'PROVIDED' | 'UNKNOWN'
export type ApplicationPreparationFact = {
  id: number
  fieldKey: string
  status: ApplicationFactStatus
  value: string | null
  sourceText: string
  inputRevision: number
  updatedAt: string
}

export type NewApplicationPreparationFact = Omit<ApplicationPreparationFact, 'id' | 'inputRevision' | 'updatedAt'>

export type ApplicationFactSuggestion = {
  fieldKey: string
  status: ApplicationFactStatus
  value: string | null
  evidenceQuote: string
}

export type ApplicationInterpretation = {
  runId: number
  inputRevision: number
  sectionKey: string
  suggestions: ApplicationFactSuggestion[]
  missingFields: string[]
  nextQuestion: string | null
}

export type InterpretApplicationPreparation = {
  expectedRevision: number
  requestKey: string
  message: string
}

export type ReplaceApplicationPreparationInputs = {
  expectedRevision: number
  facts: NewApplicationPreparationFact[]
}

export type ApplicationForm = {
  formVersionId: string
  sourceCode: string
  sourceProgramId: string
  programTitle: string
  formTitle: string
  sourceUrl: string
  attachmentFileName: string
  attachmentSha256: string
  verificationStatus: 'SOURCE_HASH_AND_LOCATORS_VERIFIED' | 'SOURCE_DOCUMENT_EXTRACTED'
  institutionReviewed: false
  supportedServiceFields: ApplicationServiceField[]
  sections: ApplicationFormSection[]
}

export type ApplicationPreparationSummary = {
  id: number
  inputRevision: number
  progressStage: ApplicationProgressStage
  progressRevision: number
  progressStageUpdatedAt: string
  sourceCode: string
  sourceProgramId: string
  serviceField: ApplicationServiceField
  programTitle: string
  formTitle: string
  updatedAt: string
  /** 필수 문항 중 저장된 답변 수. 구 서버 응답에는 없다. */
  answeredRequired?: number
  requiredTotal?: number
  /** 현재 입력 버전으로 만든 문서가 있으면 완료로 본다. */
  hasCurrentDocument?: boolean
  applicationPeriod?: string | null
  /** 공고 접수 마감일(YYYY-MM-DD). 카탈로그에 공고가 없으면 null. */
  applicationEndDate?: string | null
}

export const applicationPreparationListStatuses = ['in_progress', 'done'] as const
export type ApplicationPreparationListStatus = typeof applicationPreparationListStatuses[number]
export type ApplicationPreparationListQuery = { beforeId?: number; status?: ApplicationPreparationListStatus }

/** 접수 마감까지 남은 날. 마감일이 없으면 null, 지났으면 음수. 서울 날짜 기준. */
export function applicationDeadlineDays(applicationEndDate: string | null | undefined, now: Date = new Date()): number | null {
  if (!applicationEndDate) return null
  const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now) + 'T00:00:00Z')
  const end = new Date(applicationEndDate + 'T00:00:00Z')
  if (Number.isNaN(end.getTime())) return null
  return Math.round((end.getTime() - today.getTime()) / 86_400_000)
}

export type ApplicationPreparation = {
  id: number
  inputRevision: number
  progressStage: ApplicationProgressStage
  progressRevision: number
  progressStageUpdatedAt: string
  serviceField: ApplicationServiceField
  createdAt: string
  updatedAt: string
  form: ApplicationForm
  contents: ApplicationContentVersion[]
}

export type ApplicationContentVersion = {
  id: number
  sectionKey: string
  inputRevision: number
  kind: 'AI_DRAFT' | 'USER_EDIT'
  content: string
  stale: boolean
  createdAt: string
  confirmedAt: string | null
}

export type ApplicationDocumentUnfilledAnswer = {
  fieldId: string
  fieldLabel: string
  value: string
  reason: 'INPUT_LOCATION_NOT_FOUND' | 'AUTO_FILL_UNSUPPORTED'
}
export type ApplicationDocument = {
  id: number
  inputRevision: number
  fileName: string
  mediaType: string
  size: number
  filledAnswerCount: number | null
  unfilledAnswerCount: number | null
  unfilledAnswers: ApplicationDocumentUnfilledAnswer[]
}
export type ApplicationDocumentMappingChange = {
  fieldLabel: string
  changeType: 'TARGET_ADDED' | 'TARGET_REMOVED' | 'TARGET_CHANGED' | 'BOX_CHANGED' | 'KIND_CHANGED' | 'SCOPE_CHANGED'
  oldLocation: string | null
  newLocation: string | null
}
export type ApplicationDocumentMigrationNotice = {
  status: 'MAPPING_CHANGED'
  approvalToken: string
  expectedRevision: number
  expiresInSeconds: number
  changes: ApplicationDocumentMappingChange[]
}
export type ApplicationDocumentMigrationConfirmation = {
  status: 'REGENERATION_REQUIRED'
  preparationId: number
  inputRevision: number
  formVersionId: string
}
export type GenerateApplicationDraft = { expectedRevision: number; expectedVersionId: number | null; requestKey: string }
export type ConfirmApplicationContent = { expectedRevision: number; expectedVersionId: number }
export type SaveApplicationContent = ConfirmApplicationContent & { content: string }

export type ApplicationPreparationPage = {
  items: ApplicationPreparationSummary[]
  nextBeforeId: number | null
}

export type NewApplicationPreparation = {
  sourceCode: string
  sourceProgramId: string
  formVersionId: string
  serviceField: ApplicationServiceField
}

export type UpdateApplicationProgress = {
  expectedProgressRevision: number
  progressStage: ApplicationProgressStage
}

export type DiscoveredApplicationForms = {
  items: ApplicationForm[]
  warnings: string[]
  cached: boolean
}

export type ApplicationFormDiscoveryJob = {
  id: number
  sourceCode: string
  sourceProgramId: string
  programTitle: string
  programSourceUrl: string | null
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'
  result: DiscoveredApplicationForms | null
  failureCode: string | null
  createdAt: string
  /** 끝난 결과를 사용자가 확인했는지입니다. 이 값을 주지 않는 서버 응답에는 없습니다. */
  seen?: boolean
}

export function validateNewApplicationPreparation(input: NewApplicationPreparation): NewApplicationPreparation {
  if (!input.sourceCode || !input.sourceProgramId || !/^[a-z0-9][a-z0-9-]{0,159}$/.test(input.formVersionId)) {
    throw new Error('지원 공고와 공식 양식을 다시 선택해 주세요.')
  }
  if (!applicationServiceFields.includes(input.serviceField)) throw new Error('작성할 지원 분야를 선택해 주세요.')
  return { ...input }
}

export type ApplicationFormAvailability = {
  state: {
    sourceCode: string; sourceProgramId: string;
    status: 'PENDING' | 'AVAILABLE' | 'NO_FORM' | 'DOCUMENT_UNAVAILABLE' | 'TOO_LARGE' | 'RETRY_WAITING' | 'STALE' | 'REVIEW_REQUIRED';
    reasonCode: string; nextRetryAt: string | null; attemptCount: number;
  };
  forms: { items: ApplicationForm[] };
}

/** 문서 생성 작업. 접수 즉시 돌아오고, 결과 파일은 SUCCEEDED 뒤 문서 목록 API로 읽습니다. */
export type ApplicationDocumentGenerationJob = {
  id: number
  preparationId: number
  expectedRevision: number
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'
  stage: 'PREPARING' | 'MAPPING' | 'WRITING' | 'SAVING' | null
  fileIds: number[]
  failureCode: string | null
  failureMessage: string | null
  mappingMigration: ApplicationDocumentMigrationNotice | null
  createdAt: string
  finishedAt: string | null
  /** 끝난 결과를 사용자가 확인했는지입니다. 이 값을 주지 않는 서버 응답에는 없습니다. */
  seen?: boolean
}
