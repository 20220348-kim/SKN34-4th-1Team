import { z } from 'zod'
import type {
  InterpretApplicationPreparation,
  NewApplicationPreparation,
  ReplaceApplicationPreparationInputs,
  GenerateApplicationDraft,
  SaveApplicationContent,
  ConfirmApplicationContent,
  UpdateApplicationProgress,
} from '../../domain/entities/ApplicationPreparation'
import type { ApplicationPreparationRepository } from '../../domain/repositories/ApplicationPreparationRepository'
import { ApplicationPreparationError } from '../../domain/errors/ApplicationPreparationError'
import { applicationPreparationRequest as request, downloadApplicationDocument } from '../api/applicationPreparationApi'
import {
  applicationPreparationPageSchema,
  applicationPreparationSchema,
  applicationFormSchema,
  supportedApplicationFormsSchema,
  applicationInterpretationSchema,
  applicationFormDiscoveryJobSchema,
} from '../models/ApplicationPreparationDto'

const cursor = (beforeId?: number) => `?size=20${beforeId === undefined ? '' : `&beforeId=${beforeId}`}`
const documentsSchema = z.array(z.object({
  id: z.number().int().positive(), inputRevision: z.number().int().positive(),
  fileName: z.string().min(1).max(500).regex(/^[^\\/]+\.(hwp|hwpx|pdf)$/i).refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32)),
  mediaType: z.enum(['application/pdf', 'application/x-hwp', 'application/hwp+zip']),
  size: z.number().int().positive().max(32 * 1024 * 1024),
  filledAnswerCount: z.number().int().nonnegative().max(200).nullable(),
  unfilledAnswerCount: z.number().int().nonnegative().max(200).nullable(),
  unfilledAnswers: z.array(z.object({
    fieldId: z.string().min(1).max(129), fieldLabel: z.string().min(1).max(210), value: z.string().min(1).max(2000),
    reason: z.enum(['INPUT_LOCATION_NOT_FOUND', 'AUTO_FILL_UNSUPPORTED']),
  })).max(200),
}).superRefine((file, context) => {
  if ((file.filledAnswerCount === null) !== (file.unfilledAnswerCount === null)
    || (file.unfilledAnswerCount !== null && file.unfilledAnswerCount !== file.unfilledAnswers.length)
    || (file.filledAnswerCount === null && file.unfilledAnswers.length > 0)
    || new Set(file.unfilledAnswers.map((answer) => answer.fieldId)).size !== file.unfilledAnswers.length) {
    context.addIssue({ code: 'custom', message: '문서 답변 집계가 일치하지 않습니다.' })
  }
})).max(20)

export class ApplicationPreparationRepositoryImpl implements ApplicationPreparationRepository {
  async availability(sourceCode: string, sourceProgramId: string, signal?: AbortSignal) {
    const schema = z.object({
      state: z.object({ sourceCode: z.string(), sourceProgramId: z.string(),
        status: z.enum(['PENDING', 'AVAILABLE', 'NO_FORM', 'DOCUMENT_UNAVAILABLE', 'TOO_LARGE', 'RETRY_WAITING', 'STALE', 'REVIEW_REQUIRED']),
        reasonCode: z.string(), nextRetryAt: z.string().nullable(), attemptCount: z.number().int().nonnegative(),
      }), forms: z.object({ items: z.array(applicationFormSchema) }),
    })
    const result = await request(`/forms/availability?${new URLSearchParams({ sourceCode, sourceProgramId })}`, schema, 'GET', undefined, signal)
    if (result.state.sourceCode !== sourceCode || result.state.sourceProgramId !== sourceProgramId ||
        (result.state.status === 'AVAILABLE') !== (result.forms.items.length > 0) ||
        new Set(result.forms.items.map((form) => form.formVersionId)).size !== result.forms.items.length ||
        result.forms.items.some((form) => form.sourceCode !== sourceCode || form.sourceProgramId !== sourceProgramId)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }

  documents(id: number, signal?: AbortSignal) { return request(`/${id}/documents`, documentsSchema, 'GET', undefined, signal, 'preparation') }
  async generateDocuments(id: number, expectedRevision: number, signal?: AbortSignal) {
    const files = await request(`/${id}/documents`, documentsSchema, 'POST', { expectedRevision }, signal, 'preparation')
    if (files.length === 0 || files.some((file) => file.inputRevision !== expectedRevision)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return files
  }
  downloadDocument(id: number, fileId: number, signal?: AbortSignal) { return downloadApplicationDocument(id, fileId, signal) }
  async generateDraft(id: number, sectionKey: string, input: GenerateApplicationDraft, signal?: AbortSignal) {
    const result = await request(`/${id}/sections/${encodeURIComponent(sectionKey)}/drafts`, applicationPreparationSchema, 'POST', input, signal, 'preparation')
    if (result.id !== id || !result.contents.some((version) => version.sectionKey === sectionKey)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async saveContent(id: number, sectionKey: string, input: SaveApplicationContent, signal?: AbortSignal) {
    const result = await request(`/${id}/sections/${encodeURIComponent(sectionKey)}/content`, applicationPreparationSchema, 'PUT', input, signal, 'preparation')
    if (result.id !== id || !result.contents.some((version) => version.sectionKey === sectionKey && version.id > input.expectedVersionId && version.content === input.content && version.kind === 'USER_EDIT')) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async confirmContent(id: number, sectionKey: string, input: ConfirmApplicationContent, signal?: AbortSignal) {
    const result = await request(`/${id}/sections/${encodeURIComponent(sectionKey)}/confirmations`, applicationPreparationSchema, 'POST', input, signal, 'preparation')
    if (result.id !== id || !result.contents.some((version) => version.id === input.expectedVersionId && version.sectionKey === sectionKey && version.confirmedAt !== null)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async forms(signal?: AbortSignal) {
    return (await request('/forms', supportedApplicationFormsSchema, 'GET', undefined, signal)).items
  }
  async discover(sourceCode: string, sourceProgramId: string, signal?: AbortSignal, requestKey = crypto.randomUUID()) {
    const job = await request('/forms/discovery-jobs', applicationFormDiscoveryJobSchema, 'POST', { sourceCode, sourceProgramId, requestKey }, signal)
    if (job.sourceCode !== sourceCode || job.sourceProgramId !== sourceProgramId || (job.status === 'SUCCEEDED' && job.result === null)) {
      throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    }
    return job
  }
  async discoveryJob(id: number, signal?: AbortSignal) {
    const job = await request(`/forms/discovery-jobs/${id}`, applicationFormDiscoveryJobSchema, 'GET', undefined, signal)
    if (job.id !== id || (job.status === 'SUCCEEDED' && job.result === null)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return job
  }
  discoveryJobs(signal?: AbortSignal) {
    return request('/forms/discovery-jobs', z.array(applicationFormDiscoveryJobSchema).max(20), 'GET', undefined, signal)
  }
  list(beforeId?: number, signal?: AbortSignal) {
    return request(cursor(beforeId), applicationPreparationPageSchema, 'GET', undefined, signal)
  }
  delete(id: number, signal?: AbortSignal) {
    return request(`/${id}`, z.undefined(), 'DELETE', undefined, signal, 'preparation')
  }
  async get(id: number, signal?: AbortSignal) {
    const result = await request(`/${id}`, applicationPreparationSchema, 'GET', undefined, signal, 'preparation')
    if (result.id !== id) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async create(input: NewApplicationPreparation, signal?: AbortSignal) {
    const result = await request('', applicationPreparationSchema, 'POST', input, signal)
    if (
      result.form.sourceCode !== input.sourceCode ||
      result.form.sourceProgramId !== input.sourceProgramId ||
      result.form.formVersionId !== input.formVersionId ||
      result.serviceField !== input.serviceField
    ) {
      throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    }
    return result
  }
  async interpret(id: number, sectionKey: string, input: InterpretApplicationPreparation, signal?: AbortSignal) {
    const result = await request(`/${id}/sections/${encodeURIComponent(sectionKey)}/messages`, applicationInterpretationSchema, 'POST', input, signal, 'preparation')
    if (result.inputRevision !== input.expectedRevision || result.sectionKey !== sectionKey) {
      throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    }
    return result
  }
  async replaceInputs(id: number, sectionKey: string, input: ReplaceApplicationPreparationInputs, signal?: AbortSignal) {
    const result = await request(`/${id}/sections/${encodeURIComponent(sectionKey)}/inputs`, applicationPreparationSchema, 'PUT', input, signal, 'preparation')
    if (result.id !== id || result.inputRevision !== input.expectedRevision + 1) {
      throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    }
    return result
  }
  async updateProgress(id: number, input: UpdateApplicationProgress, signal?: AbortSignal) {
    const result = await request(`/${id}/progress-stage`, applicationPreparationSchema, 'PUT', input, signal, 'preparation')
    if (result.id !== id || result.progressRevision !== input.expectedProgressRevision + 1 || result.progressStage !== input.progressStage) {
      throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    }
    return result
  }
}
