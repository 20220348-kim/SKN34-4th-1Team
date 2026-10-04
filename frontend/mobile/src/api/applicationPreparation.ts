import { z } from 'zod'
import * as Crypto from 'expo-crypto'
import { ApplicationPreparationUseCase } from '@govbiz/shared/domain/usecases/ApplicationPreparationUseCase'
import type { ApplicationPreparationRepository, ReplaceApplicationPreparationInputsOptions } from '@govbiz/shared/domain/repositories/ApplicationPreparationRepository'
import type { ApplicationPreparationListQuery, NewApplicationPreparation, InterpretApplicationPreparation, ReplaceApplicationPreparationInputs,
  GenerateApplicationDraft, SaveApplicationContent, ConfirmApplicationContent, UpdateApplicationProgress } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationPreparationSchema, applicationPreparationPageSchema, applicationFormAvailabilitySchema, supportedApplicationFormsSchema,
  applicationFormDiscoveryJobSchema, applicationDocumentGenerationJobSchema, applicationPreparationProblemSchema,
  applicationInterpretationSchema } from '@govbiz/shared/data/models/ApplicationPreparationDto'
import { applicationDocumentsSchema, applicationDocumentMigrationConfirmationSchema } from '@govbiz/shared/data/models/ApplicationDocumentDto'
import { applicationOnlineInputGuideSchema } from '@govbiz/shared/data/models/ApplicationOnlineInputGuideDto'
import { applicationGoogleFormSchema } from '@govbiz/shared/data/models/ApplicationGoogleFormDto'
import { ApiError, createApiFetch, getApiBaseUrl } from './client'
import { clearPendingPreparationIfUnchanged, type PendingPreparationRequest } from '../auth/preparationPending'

const base = '/api/v1/application-preparations'

export async function applicationRequest<T>(token: string, path: string, schema: z.ZodType<T>, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, path.includes('mapping-migration') ? 90_000 : path.endsWith('/messages') ? 45_000 : 15_000)
  try {
    const response = await createApiFetch(token)(`${getApiBaseUrl()}${base}${path}`, { method, cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const problem = applicationPreparationProblemSchema.safeParse(await response.json().catch(() => null))
      const code = problem.success ? problem.data.code : response.status === 404 ? 'APPLICATION_PREPARATION_API_UNAVAILABLE' : 'REQUEST_FAILED'
      throw new ApplicationPreparationError(response.status, code, problem.success ? problem.data.mappingMigration ?? null : null)
    }
    const parsed = schema.safeParse(response.status === 204 ? undefined : await response.json().catch(() => null))
    if (!parsed.success) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return parsed.data
  } catch (cause) {
    if (signal?.aborted || cause instanceof ApplicationPreparationError) throw cause
    if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 401) throw new ApplicationPreparationError(401, 'AUTHENTICATION_REQUIRED')
    throw new ApplicationPreparationError(timedOut ? 504 : 0, timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

async function readBinary(token: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await createApiFetch(token)(`${getApiBaseUrl()}${base}${path}`, { headers: { Accept: '*/*' }, signal, cache: 'no-store' })
  if (!response.ok) {
    const problem = applicationPreparationProblemSchema.safeParse(await response.json().catch(() => null))
    throw new ApplicationPreparationError(response.status, problem.success ? problem.data.code : 'REQUEST_FAILED')
  }
  const type = response.headers.get('content-type')?.split(';')[0]
  if (!type || !['application/pdf', 'application/x-hwp', 'application/hwp+zip', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(type)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
  const blob = await response.blob()
  if (!blob.size || blob.size > 32 * 1024 * 1024) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
  return blob
}
async function binary(token: string, path: string, signal?: AbortSignal): Promise<Blob> {
  try { return await readBinary(token, path, signal) }
  catch (cause) {
    if (signal?.aborted || cause instanceof ApplicationPreparationError) throw cause
    if (cause instanceof ApiError) throw new ApplicationPreparationError(cause.status, cause.code ?? 'REQUEST_FAILED')
    throw new ApplicationPreparationError(0, 'REQUEST_FAILED')
  }
}

class MobileApplicationPreparationRepository implements ApplicationPreparationRepository {
  constructor(private readonly token: string) {}
  private request<T>(path: string, schema: z.ZodType<T>, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown, signal?: AbortSignal) {
    return applicationRequest(this.token, path, schema, method, body, signal)
  }
  async availability(sourceCode: string, sourceProgramId: string, signal?: AbortSignal) {
    const result = await this.request(`/forms/availability?${new URLSearchParams({ sourceCode, sourceProgramId })}`, applicationFormAvailabilitySchema, 'GET', undefined, signal)
    if (result.state.sourceCode !== sourceCode || result.state.sourceProgramId !== sourceProgramId ||
      (result.state.status === 'AVAILABLE') !== (result.forms.items.length > 0) ||
      new Set(result.forms.items.map(form => form.formVersionId)).size !== result.forms.items.length ||
      result.forms.items.some(form => form.sourceCode !== sourceCode || form.sourceProgramId !== sourceProgramId)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async forms(signal?: AbortSignal) { return (await this.request('/forms', supportedApplicationFormsSchema, 'GET', undefined, signal)).items }
  googleForm(sourceCode: string, sourceProgramId: string, signal?: AbortSignal) {
    return this.request(`/google-form?${new URLSearchParams({ sourceCode, sourceProgramId })}`, applicationGoogleFormSchema, 'GET', undefined, signal)
  }
  list(query: ApplicationPreparationListQuery = {}, signal?: AbortSignal) {
    const params = new URLSearchParams({ size: '20', ...(query.status ? { status: query.status } : {}), ...(query.beforeId ? { beforeId: String(query.beforeId) } : {}) })
    return this.request(`?${params}`, applicationPreparationPageSchema, 'GET', undefined, signal)
  }
  delete(id: number, signal?: AbortSignal) { return this.request(`/${id}`, z.undefined(), 'DELETE', undefined, signal) }
  async get(id: number, signal?: AbortSignal) {
    const result = await this.request(`/${id}`, applicationPreparationSchema, 'GET', undefined, signal)
    if (result.id !== id) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async create(input: NewApplicationPreparation, signal?: AbortSignal) {
    const result = await this.request('', applicationPreparationSchema, 'POST', input, signal)
    if (result.form.sourceCode !== input.sourceCode || result.form.sourceProgramId !== input.sourceProgramId || result.form.formVersionId !== input.formVersionId || result.serviceField !== input.serviceField) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async replaceInputs(id: number, sectionKey: string, input: ReplaceApplicationPreparationInputs, signal?: AbortSignal, _options?: ReplaceApplicationPreparationInputsOptions) {
    const result = await this.request(`/${id}/sections/${encodeURIComponent(sectionKey)}/inputs`, applicationPreparationSchema, 'PUT', input, signal)
    if (result.id !== id || result.inputRevision !== input.expectedRevision + 1) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async interpret(id: number, sectionKey: string, input: InterpretApplicationPreparation, signal?: AbortSignal) {
    const result = await this.request(`/${id}/sections/${encodeURIComponent(sectionKey)}/messages`, applicationInterpretationSchema, 'POST', input, signal)
    if (result.inputRevision !== input.expectedRevision || result.sectionKey !== sectionKey) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  generateDraft(id: number, sectionKey: string, input: GenerateApplicationDraft, signal?: AbortSignal) { return this.request(`/${id}/sections/${encodeURIComponent(sectionKey)}/drafts`, applicationPreparationSchema, 'POST', input, signal) }
  saveContent(id: number, sectionKey: string, input: SaveApplicationContent, signal?: AbortSignal) { return this.request(`/${id}/sections/${encodeURIComponent(sectionKey)}/content`, applicationPreparationSchema, 'PUT', input, signal) }
  confirmContent(id: number, sectionKey: string, input: ConfirmApplicationContent, signal?: AbortSignal) { return this.request(`/${id}/sections/${encodeURIComponent(sectionKey)}/confirmations`, applicationPreparationSchema, 'POST', input, signal) }
  async updateProgress(id: number, input: UpdateApplicationProgress, signal?: AbortSignal) {
    const result = await this.request(`/${id}/progress-stage`, applicationPreparationSchema, 'PUT', input, signal)
    if (result.id !== id || result.progressRevision !== input.expectedProgressRevision + 1 || result.progressStage !== input.progressStage) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async discover(sourceCode: string, sourceProgramId: string, signal?: AbortSignal, requestKey = Crypto.randomUUID()) {
    const result = await this.request('/forms/discovery-jobs', applicationFormDiscoveryJobSchema, 'POST', { sourceCode, sourceProgramId, requestKey }, signal)
    if (result.sourceCode !== sourceCode || result.sourceProgramId !== sourceProgramId) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async discoveryJob(id: number, signal?: AbortSignal) {
    const result = await this.request(`/forms/discovery-jobs/${id}`, applicationFormDiscoveryJobSchema, 'GET', undefined, signal)
    if (result.id !== id) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  discoveryJobs(signal?: AbortSignal) { return this.request('/forms/discovery-jobs', z.array(applicationFormDiscoveryJobSchema).max(20), 'GET', undefined, signal) }
  documents(id: number, signal?: AbortSignal) { return this.request(`/${id}/documents`, applicationDocumentsSchema, 'GET', undefined, signal) }
  async submitDocumentJob(id: number, expectedRevision: number, signal?: AbortSignal, requestKey = Crypto.randomUUID()) {
    const result = await this.request(`/${id}/documents/jobs`, applicationDocumentGenerationJobSchema, 'POST', { expectedRevision, requestKey }, signal)
    if (result.preparationId !== id || result.expectedRevision !== expectedRevision) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async documentJob(id: number, jobId: number, signal?: AbortSignal) {
    const result = await this.request(`/${id}/documents/jobs/${jobId}`, applicationDocumentGenerationJobSchema, 'GET', undefined, signal)
    if (result.preparationId !== id || result.id !== jobId) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async documentJobs(id: number, signal?: AbortSignal) {
    const result = await this.request(`/${id}/documents/jobs`, z.array(applicationDocumentGenerationJobSchema).max(5), 'GET', undefined, signal)
    if (result.some(job => job.preparationId !== id)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  recentDocumentJobs(signal?: AbortSignal) { return this.request('/documents/jobs', z.array(applicationDocumentGenerationJobSchema).max(20), 'GET', undefined, signal) }
  markDocumentJobsSeen(id: number, signal?: AbortSignal) { return this.request(`/${id}/documents/jobs/seen`, z.undefined(), 'POST', undefined, signal) }
  markDiscoveryJobsSeen(sourceCode: string, sourceProgramId: string, signal?: AbortSignal) { return this.request('/forms/discovery-jobs/seen', z.undefined(), 'POST', { sourceCode, sourceProgramId }, signal) }
  async confirmDocumentMappingMigration(id: number, expectedRevision: number, approvalToken: string, signal?: AbortSignal) {
    const result = await this.request(`/${id}/documents/mapping-migration/confirm`, applicationDocumentMigrationConfirmationSchema, 'POST', { expectedRevision, approvalToken }, signal)
    if (result.preparationId !== id || result.inputRevision !== expectedRevision) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  async onlineInputGuide(id: number, signal?: AbortSignal) {
    const result = await this.request(`/${id}/online-input-guide`, applicationOnlineInputGuideSchema, 'GET', undefined, signal)
    if (result.preparationId !== id) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return result
  }
  downloadDocument(id: number, fileId: number, signal?: AbortSignal) { return binary(this.token, `/${id}/documents/${fileId}/download`, signal) }
  downloadDocumentArchive(id: number, revision: number, signal?: AbortSignal) { return binary(this.token, `/${id}/documents/archive?revision=${revision}`, signal) }
}

export const applicationPreparationUseCase = (token: string) => new ApplicationPreparationUseCase(new MobileApplicationPreparationRepository(token))

/** 정확한 소유 문서 없음 응답만 정리 근거로 사용한다. 조회 장애와 오래된 서버의 404는 유지한다. */
export async function discardDeletedPendingPreparation(token: string, email: string, pending: PendingPreparationRequest, signal?: AbortSignal) {
  if (pending.kind !== 'document') throw new Error('양식 분석 요청은 같은 요청으로 결과를 확인해 주세요.')
  try {
    await applicationPreparationUseCase(token).get(pending.preparationId, signal)
  } catch (cause) {
    if (signal?.aborted || !(cause instanceof ApplicationPreparationError) || cause.status !== 404 || cause.code !== 'APPLICATION_PREPARATION_NOT_FOUND') throw cause
    if (!await clearPendingPreparationIfUnchanged(getApiBaseUrl(), email, pending, signal)) throw new Error('보관 요청이 변경됐어요. 목록에서 현재 요청을 다시 확인해 주세요.')
    return
  }
  throw new Error('요청 대상 문서가 남아 있어요. 같은 요청으로 결과를 먼저 확인해 주세요.')
}
export function parsePreparationId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return null
  return Number(value)
}
