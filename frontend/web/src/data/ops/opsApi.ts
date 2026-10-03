import { z } from 'zod'

const base = '/api/v1/ops'
const liveConfigSchema = z.object({
  max_input_tokens: z.number().int().positive().optional(),
  embedding_model: z.string().optional(), embedding_dimensions: z.number().int().positive().optional(),
  source_mode: z.literal('fixed-source-and-chunks').optional(),
  max_total_input_tokens: z.number().int().positive().optional(), max_total_output_tokens: z.number().int().positive().optional(),
  model: z.string(), fixture_sha256: z.string(), max_model_calls: z.number().int().positive(), max_output_tokens: z.number().int().positive(),
})
const sessionSchema = z.object({
  user: z.object({ id: z.string(), username: z.string() }).nullable(),
  csrf_token: z.string(),
  live_enabled: z.boolean(),
  rag_live_enabled: z.boolean().default(false),
  search_traces_url: z.url().refine((value) => /^https?:\/\//.test(value)).nullable().default(null),
  datasets: z.array(z.object({
    id: z.string(), label: z.string(), case_ids: z.array(z.string()).min(1),
    evaluation_scope: z.string().nullable().default(null),
    captures: z.array(z.object({ id: z.string(), label: z.string() })).min(1),
    baseline: z.object({ id: z.string(), label: z.string(), version: z.number().int().nonnegative() }).nullable(),
    fixture: z.string(), live_config: liveConfigSchema.nullable(),
    execution_profiles: z.object({ replay: z.string().regex(/^[a-f0-9]{64}$/), live: z.string().regex(/^[a-f0-9]{64}$/).nullable() }),
  })),
})
const externalUrl = z.url().refine((value) => /^https?:\/\//.test(value)).nullable()
const executionSchema = z.object({
  run_id: z.string(), model: z.string(), prompt_sha256: z.string(), runner_sha256: z.string(),
  capture_sha256: z.string(), started_at: z.string().nullable(), source_case_ids: z.array(z.string()),
})
const observationSchema = z.object({ outcome: z.enum(['success', 'error', 'missing']), status_match: z.number().nullable(), citation_recall: z.number().nullable() })
const fixedComparisonSchema = z.object({
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
const ragMetricSchema = z.object({ value: z.number().min(0).max(1).nullable(), measuredCaseCount: z.number().int().nonnegative(), eligibleCaseCount: z.number().int().nonnegative() })
const ragReportSchema = z.object({
  scope: z.literal('source-chunks-retrieval-answer'),
  measurementKind: z.enum(['synthetic-contract-check', 'integration-stub-replay', 'recorded-capture-replay', 'recorded-live-evaluation']),
  baselineEligible: z.literal(false), liveExecutionPerformed: z.boolean(),
  completed: z.boolean(), caseCount: z.number().int().positive(),
  fixtureSha256: z.string(), captureSha256: z.string(),
  execution: z.object({ model: z.string().nullable(), embeddingModel: z.string().nullable(), promptSha256: z.string().nullable() }),
  coverage: z.object({ retrievalCaseCount: z.number().int().nonnegative(), answerCaseCount: z.number().int().nonnegative(), failedCaseCount: z.number().int().nonnegative(), traceCaseCount: z.number().int().nonnegative() }),
  metrics: z.object({ retrievalRecallAtK: ragMetricSchema, answerCitationRecall: ragMetricSchema, answerStatusAccuracy: ragMetricSchema }),
  cases: z.array(z.object({
    caseId: z.string(), traceId: z.string().nullable(),
    retrievalRecallAtK: z.number().nullable(), answerCitationRecall: z.number().nullable(), answerStatusMatches: z.boolean().nullable(),
    failure: z.object({ stage: z.enum(['not_started', 'source', 'chunk', 'index', 'search', 'answer']), code: z.string() }).nullable(),
    retrievedChunkIds: z.array(z.string()).nullable(), citedChunkIds: z.array(z.string()).nullable(),
  })),
})
const ragComparisonSchema = z.object({
  schema_version: z.literal(3), scope: z.literal('source-chunks-retrieval-answer'),
  retrieval_evaluated: z.literal(true), baseline_eligible: z.literal(false),
  comparison: z.enum(['self-replay', 'candidate-reference']), case_ids: z.array(z.string()),
  current: ragReportSchema, reference: ragReportSchema,
})
export type RagComparison = z.infer<typeof ragComparisonSchema>
const ragMaterialObservationSchema = z.object({
  answer: z.string().nullable(), answer_status: z.enum(['ANSWERED', 'INSUFFICIENT_EVIDENCE']).nullable(),
  retrieved_chunk_ids: z.array(z.string()).nullable(), context_chunk_ids: z.array(z.string()).nullable(),
  cited_chunk_ids: z.array(z.string()).nullable(), trace_id: z.string().nullable(),
  failure: ragReportSchema.shape.cases.element.shape.failure,
})
const ragMaterialSchema = z.object({
  schema_version: z.literal(1), evaluation_scope: z.literal('source-chunks-retrieval-answer'),
  reference_source: z.literal('ai-authored-not-human-reviewed'), baseline_eligible: z.literal(false),
  material_sha256: z.string().regex(/^[a-f0-9]{64}$/), fixture_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_capture_sha256: z.string().regex(/^[a-f0-9]{64}$/), reference_capture_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_measurement_kind: ragReportSchema.shape.measurementKind, reference_measurement_kind: ragReportSchema.shape.measurementKind,
  cases: z.array(z.object({
    case_id: z.string(), question: z.string(), document_id: z.string(), source_url: z.string(), content: z.string(),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/), chunk_version: z.string(),
    chunks: z.array(z.object({ id: z.string(), order: z.number().int().nonnegative(), text: z.string() })),
    expected_status: z.enum(['ANSWERED', 'INSUFFICIENT_EVIDENCE']),
    expected_evidence: z.array(z.object({ chunk_id: z.string(), quote: z.string() })),
    candidate: ragMaterialObservationSchema, reference: ragMaterialObservationSchema,
  })).min(1),
})
export type RagMaterial = z.infer<typeof ragMaterialSchema>
const ragDecisionSchema = z.enum(['SUITABLE', 'UNSUITABLE', 'DEFERRED'])
const ragQualityPolicySchema = z.object({
  definition: z.object({ version: z.string(), scope: z.literal('source-chunks-retrieval-answer'),
    pass_enabled: z.boolean(), baseline_eligible: z.boolean(), reference_review_supported: z.boolean() }),
  code_sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const ragQualitySchema = z.object({
  status: z.enum(['NOT_EVALUATED', 'NEEDS_REVIEW', 'FAIL', 'PASS']), is_current: z.boolean(), current_id: z.number().int().positive().nullable(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/), policy: ragQualityPolicySchema, baseline_eligible: z.boolean(),
  history: z.array(z.object({
    id: z.number().int().positive(), status: z.enum(['NEEDS_REVIEW', 'FAIL', 'PASS']), policy: ragQualityPolicySchema,
    policy_sha256: z.string(), input_sha256: z.string(), inputs: z.record(z.string(), z.unknown()),
    reasons: z.array(z.object({ code: z.string(), message: z.string(), case_id: z.string().nullable(), dimension: z.enum(['retrieval', 'answer', 'citation']).nullable() })),
    assessed_by: z.string(), created_at: z.string(),
  })),
}).refine((value) => {
  if (value.status !== 'PASS') return !value.baseline_eligible
  return value.is_current && value.baseline_eligible && value.policy.definition.pass_enabled
    && value.policy.definition.baseline_eligible && value.history.some((row) => row.id === value.current_id && row.status === 'PASS' && row.input_sha256 === value.input_sha256)
})
const ragReferenceDecisionSchema = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'DEFERRED', 'REVOKED'])
const ragReferenceReviewSchema = z.object({
  rubric: z.object({ version: z.literal('rag-reference-review-v1'), scope: z.literal('this-run-all-cases'), description: z.string() }),
  fixture_sha256: z.string().regex(/^[a-f0-9]{64}$/), case_ids: z.array(z.string()).min(1),
  approved: z.boolean(), current_id: z.number().int().positive().nullable(), can_revoke: z.boolean(),
  history: z.array(z.object({
    id: z.number().int().positive(), version: z.number().int().positive(), decision: ragReferenceDecisionSchema,
    comment: z.string(), fixture_sha256: z.string(), case_ids: z.array(z.string()), rubric_version: z.string(),
    execution_spec_sha256: z.string(), revoked_review_id: z.number().int().positive().nullable(),
    reviewed_by: z.string(), created_at: z.string(), is_current: z.boolean(),
  })),
})
const ragReviewStateSchema = z.object({
  baseline: z.object({
    version: z.number().int().nonnegative(), run_id: z.uuid().nullable(), assessment_id: z.number().int().positive().nullable(), selected: z.boolean(),
    history: z.array(z.object({ version: z.number().int().positive(), assessment_id: z.number().int().positive().nullable(), previous_assessment_id: z.number().int().positive().nullable(), reason: z.string(), changed_by: z.string(), created_at: z.string() })),
  }),
  reference_review: ragReferenceReviewSchema,
  quality: ragQualitySchema, material: ragMaterialSchema, reviewer_id: z.string().min(1), review_version: z.number().int().nonnegative(),
  rubric: z.object({ version: z.literal('rag-case-review-v1'), criteria: z.array(z.object({
    key: z.enum(['retrieval', 'answer', 'citation']), label: z.string(), description: z.string(),
  })).length(3).refine((values) => new Set(values.map((value) => value.key)).size === 3) }),
  case_reviews: z.array(z.object({
    id: z.number().int().positive(), case_id: z.string(), version: z.number().int().positive(),
    retrieval_decision: ragDecisionSchema, answer_decision: ragDecisionSchema, citation_decision: ragDecisionSchema,
    comment: z.string(), material_sha256: z.string(), fixture_sha256: z.string(),
    candidate_capture_sha256: z.string(), reference_capture_sha256: z.string(), execution_spec_sha256: z.string(),
    rubric_version: z.string(), is_current: z.boolean(), reviewed_by: z.string(), created_at: z.string(),
  })),
})
export type RagReviewState = z.infer<typeof ragReviewStateSchema>
export type RagReferenceReviewInput = {
  decision: z.infer<typeof ragReferenceDecisionSchema>; comment: string; fixture_sha256: string;
  case_ids: string[]; rubric_version: string; review_version: number; confirmed_all_cases: boolean;
}
export type RagCaseReviewInput = {
  case_id: string; retrieval_decision: z.infer<typeof ragDecisionSchema>; answer_decision: z.infer<typeof ragDecisionSchema>;
  citation_decision: z.infer<typeof ragDecisionSchema>; comment: string;
  material_sha256: string; rubric_version: string; review_version: number;
}

const comparisonSchema = z.discriminatedUnion('schema_version', [fixedComparisonSchema, ragComparisonSchema])
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
  legacy_calls: z.number().int().nonnegative().optional(),
  legacy_input_tokens: z.number().int().nonnegative().optional(),
  legacy_output_tokens: z.number().int().nonnegative().optional(),
  unknown_input_tokens: z.number().int().optional(), unapproved_input_tokens: z.number().int().optional(),
  pending_release_input_tokens: z.number().int().optional(), allocated_input_tokens: z.number().int().optional(),
  unbounded_input_calls: z.number().int().nonnegative().optional(), unbounded_input_reservations: z.number().int().nonnegative().optional(),
  settled_calls: z.number().int(), confirmed_input_tokens: z.number().int(), confirmed_output_tokens: z.number().int(),
  unknown_calls: z.number().int(), unknown_output_tokens: z.number().int(),
  unapproved_calls: z.number().int(), unapproved_output_tokens: z.number().int(),
  pending_release_output_tokens: z.number().int(), allocated_calls: z.number().int(), allocated_output_tokens: z.number().int(),
}).refine((data) => [data.legacy_calls, data.legacy_input_tokens, data.legacy_output_tokens].every((value) => value === undefined)
  || [data.legacy_calls, data.legacy_input_tokens, data.legacy_output_tokens].every((value) => value !== undefined))
const budgetChangeSchema = z.object({
  request_id: z.uuid(), actor: z.string(), source: z.enum(['CLI', 'CORE_ADMIN']), reason: z.string(),
  previous_limits: budgetAmountsSchema.nullable(), limits: budgetAmountsSchema, created_at: z.string(),
})
const dailyAmountsSchema = z.object({ calls: z.number().int().nonnegative(), input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
const dailyPolicySchema = z.object({ enabled: z.boolean(), limits: dailyAmountsSchema })
const dailyBudgetChangeSchema = z.object({
  request_id: z.uuid(), source: z.enum(['CLI', 'CORE_ADMIN']), actor: z.string(), reason: z.string(),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  previous: dailyPolicySchema.nullable(), policy: dailyPolicySchema, created_at: z.iso.datetime({ offset: true }),
}).refine((value) => value.source === 'CLI' ? value.expected_revision == null : value.expected_revision != null)
const dailyBudgetSchema = z.object({
  limits_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  state: z.enum(['disabled', 'enforced', 'unknown', 'exceeded']), timezone: z.literal('Asia/Seoul'),
  period_start: z.iso.datetime({ offset: true }), period_end: z.iso.datetime({ offset: true }),
  limits: dailyAmountsSchema.nullable(), current_day: dailyAmountsSchema.nullable(), carried: dailyAmountsSchema.nullable(),
  allocated: dailyAmountsSchema.nullable(), remaining: dailyAmountsSchema.nullable(),
  recent_changes: z.array(dailyBudgetChangeSchema),
}).refine((value) => {
  if (Date.parse(value.period_end) - Date.parse(value.period_start) !== 86_400_000) return false
  if (value.state === 'disabled' || value.state === 'unknown') return value.remaining === null
    && value.allocated === null && value.current_day === null && value.carried === null
    && (value.state === 'disabled' || value.limits !== null)
  const { limits, current_day: today, carried, allocated, remaining } = value
  if (!limits || !today || !carried || !allocated) return false
  const keys = ['calls', 'input_tokens', 'output_tokens'] as const
  if (!keys.every((key) => allocated[key] === today[key] + carried[key])) return false
  return value.state === 'exceeded'
    ? remaining === null && keys.some((key) => allocated[key] > limits[key])
    : remaining !== null && keys.every((key) => limits[key] - allocated[key] === remaining[key])
}, '일별 예산 장부가 일치하지 않습니다.')
const budgetSummarySchema = z.object({
  daily: dailyBudgetSchema.optional(),
  limits_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  input_state: z.enum(['enforced', 'unconfigured', 'legacy_unknown']).optional(),
  state: z.enum(['consistent', 'inconsistent', 'unconfigured']),
  limits: budgetAmountsSchema.nullable(), allocated: budgetAmountsSchema.nullable(), remaining: budgetAmountsSchema.nullable(),
  breakdown: budgetBreakdownSchema.nullable(), reservation_count: z.number().int().nonnegative(),
  legacy_live_run_count: z.number().int().nonnegative(), change_count: z.number().int().nonnegative(),
  legacy_accounted_run_count: z.number().int().nonnegative().optional(),
  recent_changes: z.array(budgetChangeSchema),
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
const legacyAmountsSchema = z.object({
  calls: z.number().int().nonnegative(), input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
})
const unaccountedRunsSchema = z.object({
  as_of: z.string().datetime({ offset: true }), count: z.number().int().nonnegative(),
  next: z.string().nullable(), previous: z.string().nullable(),
  results: z.array(z.object({
    run_id: z.uuid(), dataset_id: z.string(), dataset_label: z.string(),
    status: z.enum(['REQUESTED', 'QUEUED', 'RUNNING', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'RESULT_ERROR']),
    status_label: z.string(), created_at: z.string().datetime({ offset: true }),
  })),
})
const legacyPreviewBase = z.object({
  as_of: z.string().datetime({ offset: true }), run_id: z.uuid(), applied: z.literal(false),
})
const legacyPreviewSchema = z.discriminatedUnion('state', [
  legacyPreviewBase.extend({
    state: z.literal('unavailable'), blockers: z.array(z.string().min(1)).min(1),
  }),
  legacyPreviewBase.extend({
    state: z.literal('verified'), can_apply: z.boolean(), blockers: z.array(z.string().min(1)),
    source: z.literal('SAVED_CAPTURE'), provider_receipt_verified: z.literal(false),
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/), capture_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    usage: legacyAmountsSchema.extend({ calls: z.number().int().positive() }),
    before: legacyAmountsSchema.nullable(), after: legacyAmountsSchema.nullable(),
  }),
]).refine((data) => data.state === 'unavailable' || data.can_apply === (data.blockers.length === 0)
  && (data.before === null ? data.after === null && !data.can_apply
    : data.after !== null && (['calls', 'input_tokens', 'output_tokens'] as const)
      .every((key) => data.after![key] - data.before![key] === data.usage[key])))
const legacyUsageSchema = z.object({
  actor_source: z.enum(['CLI', 'CORE_ADMIN']).optional(),
  request_id: z.uuid(), run_id: z.uuid(), source: z.literal('SAVED_CAPTURE'), provider_receipt_verified: z.literal(false),
  actor: z.string().trim().min(1), reason: z.string().trim().min(1),
  capture_sha256: z.string().regex(/^[a-f0-9]{64}$/), evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  usage: legacyAmountsSchema.extend({ calls: z.number().int().positive() }),
  before: legacyAmountsSchema, after: legacyAmountsSchema, created_at: z.string().datetime({ offset: true }),
}).refine(({ before, after, usage }) => (['calls', 'input_tokens', 'output_tokens'] as const)
  .every((key) => after[key] - before[key] === usage[key]))
const runBudgetSchema = z.object({
  as_of: z.string(), state: z.enum(['recorded', 'legacy_recorded', 'missing', 'not_applicable']), reservation: budgetReservationSchema.nullable(),
  legacy_usage: legacyUsageSchema.nullable().optional(),
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
  .refine((data) => data.state === 'legacy_recorded'
    ? Boolean(data.legacy_usage) && !data.cleanup && !data.corrections?.length
    : !data.legacy_usage)
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

const readinessAmountsSchema = z.object({
  calls: z.number().int().nonnegative(), input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
})
const readinessIssueSchema = z.object({ code: z.string().min(1), message: z.string().min(1) })
const liveReadinessSchema = z.object({
  daily: dailyBudgetSchema.optional(),
  as_of: z.iso.datetime({ offset: true }), dataset_id: z.string(), execution_profile: z.string().regex(/^[a-f0-9]{64}$/),
  evaluation_scope: z.enum(['fixed-answer-context-only', 'source-chunks-retrieval-answer']), model: z.string().min(1),
  state: z.enum(['blocked', 'checked']),
  required: readinessAmountsSchema.extend({ calls: z.number().int().positive(), input_tokens: z.number().int().positive(), output_tokens: z.number().int().positive() }),
  remaining: readinessAmountsSchema.extend({ input_tokens: z.number().int().nonnegative().nullable() }).nullable(),
  blockers: z.array(readinessIssueSchema), warnings: z.array(readinessIssueSchema),
}).refine((value) => {
  if ((value.state === 'blocked') !== (value.blockers.length > 0)) return false
  if (value.state === 'blocked') return true
  if (value.daily && value.daily.state !== 'disabled') {
    if (value.daily.state !== 'enforced' || !value.daily.remaining) return false
    if ((['calls', 'input_tokens', 'output_tokens'] as const).some((key) => value.daily!.remaining![key] < value.required[key])) return false
  }
  const left = value.remaining
  return left !== null && left.calls >= value.required.calls && left.output_tokens >= value.required.output_tokens
    && (left.input_tokens === null
      ? value.evaluation_scope === 'fixed-answer-context-only' && value.warnings.length > 0
      : left.input_tokens >= value.required.input_tokens)
}, '실행 설정·예산 점검 결과가 일치하지 않습니다.')

export type LiveReadiness = z.infer<typeof liveReadinessSchema>
export type OpsSession = z.infer<typeof sessionSchema>
export type EvaluationRun = z.infer<typeof runSchema>
export type EvaluationPage = z.infer<typeof pageSchema>
export type BudgetBreakdown = z.infer<typeof budgetBreakdownSchema>
export type BudgetSummary = z.infer<typeof budgetSummarySchema>
export type DailyBudget = z.infer<typeof dailyBudgetSchema>
export type DailyBudgetLimitsInput = { request_id: string; expected_revision: string; reason: string } & (
  { disable: false; calls: number; input_tokens: number; output_tokens: number }
  | { disable: true; calls: null; input_tokens: null; output_tokens: null }
)
export type BudgetLimitsInput = { request_id: string; expected_revision: string; calls: number; input_tokens: number | null; output_tokens: number; reason: string }
export type LegacyUsageInput = { request_id: string; evidence_sha256: string; reason: string }
export type BudgetPage = z.infer<typeof budgetPageSchema>
export type RunBudget = z.infer<typeof runBudgetSchema>
export type UnaccountedRuns = z.infer<typeof unaccountedRunsSchema>
export type LegacyUsagePreview = z.infer<typeof legacyPreviewSchema>
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
      : ['BUDGET_CHANGE_CONFLICT', 'DAILY_BUDGET_CHANGE_CONFLICT', 'LEGACY_USAGE_CONFLICT'].includes(error?.code) && typeof error?.detail === 'string'
        ? error.detail
      : error?.code === 'INVALID_RAG_REVIEW' ? '검토 항목과 의견을 확인하세요. 미측정 항목은 판단 보류만 저장할 수 있습니다.'
      : error?.code === 'INVALID_RAG_REFERENCE_REVIEW' ? '전체 대상 자료의 확인과 참조 검토 근거를 입력하세요.'
      : error?.code === 'CANCEL_FORBIDDEN' ? '평가를 요청한 계정만 취소할 수 있습니다.'
      : error?.code === 'CANCEL_CONFLICT' ? '이미 종료된 평가입니다. 상태를 다시 확인하세요.'
      : error?.code === 'RESULTS_UNAVAILABLE' ? '저장된 검토 자료와 평가 결과의 무결성을 확인할 수 없습니다. 운영자에게 확인해 주세요.'
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
export const getLiveReadiness = (datasetId: string, executionProfile: string, signal?: AbortSignal) => request(
  `/evaluations/live-readiness?${new URLSearchParams({ dataset_id: datasetId, execution_profile: executionProfile })}`,
  liveReadinessSchema.refine((value) => value.dataset_id === datasetId && value.execution_profile === executionProfile, '선택한 실행 설정과 점검 결과가 다릅니다.'), { signal },
)
export const getBudgetReservations = (page: number, signal?: AbortSignal) => request(`/budget/reservations?page=${page}`, budgetPageSchema, { signal })
export const getUnaccountedRuns = (page: number, signal?: AbortSignal) => request(`/budget/unaccounted-runs?page=${page}`, unaccountedRunsSchema, { signal })
export const getLegacyUsagePreview = (id: string, signal?: AbortSignal) => request(`/evaluations/${encodeURIComponent(id)}/legacy-usage-preview`,
  legacyPreviewSchema.refine((data) => data.run_id === id), { signal })
export const getRunBudget = (id: string, signal?: AbortSignal) => request(`/evaluations/${encodeURIComponent(id)}/budget`,
  runBudgetSchema.refine((data) => !data.legacy_usage || data.legacy_usage.run_id === id), { signal })

export const setBudgetLimits = (data: BudgetLimitsInput, owner: string) => post('/budget/limits', data,
  z.object({ change: budgetChangeSchema }).refine(({ change }) => change.source === 'CORE_ADMIN'
    && change.actor === owner && change.request_id === data.request_id && change.reason === data.reason
    && change.limits.calls === data.calls && change.limits.output_tokens === data.output_tokens
    && change.limits.input_tokens === data.input_tokens), false, owner)
export const setDailyBudgetLimits = (data: DailyBudgetLimitsInput, owner: string) => post('/budget/daily-limits', data,
  z.object({ change: dailyBudgetChangeSchema }).refine(({ change }) => change.source === 'CORE_ADMIN'
    && change.actor === owner && change.request_id === data.request_id && change.reason === data.reason
    && change.expected_revision === data.expected_revision && change.policy.enabled === !data.disable
    && (data.disable
      ? change.previous !== null && (['calls', 'input_tokens', 'output_tokens'] as const).every((key) => change.policy.limits[key] === change.previous!.limits[key])
      : change.policy.limits.calls === data.calls && change.policy.limits.input_tokens === data.input_tokens && change.policy.limits.output_tokens === data.output_tokens)), false, owner)
export const applyLegacyUsage = (runId: string, data: LegacyUsageInput, owner: string) => post(
  `/evaluations/${encodeURIComponent(runId)}/legacy-usage`, data,
  z.object({ applied: z.literal(true), replayed: z.boolean(), record: legacyUsageSchema }).refine(({ record }) =>
    record.actor_source === 'CORE_ADMIN' && record.actor === owner && record.run_id === runId
    && record.request_id === data.request_id && record.reason === data.reason
    && record.evidence_sha256 === data.evidence_sha256), false, owner)

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
export const getRagMaterial = (id: string, signal?: AbortSignal) => request(`/evaluations/${encodeURIComponent(id)}/rag-material`, ragMaterialSchema, { signal })
export const getRagReviews = (id: string, signal?: AbortSignal) => request(`/evaluations/${encodeURIComponent(id)}/rag-reviews`, ragReviewStateSchema, { signal })
export const assessRagQuality = (id: string, inputSha256: string, reviewerId: string) => post(`/evaluations/${encodeURIComponent(id)}/rag-quality`, { input_sha256: inputSha256 }, ragReviewStateSchema, false, reviewerId)
export const selectRagBaseline = (id: string, data: { assessment_id: number; input_sha256: string; baseline_version: number; reason: string }, reviewerId: string) => post(`/evaluations/${encodeURIComponent(id)}/rag-baseline`, data, ragReviewStateSchema, false, reviewerId)
export const clearRagBaseline = (id: string, data: { baseline_version: number; reason: string }, reviewerId: string) => post(`/evaluations/${encodeURIComponent(id)}/rag-baseline`, data, ragReviewStateSchema, false, reviewerId, 'DELETE')
export const saveRagCaseReview = (id: string, data: RagCaseReviewInput, reviewerId: string) => post(`/evaluations/${encodeURIComponent(id)}/rag-reviews`, data, ragReviewStateSchema, false, reviewerId)
export const saveRagReferenceReview = (id: string, data: RagReferenceReviewInput, reviewerId: string) => post(`/evaluations/${encodeURIComponent(id)}/rag-reference-review`, data, ragReviewStateSchema, false, reviewerId)
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
