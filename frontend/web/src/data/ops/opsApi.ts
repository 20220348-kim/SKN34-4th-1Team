import { z } from 'zod'

const base = '/api/v1/ops'
const liveConfigSchema = z.object({
  model: z.string(), fixture_sha256: z.string(), max_model_calls: z.number().int().positive(), max_output_tokens: z.number().int().positive(),
})
const sessionSchema = z.object({
  user: z.object({ id: z.string(), username: z.string() }).nullable(),
  csrf_token: z.string(),
  live_enabled: z.boolean(),
  datasets: z.array(z.object({
    id: z.string(), label: z.string(), case_ids: z.array(z.string()).min(1),
    captures: z.array(z.object({ id: z.string(), label: z.string() })).min(1),
    baseline: z.object({ id: z.string(), label: z.string(), version: z.number().int().nonnegative() }).nullable(),
    fixture: z.string(), live_config: liveConfigSchema,
  })),
})
const externalUrl = z.url().refine((value) => /^https?:\/\//.test(value)).nullable()
const executionSchema = z.object({
  run_id: z.string(), model: z.string(), prompt_sha256: z.string(), runner_sha256: z.string(),
  capture_sha256: z.string(), started_at: z.string().nullable(), source_case_ids: z.array(z.string()),
})
const observationSchema = z.object({ outcome: z.enum(['success', 'error', 'missing']), status_match: z.number().nullable(), citation_recall: z.number().nullable() })
const comparisonSchema = z.object({
  schema_version: z.literal(2), comparison: z.enum(['self-replay', 'candidate-reference']), case_ids: z.array(z.string()),
  candidate_execution: executionSchema, reference_execution: executionSchema,
  metrics: z.array(z.object({
    key: z.enum(['statusAccuracy', 'referenceCitationRecall', 'failureRate', 'missingRate', 'meanLatencyMs', 'meanInputTokens', 'meanOutputTokens', 'semanticFaithfulness']),
    reference: z.number().nullable(), candidate: z.number().nullable(), delta: z.number().nullable(),
  })),
  cases: z.array(z.object({ case_id: z.string(), reference: observationSchema, candidate: observationSchema })),
})
const runSchema = z.object({
  id: z.uuid(), dataset_id: z.string(), dataset_label: z.string(), requested_by: z.string(), requested_by_id: z.string(), can_retry: z.boolean(),
  baseline_version: z.number().int().positive().nullable().default(null),
  candidate_capture_id: z.string(), reference_capture_id: z.string(), candidate_label: z.string(), reference_label: z.string(),
  comparison: comparisonSchema.nullable(),
  execution_mode: z.enum(['replay', 'live', 'recovery']), live_config: liveConfigSchema.nullable(),
  source_run_id: z.uuid().nullable().default(null),
  postprocessing: z.object({
    inputs_ready: z.boolean(), stage: z.enum(['unverified', 'report', 'publish', 'completed']),
    can_recover: z.boolean(), blocked_reason: z.string(),
    attempts: z.array(z.object({ id: z.uuid(), status: z.string(), status_label: z.string() })),
  }).nullable().default(null),
  status: z.enum(['REQUESTED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'RESULT_ERROR']),
  status_label: z.string(), created_at: z.string(), started_at: z.string().nullable(),
  finished_at: z.string().nullable(), synced_at: z.string().nullable(),
  sync_attempted_at: z.string().nullable().default(null), status_stale: z.boolean().default(false),
  error_code: z.string(), error_message: z.string(),
  summary: z.object({
    caseCount: z.number().optional(), observedCaseCount: z.number().optional(),
    statusAccuracy: z.number().nullable().optional(), referenceCitationRecall: z.number().nullable().optional(),
    semanticFaithfulness: z.number().nullable().optional(),
  }),
  model_api_calls: z.number().nullable(), evaluation_run_id: z.string().nullable(),
  trace_links: z.array(z.object({ case_id: z.string(), url: z.url().refine((value) => /^https?:\/\//.test(value)) })),
  prefect_flow_run_id: z.uuid().nullable(), prefect_url: externalUrl, langfuse_url: externalUrl,
  report_url: z.string().regex(/^\/api\/v1\/ops\/evaluations\/[a-f0-9-]+\/report$/).nullable(),
})
const pageSchema = z.object({ count: z.number(), next: z.string().nullable(), previous: z.string().nullable(), results: z.array(runSchema) })
const reviewSchema = z.object({
  is_baseline: z.boolean(), material_error: z.string(), baseline_version: z.number().int().nonnegative(),
  baseline_history: z.array(z.object({
    version: z.number().int().positive(), previous_run_id: z.uuid().nullable(), run_id: z.uuid().nullable(),
    capture_sha256: z.string().nullable(), fixture_sha256: z.string().nullable(), changed_by: z.string(), reason: z.string(), created_at: z.string(),
  })),
  reviews: z.array(z.object({
    id: z.number().int(), decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']), comment: z.string(),
    capture_sha256: z.string(), reviewed_by: z.string(), created_at: z.string(),
  })),
  material: z.object({
    capture_sha256: z.string(), fixture_sha256: z.string(),
    cases: z.array(z.object({
      case_id: z.string(), question: z.string(), document_title: z.string(),
      evidence: z.array(z.object({ order: z.number().int(), text: z.string() })),
      answer: z.string(), answer_status: z.string(), cited_orders: z.array(z.number().int()),
      reference_answer: z.string(), expected_status: z.string(), expected_citation_orders: z.array(z.number().int()),
      reference_facts: z.array(z.string()), forbidden_claims: z.array(z.string()),
    })),
  }).nullable(),
})

export type OpsSession = z.infer<typeof sessionSchema>
export type EvaluationRun = z.infer<typeof runSchema>
export type EvaluationPage = z.infer<typeof pageSchema>
export type EvaluationReview = z.infer<typeof reviewSchema>

export class OpsApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

async function request<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}, dispatch = false): Promise<T> {
  let response: Response
  try {
    response = await fetch(base + path, {
      ...options, credentials: 'same-origin', cache: 'no-store',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new OpsApiError('운영 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', 0)
  }
  // 접수가 불확실한 503에는 저장된 요청이 담긴다. 요청 ID를 보존해 재확인한다.
  if (!response.ok && !(dispatch && response.status === 503)) {
    const message = response.status === 401 ? '로그인이 만료되었습니다.'
      : response.status === 403 ? '관리자 계정만 운영 화면을 이용할 수 있습니다.'
      : response.status === 503 ? '관리자 인증 또는 운영 서버에 연결할 수 없습니다.'
      : response.status === 404 ? '평가 실행을 찾을 수 없습니다.'
      : response.status === 409 ? '평가 조건이나 검토 기록이 변경되었습니다. 새로고침 후 확인하세요.'
      : response.status === 400 ? '평가 조건 또는 실행 설정이 변경되었습니다. 새로고침 후 자료와 예산을 확인하세요.'
      : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'
    throw new OpsApiError(message, response.status)
  }
  const parsed = schema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new OpsApiError('운영 서버 응답을 확인할 수 없습니다.', response.status)
  return parsed.data
}

export const getOpsSession = (signal?: AbortSignal) => request('/session', sessionSchema, { signal })

async function post<T>(path: string, data: unknown, schema: z.ZodType<T>, dispatch = false, owner?: string, method = 'POST') {
  // 쓰기 전 Core 관리자 세션과 최신 CSRF 토큰을 확인한다. 토큰·비밀번호는 저장하지 않는다.
  const session = await getOpsSession()
  if (!session.user) throw new OpsApiError('로그인이 만료되었습니다.', 401)
  if (owner && session.user.id !== owner) throw new OpsApiError('로그인 계정이 변경되었습니다. 요청 계정을 다시 확인하세요.', 403)
  return request(path, schema, {
    method, headers: { 'Content-Type': 'application/json', 'X-CSRFToken': session.csrf_token },
    body: JSON.stringify(data),
  }, dispatch)
}

export const listEvaluations = (page: number, signal?: AbortSignal) => request(`/evaluations?page=${page}`, pageSchema, { signal })
export const getEvaluation = (id: string, signal?: AbortSignal) => request(`/evaluations/${encodeURIComponent(id)}`, runSchema, { signal })
export const getEvaluationReview = (id: string, signal?: AbortSignal) => request(`/evaluations/${encodeURIComponent(id)}/review`, reviewSchema, { signal })
export const saveEvaluationReview = (id: string, decision: 'APPROVED' | 'CHANGES_REQUESTED', comment: string, captureSha256: string) => post(`/evaluations/${encodeURIComponent(id)}/review`, { decision, comment, capture_sha256: captureSha256 }, reviewSchema)
export const promoteEvaluationBaseline = (id: string, reviewId: number, version: number) => post(`/evaluations/${encodeURIComponent(id)}/baseline`, { review_id: reviewId, baseline_version: version }, reviewSchema)
export const clearEvaluationBaseline = (id: string, version: number, reason: string) => post(`/evaluations/${encodeURIComponent(id)}/baseline`, { baseline_version: version, reason }, reviewSchema, false, undefined, 'DELETE')
export const recoverEvaluation = (id: string, requestId: string) => post(`/evaluations/${encodeURIComponent(id)}/recover`, { request_id: requestId }, runSchema, true)
export const submitEvaluation = (requestId: string, datasetId: string, candidateCaptureId: string, referenceCaptureId: string, liveConfig: z.infer<typeof liveConfigSchema> | null = null, baselineVersion: number | null = null, owner?: string) => post('/evaluations', {
  request_id: requestId, dataset_id: datasetId, candidate_capture_id: candidateCaptureId, reference_capture_id: referenceCaptureId,
  execution_mode: liveConfig ? 'live' : 'replay', live_config: liveConfig ?? {}, confirm_paid_run: liveConfig !== null, baseline_version: baselineVersion,
}, runSchema, true, owner)


export const evaluationSubmissionSchema = z.object({
  request_id: z.uuid(), dataset_id: z.string().min(1).max(100),
  candidate_capture_id: z.string().min(1).max(100), reference_capture_id: z.string().min(1).max(100),
  live_config: liveConfigSchema.nullable(), baseline_version: z.number().int().positive().nullable(),
}).strict()
export type EvaluationSubmission = z.infer<typeof evaluationSubmissionSchema>
