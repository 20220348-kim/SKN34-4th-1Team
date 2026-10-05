import type { ApplicationPreparation, ApplicationPreparationSummary } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { CombinationReview, RunSummary } from '@govbiz/shared/domain/entities/CombinationReview'
import { unknownParticipation } from '@govbiz/shared/domain/entities/CombinationReview'
import type { SupportProgramDetail } from '@govbiz/shared/domain/entities/SupportProgram'

const time = '2026-09-30T10:00:00+09:00'
export const preparation: ApplicationPreparationSummary = {
  id: 9, sourceCode: 'BIZINFO', sourceProgramId: 'P/123', inputRevision: 1, progressRevision: 1,
  progressStage: 'PREPARING', progressStageUpdatedAt: time, serviceField: 'GENERAL', programTitle: '테스트 지원사업',
  formTitle: '사업계획서', updatedAt: time, answeredRequired: 1, requiredTotal: 3, hasCurrentDocument: false,
}
export const preparationDetail: ApplicationPreparation = {
  id: 9, inputRevision: 1, progressRevision: 1, progressStage: 'PREPARING', progressStageUpdatedAt: time,
  serviceField: 'GENERAL', createdAt: time, updatedAt: time, contents: [],
  form: { formVersionId: 'form-v1', sourceCode: 'BIZINFO', sourceProgramId: 'P/123', programTitle: '테스트 지원사업',
    formTitle: '사업계획서', sourceUrl: 'https://www.bizinfo.go.kr/program', attachmentFileName: 'form.docx',
    attachmentSha256: 'a'.repeat(64), verificationStatus: 'SOURCE_DOCUMENT_EXTRACTED', institutionReviewed: false,
    supportedServiceFields: ['GENERAL'], sections: [{ key: 'general', title: '기업 소개', locator: 'section1', description: '기업 소개 입력',
      status: 'NOT_STARTED', fields: [{ key: 'name', label: '기업명', guidance: '기업명을 입력하세요', required: true }], facts: [] }] },
}
export const review: CombinationReview = {
  id: 5, title: '동시 신청 검토', inputRevision: 1, createdAt: time, updatedAt: time,
  programs: ['P/123', 'P/999'].map((sourceProgramId) => ({ sourceCode: 'BIZINFO', sourceProgramId, subProgramId: null, participation: unknownParticipation() })),
}
export const run: RunSummary = { id: 6, inputRevision: 1, status: 'SUCCEEDED', failureCode: null, startedAt: time, finishedAt: time }
export const programDetail: SupportProgramDetail = {
  sourceCode: 'BIZINFO', id: 'P/123', title: '테스트 지원사업', organization: '기관', summary: '사업 내용', categories: [], regions: [],
  targetDescription: '중소기업', applicationPeriod: '상시', applicationStartDate: null, applicationEndDate: null, status: 'OPEN',
  sourceName: '기업마당', sourceUrl: 'https://www.bizinfo.go.kr/program', evidenceQuestionSupported: true,
  applicationRoute: { method: null, url: null, type: 'UNKNOWN' },
  contact: null, preferenceDescription: null, supervisingInstitutionType: null,
}
