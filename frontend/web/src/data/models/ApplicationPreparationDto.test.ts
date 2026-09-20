import { describe, expect, it } from 'vitest'
import {
  applicationPreparationPageSchema,
  applicationPreparationSchema,
  supportedApplicationFormsSchema,
} from './ApplicationPreparationDto'

const form = {
  formVersionId: 'verified-form-v1',
  sourceCode: 'BIZINFO',
  sourceProgramId: 'PBLN_1',
  programTitle: '지원사업',
  formTitle: '사업계획서',
  sourceUrl: 'https://www.bizinfo.go.kr/form',
  attachmentFileName: '사업계획서.hwpx',
  attachmentSha256: 'a'.repeat(64),
  verificationStatus: 'SOURCE_HASH_AND_LOCATORS_VERIFIED',
  institutionReviewed: false,
  supportedServiceFields: ['CONSULTING', 'TECHNICAL_SUPPORT'],
  sections: [{
    key: 'company-overview', title: '기업 개요', locator: '문단 1', description: '기업을 설명합니다.', status: 'NOT_STARTED',
    fields: [{ key: 'company-name', label: '업체명', guidance: '업체명을 입력합니다.', required: true }], facts: [],
  }],
}
const detail = {
  contents: [],
  id: 1,
  inputRevision: 1,
  progressStage: 'PREPARING',
  progressRevision: 1,
  progressStageUpdatedAt: '2026-09-11T00:00:00+09:00',
  serviceField: 'TECHNICAL_SUPPORT',
  createdAt: '2026-09-11T00:00:00+09:00',
  updatedAt: '2026-09-11T00:00:00+09:00',
  form,
}

describe('application preparation DTO schemas', () => {
  it('accepts the planned forms, list and detail contracts', () => {
    expect(supportedApplicationFormsSchema.safeParse({ items: [form] }).success).toBe(true)
    expect(applicationPreparationPageSchema.safeParse({
      items: [{ id: 1, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
        sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', serviceField: 'CONSULTING', programTitle: '지원사업', formTitle: '양식', updatedAt: detail.updatedAt }],
      nextBeforeId: 1,
    }).success).toBe(true)
    expect(applicationPreparationSchema.safeParse(detail).success).toBe(true)
  })

  it.each([
    [{ ...form, sourceUrl: 'http://unsafe.example/form' }],
    [{ ...form, supportedServiceFields: ['CONSULTING', 'CONSULTING'] }],
    [{ ...form, sections: [form.sections[0], form.sections[0]] }],
    [{ ...form, institutionReviewed: true }],
  ])('rejects malformed or unsupported form metadata', (invalidForm) => {
    expect(supportedApplicationFormsSchema.safeParse({ items: [invalidForm] }).success).toBe(false)
  })

  it('rejects duplicate form and page ids and a detail field unsupported by its form', () => {
    expect(supportedApplicationFormsSchema.safeParse({ items: [form, form] }).success).toBe(false)
    const summary = { id: 1, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
      sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', serviceField: 'CONSULTING', programTitle: '지원사업', formTitle: '양식', updatedAt: detail.updatedAt }
    expect(applicationPreparationPageSchema.safeParse({ items: [summary, summary], nextBeforeId: null }).success).toBe(false)
    expect(applicationPreparationSchema.safeParse({ ...detail, serviceField: 'MARKETING' }).success).toBe(false)
  })
})
