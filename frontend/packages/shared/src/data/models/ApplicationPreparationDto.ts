import { z } from 'zod'
import { applicationProgressStages, applicationServiceFields } from '../../domain/entities/ApplicationPreparation'
import { isOfficialSupportProgramSourceUrl } from './SupportProgramDto'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const time = z.string().datetime({ offset: true })
const serviceField = z.enum(applicationServiceFields)
const progressStage = z.enum(applicationProgressStages)
const field = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(100),
  guidance: z.string().min(1).max(500),
  required: z.boolean(),
  documentWritable: z.boolean().optional(),
  options: z.array(z.string().min(1).max(100)).max(30).refine((values) => values.length !== 1 && new Set(values).size === values.length).optional(),
})
const factStatus = z.enum(['PROVIDED', 'UNKNOWN'])
const fact = z.object({
  id,
  fieldKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  status: factStatus,
  value: z.string().min(1).max(2000).nullable(),
  sourceText: z.string().min(1).max(4000),
  inputRevision: id,
  updatedAt: time,
}).superRefine((value, context) => {
  if ((value.status === 'PROVIDED') !== (value.value !== null)) context.addIssue({ code: 'custom', message: '사실 상태와 값이 일치하지 않습니다.' })
})
const section = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(100),
  locator: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'INPUT_CONFIRMED']),
  fields: z.array(field).min(1).max(20),
  facts: z.array(fact).max(20),
}).superRefine((value, context) => {
  const keys = new Set(value.fields.map(({ key }) => key))
  if (keys.size !== value.fields.length || value.facts.some(({ fieldKey }) => !keys.has(fieldKey))) {
    context.addIssue({ code: 'custom', message: '작성 항목과 확인 사실이 일치하지 않습니다.' })
  }
})

export const applicationFormSchema = z.object({
  formVersionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),
  sourceCode: z.string().min(1).max(64),
  sourceProgramId: z.string().min(1).max(255),
  programTitle: z.string().min(1).max(300),
  formTitle: z.string().min(1).max(300),
  sourceUrl: z.string().url().refine((value) => value.startsWith('https://')),
  attachmentFileName: z.string().min(1).max(500),
  attachmentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  verificationStatus: z.enum(['SOURCE_HASH_AND_LOCATORS_VERIFIED', 'SOURCE_DOCUMENT_EXTRACTED']),
  institutionReviewed: z.literal(false),
  supportedServiceFields: z.array(serviceField).min(1).max(4).refine((fields) => new Set(fields).size === fields.length),
  sections: z.array(section).min(1),
}).refine((form) => new Set(form.sections.map(({ key }) => key)).size === form.sections.length, {
  message: '작성 항목 식별자가 중복되었습니다.',
})

export const supportedApplicationFormsSchema = z.object({
  items: z.array(applicationFormSchema).min(1).refine(
    (forms) => new Set(forms.map(({ formVersionId }) => formVersionId)).size === forms.length,
    { message: '양식 버전 식별자가 중복되었습니다.' },
  ),
})
export const discoveredApplicationFormsSchema = z.object({
  items: z.array(applicationFormSchema).min(1).max(4).refine(
    (forms) => new Set(forms.map(({ formVersionId }) => formVersionId)).size === forms.length,
    { message: '발견한 양식 버전 식별자가 중복되었습니다.' },
  ),
  warnings: z.array(z.string().min(1).max(500)).max(20),
  cached: z.boolean(),
})
export const applicationPreparationSummarySchema = z.object({
  id,
  inputRevision: id,
  progressStage,
  progressRevision: id,
  progressStageUpdatedAt: time,
  sourceCode: z.string().min(1).max(64),
  sourceProgramId: z.string().min(1).max(255),
  serviceField,
  programTitle: z.string().min(1),
  formTitle: z.string().min(1),
  updatedAt: time,
})

export const applicationFormDiscoveryJobSchema = z.object({
  id,
  sourceCode: z.enum(['BIZINFO', 'KSTARTUP', 'MSIT', 'CNTRADE_NOTICE']),
  sourceProgramId: z.string().min(1).max(255),
  programTitle: z.string().min(1).max(500),
  programSourceUrl: z.string().url().nullable(),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN']),
  result: discoveredApplicationFormsSchema.nullable(),
  failureCode: z.string().min(1).max(64).nullable(),
  createdAt: time,
}).superRefine((job, context) => {
  if (job.programSourceUrl !== null && !isOfficialSupportProgramSourceUrl(job.sourceCode, job.programSourceUrl)) {
    context.addIssue({ code: 'custom', path: ['programSourceUrl'], message: '분석 작업의 공식 공고 URL이 올바르지 않습니다.' })
  }
  if ((job.status !== 'SUCCEEDED' && job.result !== null)
    || (job.result !== null && job.result.items.some((form) => form.sourceCode !== job.sourceCode || form.sourceProgramId !== job.sourceProgramId))
    || (['FAILED', 'UNKNOWN'].includes(job.status) !== (job.failureCode !== null))) {
    context.addIssue({ code: 'custom', message: '분석 작업의 상태 또는 공고 식별자가 일치하지 않습니다.' })
  }
})
export const applicationPreparationPageSchema = z.object({
  items: z.array(applicationPreparationSummarySchema).max(50).refine(
    (items) => new Set(items.map(({ id: itemId }) => itemId)).size === items.length,
    { message: '신청 준비 식별자가 중복되었습니다.' },
  ),
  nextBeforeId: id.nullable(),
})
const contentVersion = z.object({
  id,
  sectionKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  inputRevision: id,
  kind: z.enum(['AI_DRAFT', 'USER_EDIT']),
  content: z.string().min(1).max(15000),
  stale: z.boolean(),
  createdAt: time,
  confirmedAt: time.nullable(),
})
export const applicationPreparationSchema = z.object({
  id,
  inputRevision: id,
  progressStage,
  progressRevision: id,
  progressStageUpdatedAt: time,
  serviceField,
  createdAt: time,
  updatedAt: time,
  form: applicationFormSchema,
  contents: z.array(contentVersion),
}).superRefine((value, context) => {
  const sections = new Set(value.form.sections.map((section) => section.key))
  if (new Set(value.contents.map((version) => version.id)).size !== value.contents.length || value.contents.some((version) => !sections.has(version.sectionKey) || version.inputRevision > value.inputRevision)) {
    context.addIssue({ code: 'custom', message: '작성본과 현재 신청 준비가 일치하지 않습니다.' })
  }
  if (!value.form.supportedServiceFields.includes(value.serviceField)) {
    context.addIssue({ code: 'custom', message: '지원 분야와 양식 계약이 일치하지 않습니다.' })
  }
})
export const applicationPreparationProblemSchema = z.object({ code: z.string() })

export const applicationInterpretationSchema = z.object({
  runId: id,
  inputRevision: id,
  sectionKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  suggestions: z.array(z.object({
    fieldKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    status: factStatus,
    value: z.string().min(1).max(2000).nullable(),
    evidenceQuote: z.string().min(1).max(1000),
  }).superRefine((value, context) => {
    if ((value.status === 'PROVIDED') !== (value.value !== null)) context.addIssue({ code: 'custom', message: '제안 상태와 값이 일치하지 않습니다.' })
  })).max(20),
  missingFields: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(20),
  nextQuestion: z.string().min(1).max(300).nullable(),
})
