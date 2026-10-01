import { z } from 'zod'

const base = '/api/v1/ops'
const liveConfigSchema = z.object({
  max_input_tokens: z.number().int().positive().optional(),
  model: z.string(), fixture_sha256: z.string(), max_model_calls: z.number().int().positive(), max_output_tokens: z.number().int().positive(),
})
const sessionSchema = z.object({
  user: z.object({ id: z.string(), username: z.string() }).nullable(),
  csrf_token: z.string(),
  live_enabled: z.boolean(),
  search_traces_url: z.url().refine((value) => /^https?:\/\//.test(value)).nullable().default(null),
  datasets: z.array(z.object({
    id: z.string(), label: z.string(), case_ids: z.array(z.string()).min(1),
    evaluation_scope: z.string().nullable().default(null),
    captures: z.array(z.object({ id: z.string(), label: z.string() })).min(1),
    baseline: z.object({ id: z.string(), label: z.string(), version: z.number().int().nonnegative() }).nullable(),
    fixture: z.string(), live_config: liveConfigSchema,
    execution_profiles: z.object({ replay: z.string().regex(/^[a-f0-9]{64}$/), live: z.string().regex(/^[a-f0-9]{64}$/) }),
  })),
})
const externalUrl = z.url().refine((value) => /^https?:\/\//.test(value)).nullable()
const executionSchema = z.object({
  run_id: z.string(), model: z.string(), prompt_sha256: z.string(), runner_sha256: z.string(),
  capture_sha256: z.string(), started_at: z.string().nullable(), source_case_ids: z.array(z.string()),
})
const observationSchema = z.object({ outcome: z.enum(['success', 'error', 'missing']), status_match: z.number().nullable(), citation_recall: z.number().nullable() })
const comparisonSchema = z.object({
  scope: z.string().nullable().default(null),
  retrieval_evaluated: z.boolean().nullable().default(null),
  schema_version: z.literal(2), comparison: z.enum(['self-replay', 'candidate-reference']), case_ids: z.array(z.string()),
  candidate_execution: executionSchema, reference_execution: executionSchema,
  metrics: z.array(z.object({
    key: z.enum(['statusAccuracy', 'referenceCitationRecall', 'failureRate', 'missingRate', 'meanLatencyMs', 'meanInputTokens', 'meanOutputTokens', 'semanticFaithfulness']),
    reference: z.number().nullable(), candidate: z.number().nullable(), delta: z.number().nullable(),
  })),
  cases: z.array(z.object({ case_id: z.string(), reference: observationSchema, candidate: observationSchema })),
})
const runSchema = z.object({
  evaluation_scope: z.string().nullable().default(null),
  can_cancel: z.boolean().default(false),
  cancel_requested_at: z.string().nullable().default(null),
  cancel_requested_by: z.string().nullable().default(null),
  execution_profile: z.string().nullable().default(null),
  execution_spec_sha256: z.string().nullable().default(null),
  execution_spec: z.object({
    dataset: z.object({ case_ids: z.array(z.string()), fixture_sha256: z.string() }),
    evaluation: z.object({ sha256: z.string() }),
    generation: z.object({ prompt_sha256: z.string() }).nullable(),
  }).nullable().default(null),
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
  status: z.enum(['REQUESTED', 'QUEUED', 'RUNNING', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'RESULT_ERROR']),
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
const budgetAmountsSchema = z.object({ input_tokens: z.number().int().nonnegative().nullable().optional(), calls: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
const budgetBreakdownSchema = z.object({
  unknown_input_tokens: z.number().int().optional(), unapproved_input_tokens: z.number().int().optional(),
  pending_release_input_tokens: z.number().int().optional(), allocated_input_tokens: z.number().int().optional(),
  unbounded_input_calls: z.number().int().nonnegative().optional(), unbounded_input_reservations: z.number().int().nonnegative().optional(),
  settled_calls: z.number().int(), confirmed_input_tokens: z.number().int(), confirmed_output_tokens: z.number().int(),
  unknown_calls: z.number().int(), unknown_output_tokens: z.number().int(),
  unapproved_calls: z.number().int(), unapproved_output_tokens: z.number().int(),
  pending_release_output_tokens: z.number().int(), allocated_calls: z.number().int(), allocated_output_tokens: z.number().int(),
})
const budgetSummarySchema = z.object({
  input_state: z.enum(['enforced', 'unconfigured', 'legacy_unknown']).optional(),
  state: z.enum(['consistent', 'inconsistent', 'unconfigured']),
  limits: budgetAmountsSchema.nullable(), allocated: budgetAmountsSchema.nullable(), remaining: budgetAmountsSchema.nullable(),
  breakdown: budgetBreakdownSchema.nullable(), reservation_count: z.number().int().nonnegative(),
  legacy_live_run_count: z.number().int().nonnegative(), change_count: z.number().int().nonnegative(),
  recent_changes: z.array(z.object({
    request_id: z.uuid(), actor: z.string(), source: z.literal('CLI'), reason: z.string(),
    previous_limits: budgetAmountsSchema.nullable(), limits: budgetAmountsSchema, created_at: z.string(),
  })),
})
const budgetReservationSchema = z.object({
  max_input_tokens: z.number().int().positive().nullable().optional(),
  reserved_input_tokens: z.number().int().nonnegative().nullable().optional(),
  reserved_output_tokens: z.number().int().nonnegative().optional(),
  run_id: z.uuid(), dataset_id: z.string(), created_at: z.string(), closed_at: z.string().nullable(),
  max_calls: z.number().int().positive(), max_output_tokens: z.number().int().nonnegative(), breakdown: budgetBreakdownSchema,
})
const budgetPageSchema = z.object({
  as_of: z.string(), summary: budgetSummarySchema,
  count: z.number().int().nonnegative(), next: z.string().nullable(), previous: z.string().nullable(), results: z.array(budgetReservationSchema),
})
const cleanupAmountsSchema = z.object({
  global_input_tokens: z.number().int().nonnegative().optional(), reservation_input_tokens: z.number().int().nonnegative().optional(),
  global_calls: z.number().int().nonnegative(), global_output_tokens: z.number().int().nonnegative(),
  reservation_calls: z.number().int().nonnegative(), reservation_output_tokens: z.number().int().nonnegative(),
})
const inputDeltaMatches = (before: z.infer<typeof cleanupAmountsSchema>, after: z.infer<typeof cleanupAmountsSchema>) => {
  const values = [before.global_input_tokens, after.global_input_tokens, before.reservation_input_tokens, after.reservation_input_tokens]
  return values.every((value) => value === undefined) || values.every((value) => value !== undefined)
    && before.global_input_tokens! - after.global_input_tokens! === before.reservation_input_tokens! - after.reservation_input_tokens!
}
const budgetCleanupSchema = z.object({
  request_id: z.uuid(), actor: z.string(), source: z.literal('CLI'), reason: z.string(), created_at: z.string(),
  evidence: z.object({
    source: z.literal('PREFECT'), flow_id: z.uuid(), run_id: z.uuid(), spec_sha256: z.string(),
    parameters_sha256: z.string(), state_id: z.uuid(), state_type: z.enum(['COMPLETED', 'FAILED', 'CRASHED', 'CANCELLED']),
    state_timestamp: z.string(), observed_at: z.string(),
  }),
  before: cleanupAmountsSchema,
  after: cleanupAmountsSchema.extend({ unknown_calls: z.number().int().nonnegative(), unknown_output_tokens: z.number().int().nonnegative() }),
}).refine(({ before, after }) => inputDeltaMatches(before, after)
  && (before.global_input_tokens === undefined || after.global_input_tokens! <= before.global_input_tokens)
  && after.reservation_calls <= before.reservation_calls
  && after.reservation_output_tokens <= before.reservation_output_tokens
  && after.unknown_calls <= after.reservation_calls && after.unknown_output_tokens <= after.reservation_output_tokens
  && before.global_calls - after.global_calls === before.reservation_calls - after.reservation_calls
  && before.global_output_tokens - after.global_output_tokens === before.reservation_output_tokens - after.reservation_output_tokens)
const correctionAmountsSchema = cleanupAmountsSchema.extend({
  unknown_calls: z.number().int().nonnegative(), unknown_output_tokens: z.number().int().nonnegative(),
})
const usageCorrectionSchema = z.object({
  request_id: z.string().uuid(), run_id: z.string().uuid(), sequence: z.number().int().nonnegative(),
  source: z.enum(['WORKER_RESPONSE', 'WORKER_EMBEDDING_RESPONSE']), actor: z.string().min(1), reason: z.string().min(1),
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/), response_id: z.string().regex(/^resp_[A-Za-z0-9_-]{1,180}$/).nullable(),
  provider_request_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/).optional(),
  input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
  before: correctionAmountsSchema, after: correctionAmountsSchema, created_at: z.string().datetime({ offset: true }),
}).refine((record) => record.source === 'WORKER_RESPONSE'
  ? record.response_id !== null && record.provider_request_id === undefined
  : record.response_id === null && record.provider_request_id !== undefined && record.output_tokens === 0)
  .refine(({ before, after }) => inputDeltaMatches(before, after) && before.global_calls === after.global_calls
  && before.reservation_calls === after.reservation_calls && before.unknown_calls - after.unknown_calls === 1
  && before.global_output_tokens >= after.global_output_tokens
  && before.global_output_tokens - after.global_output_tokens === before.reservation_output_tokens - after.reservation_output_tokens)
const runBudgetSchema = z.object({
  as_of: z.string(), state: z.enum(['recorded', 'missing', 'not_applicable']), reservation: budgetReservationSchema.nullable(),
  cleanup: budgetCleanupSchema.nullable().optional(),
  corrections: z.array(usageCorrectionSchema).optional(),
  calls: z.array(z.object({
    sequence: z.number().int().nonnegative(), authorized_at: z.string(), settled_at: z.string().nullable(),
    max_input_tokens: z.number().int().positive().nullable().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    counted_input_tokens: z.number().int().nonnegative().nullable().optional(),
    operation_id: z.string().regex(/^(answer|document_embedding|query_embedding):[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/).nullable().optional(),
    input_tokens: z.number().int().nonnegative().nullable(), output_tokens: z.number().int().nonnegative().nullable(),
  }).refine((call) => call.settled_at === null
    ? call.input_tokens === null && call.output_tokens === null
    : call.input_tokens !== null && call.output_tokens !== null)),
}).refine((data) => data.state === 'recorded' ? data.reservation !== null : data.reservation === null && data.calls.length === 0)
  .refine((data) => !data.cleanup || Boolean(data.reservation?.closed_at && data.cleanup.evidence.run_id === data.reservation.run_id))
  .refine((data) => {
    const corrections = data.corrections ?? []
    return new Set(corrections.map((record) => record.sequence)).size === corrections.length
      && new Set(corrections.map((record) => record.source + ':' + (record.provider_request_id ?? record.response_id))).size === corrections.length
      && corrections.every((record) => {
        const reservation = data.reservation
        const call = data.calls.find((item) => item.sequence === record.sequence)
        const inputCap = call?.max_input_tokens ?? reservation?.max_input_tokens
        const outputCap = call?.max_output_tokens ?? reservation?.max_output_tokens
        const embedding = record.source === 'WORKER_EMBEDDING_RESPONSE'
        const kindMatches = embedding
          ? /^(document_embedding|query_embedding):/.test(call?.operation_id ?? '')
            && call?.max_input_tokens != null && call.max_output_tokens === 0
            && record.before.reservation_input_tokens !== undefined && record.after.reservation_input_tokens !== undefined
            && record.before.reservation_input_tokens - record.after.reservation_input_tokens === call.max_input_tokens - record.input_tokens
          : !call?.operation_id || call.operation_id.startsWith('answer:')
        return kindMatches && outputCap !== undefined && reservation?.closed_at && reservation.run_id === record.run_id && call?.settled_at === null
          && (inputCap == null || record.input_tokens <= inputCap)
          && record.output_tokens <= outputCap
          && record.before.unknown_output_tokens - record.after.unknown_output_tokens === outputCap
          && record.before.reservation_output_tokens - record.after.reservation_output_tokens === outputCap - record.output_tokens
      })
  })
const qualitySchema = z.object({
  status: z.enum(['NOT_EVALUATED', 'NEEDS_REVIEW', 'FAIL', 'PASS']), is_current: z.boolean(),
  current_id: z.number().nullable(), input_sha256: z.string().nullable(), blocked_reason: z.string(),
  policy: z.object({ definition: z.object({ version: z.string() }), code_sha256: z.string() }).nullable(),
  fixture_version: z.number().int().nonnegative(), fixture_rubric_version: z.string(),
  fixture_reviews: z.array(z.object({
    id: z.number(), version: z.number(), decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'DEFERRED']),
    comment: z.string(), fixture_sha256: z.string(), case_ids: z.array(z.string()), rubric_version: z.string(),
    reviewed_by: z.string(), created_at: z.string(),
  })),
  history: z.array(z.object({
    id: z.number(), status: z.enum(['PASS', 'FAIL', 'NEEDS_REVIEW']),
    policy: z.object({ definition: z.object({ version: z.string() }) }),
    policy_sha256: z.string(), input_sha256: z.string(), assessed_by: z.string(), created_at: z.string(),
    reasons: z.array(z.object({ code: z.string(), case_id: z.string().nullable(), message: z.string() })),
  })),
})
const reviewSchema = z.object({
  quality: qualitySchema.nullable().default(null), can_promote: z.boolean().default(false),
  is_baseline: z.boolean(), material_error: z.string(), baseline_version: z.number().int().nonnegative(),
  review_version: z.number().int().nonnegative(), can_approve: z.boolean(), approval_current: z.boolean(), baseline_requires_review: z.boolean(),
  rubric: z.object({ version: z.string(), criteria: z.array(z.string()) }),
  case_reviews: z.array(z.object({
    id: z.number().int(), case_id: z.string(), version: z.number().int().positive(),
    decision: z.enum(['SUITABLE', 'UNSUITABLE', 'DEFERRED']), comment: z.string(),
    capture_sha256: z.string(), fixture_sha256: z.string(), rubric_version: z.string(),
    reviewed_by: z.string(), created_at: z.string(),
  })),
  baseline_history: z.array(z.object({
    version: z.number().int().positive(), previous_run_id: z.uuid().nullable(), run_id: z.uuid().nullable(),
    capture_sha256: z.string().nullable(), fixture_sha256: z.string().nullable(), changed_by: z.string(), reason: z.string(), created_at: z.string(),
  })),
  reviews: z.array(z.object({
    id: z.number().int(), decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']), comment: z.string(),
    capture_sha256: z.string(), reviewed_by: z.string(), created_at: z.string(),
    fixture_sha256: z.string(), rubric_version: z.string(), version: z.number().int().nullable(), case_review_ids: z.array(z.number().int()),
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
export type BudgetBreakdown = z.infer<typeof budgetBreakdownSchema>
export type BudgetPage = z.infer<typeof budgetPageSchema>
export type RunBudget = z.infer<typeof runBudgetSchema>
export type EvaluationReview = z.infer<typeof reviewSchema>
export type CaseReviewDecision = EvaluationReview['case_reviews'][number]['decision']
export type ReviewStamp = { capture_sha256: string; fixture_sha256: string; rubric_version: string; review_version: number }

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
  const body = await response.json().catch(() => null)
  const admissionMessage = response.status === 503 && body?.code === 'EVALUATION_ADMISSION_PAUSED'
    ? '점검을 위해 새 평가 접수가 중지되어 있습니다. 접수 재개 후 다시 시도해 주세요.'
    : response.status === 503 && body?.code === 'EVALUATION_ADMISSION_UNAVAILABLE'
    ? '평가 접수 상태를 확인할 수 없어 접수하지 않았습니다. 운영자에게 확인해 주세요.'
    : null
  if (admissionMessage) throw new OpsApiError(admissionMessage, response.status)
  // 접수가 불확실한 503에는 저장된 요청이 담긴다. 요청 ID를 보존해 재확인한다.
  if (!response.ok && !(dispatch && response.status === 503)) {
    const error = body
    const message = response.status === 400 && error?.code === 'LIVE_BUDGET_UNAVAILABLE'
      ? '누적 평가 한도가 부족하거나 설정되지 않아 접수하지 않았습니다. 운영자에게 예약·미확인 사용량과 한도를 확인해 주세요.'
      : error?.code === 'CANCEL_FORBIDDEN' ? '평가를 요청한 계정만 취소할 수 있습니다.'
      : error?.code === 'CANCEL_CONFLICT' ? '이미 종료된 평가입니다. 상태를 다시 확인하세요.'
      : response.status === 401 ? '로그인이 만료되었습니다.'
      : response.status === 403 ? '관리자 계정만 운영 화면을 이용할 수 있습니다.'
      : response.status === 503 ? '관리자 인증 또는 운영 서버에 연결할 수 없습니다.'
      : response.status === 404 ? '평가 실행을 찾을 수 없습니다.'
      : response.status === 409 ? '평가 조건이나 검토 기록이 변경되었습니다. 새로고침 후 확인하세요.'
      : response.status === 400 ? '평가 조건 또는 실행 설정이 변경되었습니다. 새로고침 후 자료와 예산을 확인하세요.'
      : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'
    throw new OpsApiError(message, response.status)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new OpsApiError('운영 서버 응답을 확인할 수 없습니다.', response.status)
  return parsed.data
}

export const getOpsSession = (signal?: AbortSignal) => request('/session', sessionSchema, { signal })
export const getBudgetSummary = (signal?: AbortSignal) => request('/budget', budgetSummarySchema.extend({ as_of: z.string() }), { signal })
export const getBudgetReservations = (page: number, signal?: AbortSignal) => request(`/budget/reservations?page=${page}`, budgetPageSchema, { signal })
export const getRunBudget = (id: string, signal?: AbortSignal) => request(`/evaluations/${encodeURIComponent(id)}/budget`, runBudgetSchema, { signal })

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
export const assessEvaluationQuality = (id: string, inputSha256: string) => post(`/evaluations/${encodeURIComponent(id)}/quality`, { input_sha256: inputSha256 }, reviewSchema)
export const saveFixtureReview = (id: string, data: { decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'DEFERRED'; comment: string; fixture_sha256: string; case_ids: string[]; rubric_version: string; fixture_version: number }) => post(`/evaluations/${encodeURIComponent(id)}/fixture-review`, data, reviewSchema)
export const saveEvaluationReview = (id: string, decision: 'APPROVED' | 'CHANGES_REQUESTED', comment: string, stamp: ReviewStamp) => post(`/evaluations/${encodeURIComponent(id)}/review`, { decision, comment, ...stamp }, reviewSchema)
export const saveEvaluationCaseReview = (id: string, caseId: string, decision: CaseReviewDecision, comment: string, stamp: ReviewStamp) => post(`/evaluations/${encodeURIComponent(id)}/case-review`, { case_id: caseId, decision, comment, ...stamp }, reviewSchema)
export const promoteEvaluationBaseline = (id: string, reviewId: number, version: number) => post(`/evaluations/${encodeURIComponent(id)}/baseline`, { review_id: reviewId, baseline_version: version }, reviewSchema)
export const clearEvaluationBaseline = (id: string, version: number, reason: string) => post(`/evaluations/${encodeURIComponent(id)}/baseline`, { baseline_version: version, reason }, reviewSchema, false, undefined, 'DELETE')
export const cancelEvaluation = (id: string, owner: string) => post(`/evaluations/${encodeURIComponent(id)}/cancel`, {}, runSchema, false, owner)
export const recoverEvaluation = (id: string, requestId: string) => post(`/evaluations/${encodeURIComponent(id)}/recover`, { request_id: requestId }, runSchema, true)
export const submitEvaluation = (requestId: string, datasetId: string, candidateCaptureId: string, referenceCaptureId: string, liveConfig: z.infer<typeof liveConfigSchema> | null = null, baselineVersion: number | null = null, owner?: string, executionProfile: string | null = null) => post('/evaluations', {
  request_id: requestId, dataset_id: datasetId, candidate_capture_id: candidateCaptureId, reference_capture_id: referenceCaptureId,
  execution_mode: liveConfig ? 'live' : 'replay', live_config: liveConfig ?? {}, confirm_paid_run: liveConfig !== null, baseline_version: baselineVersion, execution_profile: executionProfile,
}, runSchema, true, owner)


export const evaluationSubmissionSchema = z.object({
  request_id: z.uuid(), dataset_id: z.string().min(1).max(100),
  candidate_capture_id: z.string().min(1).max(100), reference_capture_id: z.string().min(1).max(100),
  execution_profile: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  live_config: liveConfigSchema.nullable(), baseline_version: z.number().int().positive().nullable(),
}).strict()
export type EvaluationSubmission = z.infer<typeof evaluationSubmissionSchema>
