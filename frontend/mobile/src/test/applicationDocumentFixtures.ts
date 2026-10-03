import type { ApplicationForm, ApplicationPreparation, ApplicationPreparationSummary, ApplicationDocument, ApplicationDocumentGenerationJob, ApplicationFormDiscoveryJob } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
export const documentTime = '2026-10-03T10:00:00+09:00'
export const documentProgram: SupportProgram = {
  id: 'PBLN_123', sourceCode: 'BIZINFO', title: '테스트 신청 지원사업', organization: '테스트 기관', summary: '단위 테스트용 공고', categories: ['기술'], regions: ['서울'],
  targetDescription: '기업', applicationPeriod: '상시 접수', applicationStartDate: null, applicationEndDate: null, status: 'OPEN', sourceName: '기업마당',
  sourceUrl: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_123', matchedReasons: [], recommendationScore: null, eligibilityReview: null,
}
export const documentForm: ApplicationForm = {
  formVersionId: 'test-form-v1', sourceCode: 'BIZINFO', sourceProgramId: documentProgram.id, programTitle: documentProgram.title, formTitle: '사업계획서', sourceUrl: documentProgram.sourceUrl,
  attachmentFileName: '사업계획서.hwpx', attachmentSha256: 'a'.repeat(64), verificationStatus: 'SOURCE_DOCUMENT_EXTRACTED', institutionReviewed: false, supportedServiceFields: ['GENERAL'],
  sections: [{ key: 'company', title: '기업 소개', locator: '표 1', description: '기업 정보', status: 'INPUT_CONFIRMED', fields: [
    { key: 'name', label: '기업명', guidance: '기업명을 알려주세요.', required: true }, { key: 'goal', label: '추진 목표', guidance: '추진 목표를 알려주세요.', required: true },
  ], facts: [
    { id: 1, fieldKey: 'name', status: 'PROVIDED', value: '테스트 기업', sourceText: '기업명: 테스트 기업', inputRevision: 1, updatedAt: documentTime },
    { id: 2, fieldKey: 'goal', status: 'PROVIDED', value: '생산 개선', sourceText: '추진 목표: 생산 개선', inputRevision: 1, updatedAt: documentTime },
  ] }],
}
export const documentPreparation: ApplicationPreparation = {
  id: 9, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: documentTime, serviceField: 'GENERAL', createdAt: documentTime, updatedAt: documentTime, form: documentForm, contents: [],
}
export const documentSummary: ApplicationPreparationSummary = {
  id: 9, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: documentTime, serviceField: 'GENERAL', sourceCode: 'BIZINFO', sourceProgramId: documentProgram.id,
  programTitle: documentProgram.title, formTitle: documentForm.formTitle, updatedAt: documentTime, requiredTotal: 2, answeredRequired: 2, hasCurrentDocument: false,
}
export const documentFile: ApplicationDocument = { id: 11, inputRevision: 1, fileName: '사업계획서.hwpx', mediaType: 'application/hwp+zip', size: 4, filledAnswerCount: 2, unfilledAnswerCount: 0, unfilledAnswers: [] }
export const documentJob: ApplicationDocumentGenerationJob = {
  id: 10, preparationId: 9, expectedRevision: 1, status: 'SUCCEEDED', stage: 'SAVING', fileIds: [11], failureCode: null, failureMessage: null, mappingMigration: null, createdAt: documentTime, finishedAt: documentTime, seen: false,
}
export const discoveryJob: ApplicationFormDiscoveryJob = { id: 12, sourceCode: 'BIZINFO', sourceProgramId: documentProgram.id, programTitle: documentProgram.title, programSourceUrl: documentProgram.sourceUrl,
  status: 'SUCCEEDED', result: { items: [documentForm], warnings: [], cached: false }, failureCode: null, createdAt: documentTime, seen: false,
}
