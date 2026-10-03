import { applicationDocumentsSchema, applicationDocumentMigrationConfirmationSchema } from '@govbiz/shared/data/models/ApplicationDocumentDto'
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
import type { ApplicationPreparationRepository, ReplaceApplicationPreparationInputsOptions } from '../../domain/repositories/ApplicationPreparationRepository'
import type { ApplicationPreparationListQuery } from '../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../domain/errors/ApplicationPreparationError'
import { applicationPreparationRequest as request, downloadApplicationDocument, downloadApplicationDocumentArchive } from '../api/applicationPreparationApi'
import {
  applicationPreparationPageSchema,
  applicationPreparationSchema,
  applicationFormAvailabilitySchema,
  supportedApplicationFormsSchema,
  applicationInterpretationSchema,
  applicationFormDiscoveryJobSchema,
  applicationDocumentGenerationJobSchema,
} from '../models/ApplicationPreparationDto'

import { applicationOnlineInputGuideSchema } from '@govbiz/shared/data/models/ApplicationOnlineInputGuideDto'

const cursor = (query: ApplicationPreparationListQuery = {}) =>
  `?size=20${query.beforeId === undefined ? '' : `&beforeId=${query.beforeId}`}${query.status === undefined ? '' : `&status=${query.status}`}`

export class ApplicationPreparationRepositoryImpl implements ApplicationPreparationRepository {
  async onlineInputGuide(id: number, signal?: AbortSignal) {
    const guide = await request(`/${id}/online-input-guide`, applicationOnlineInputGuideSchema, 'GET', undefined, signal, 'preparation')
    if (guide.preparationId !== id) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return guide
  }

  async availability(sourceCode: string, sourceProgramId: string, signal?: AbortSignal) {
    const result = await request(`/forms/availability?${new URLSearchParams({ sourceCode, sourceProgramId })}`, applicationFormAvailabilitySchema, 'GET', undefined, signal)
    if (result.state.sourceCode !== sourceCode || result.state.sourceProgramId !== sourceProgramId ||
        (result.state.status === 'AVAILABLE') !== (result.forms.items.length > 0) ||
        new Set(result.forms.items.map((form) => form.formVersionId)).size !== result.forms.items.length ||
        result.forms.items.some((form) => form.sourceCode !== sourceCode || form.sourceProgramId !== sourceProgramId)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }

  documents(id: number, signal?: AbortSignal) { return request(`/${id}/documents`, applicationDocumentsSchema, 'GET', undefined, signal, 'preparation') }
  async submitDocumentJob(id: number, expectedRevision: number, signal?: AbortSignal, requestKey = crypto.randomUUID()) {
    const job = await request(`/${id}/documents/jobs`, applicationDocumentGenerationJobSchema, 'POST', { requestKey, expectedRevision }, signal, 'preparation')
    if (job.preparationId !== id || job.expectedRevision !== expectedRevision) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return job
  }
  async documentJob(id: number, jobId: number, signal?: AbortSignal) {
    const job = await request(`/${id}/documents/jobs/${jobId}`, applicationDocumentGenerationJobSchema, 'GET', undefined, signal, 'preparation')
    if (job.id !== jobId || job.preparationId !== id) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return job
  }
  documentJobs(id: number, signal?: AbortSignal) {
    return request(`/${id}/documents/jobs`, z.array(applicationDocumentGenerationJobSchema).max(5), 'GET', undefined, signal, 'preparation')
  }
  recentDocumentJobs(signal?: AbortSignal) {
    return request('/documents/jobs', z.array(applicationDocumentGenerationJobSchema).max(20), 'GET', undefined, signal)
  }
  markDocumentJobsSeen(id: number, signal?: AbortSignal) {
    return request(`/${id}/documents/jobs/seen`, z.undefined(), 'POST', undefined, signal, 'preparation')
  }
  markDiscoveryJobsSeen(sourceCode: string, sourceProgramId: string, signal?: AbortSignal) {
    return request('/forms/discovery-jobs/seen', z.undefined(), 'POST', { sourceCode, sourceProgramId }, signal)
  }
  async confirmDocumentMappingMigration(id: number, expectedRevision: number, approvalToken: string, signal?: AbortSignal) {
    const result = await request(`/${id}/documents/mapping-migration/confirm`, applicationDocumentMigrationConfirmationSchema,
      'POST', { expectedRevision, approvalToken }, signal, 'preparation')
    if (result.preparationId !== id || result.inputRevision !== expectedRevision) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  downloadDocument(id: number, fileId: number, signal?: AbortSignal) { return downloadApplicationDocument(id, fileId, signal) }
  downloadDocumentArchive(id: number, revision: number, signal?: AbortSignal) { return downloadApplicationDocumentArchive(id, revision, signal) }
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
  list(query?: ApplicationPreparationListQuery, signal?: AbortSignal) {
    return request(cursor(query), applicationPreparationPageSchema, 'GET', undefined, signal)
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
  async replaceInputs(id: number, sectionKey: string, input: ReplaceApplicationPreparationInputs, signal?: AbortSignal,
    options: ReplaceApplicationPreparationInputsOptions = {}) {
    const result = await request(`/${id}/sections/${encodeURIComponent(sectionKey)}/inputs`, applicationPreparationSchema, 'PUT', input, signal, 'preparation', options)
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
