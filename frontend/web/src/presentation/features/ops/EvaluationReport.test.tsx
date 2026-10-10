// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { getEvaluation, getEvaluationReview, getRagMaterial, OpsApiError } from '../../../data/ops/opsApi'
import type { EvaluationRun, RagComparison, RagMaterial, EvaluationReview } from '../../../data/ops/opsApi'
import { EvaluationReport } from './EvaluationReport'

vi.mock('../../../data/ops/opsApi', async (original) => ({
  ...await original<typeof import('../../../data/ops/opsApi')>(),
  getEvaluation: vi.fn(), getEvaluationReview: vi.fn(), getRagMaterial: vi.fn(),
}))
const id = '10000000-0000-4000-8000-000000000001'
const path = `/ops/evaluations/${id}/report`
const reportUrl = `/api/v1/ops/evaluations/${id}/report`
const metric = (value: number | null) => ({ value, measuredCaseCount: value === null ? 0 : 1, eligibleCaseCount: 1 })
const ragCase: RagComparison['current']['cases'][number] = {
  caseId: 'H01', traceId: null, retrievalRecallAtK: 1, answerCitationRecall: 0, answerStatusMatches: true,
  failure: null, retrievedChunkIds: ['chunk-1'], citedChunkIds: [],
}
const current: RagComparison['current'] = {
  scope: 'source-chunks-retrieval-answer', measurementKind: 'recorded-live-evaluation', baselineEligible: false,
  liveExecutionPerformed: true, completed: true, caseCount: 1, fixtureSha256: 'a'.repeat(64), captureSha256: 'b'.repeat(64),
  execution: { model: 'saved-model', embeddingModel: 'saved-embedding', promptSha256: 'c'.repeat(64) },
  coverage: { retrievalCaseCount: 1, answerCaseCount: 1, failedCaseCount: 0, traceCaseCount: 0 },
  metrics: { retrievalRecallAtK: metric(1), answerCitationRecall: metric(0), answerStatusAccuracy: metric(1) }, cases: [ragCase],
}
const rag: RagComparison = {
  schema_version: 3, scope: 'source-chunks-retrieval-answer', retrieval_evaluated: true, baseline_eligible: false,
  comparison: 'candidate-reference', case_ids: ['H01'], current,
  reference: { ...current, measurementKind: 'synthetic-contract-check', liveExecutionPerformed: false, completed: false,
    execution: { model: null, embeddingModel: null, promptSha256: null },
    coverage: { retrievalCaseCount: 0, answerCaseCount: 0, failedCaseCount: 1, traceCaseCount: 0 },
    metrics: { retrievalRecallAtK: metric(null), answerCitationRecall: metric(null), answerStatusAccuracy: metric(null) },
    cases: [{ ...ragCase, retrievalRecallAtK: null, answerCitationRecall: null, answerStatusMatches: null, failure: { stage: 'not_started', code: 'SYNTHETIC' } }],
  },
}
// 화면에 필요한 실행 필드만 준비한다. 실제 응답 스키마·인증·경로는 App.ops.test.tsx에서 검증한다.
const run = (comparison: EvaluationRun['comparison'] = rag) => ({
  id, dataset_label: '고정 공고 RAG 자료', candidate_label: '저장된 후보', reference_label: '합성 비교 자료',
  comparison, status: 'COMPLETED', status_label: '완료', finished_at: '2026-10-06T01:00:00Z', report_url: reportUrl,
} as EvaluationRun)
const materialCase: RagMaterial['cases'][number] = {
  case_id: 'H01', question: '어떤 기업이 지원할 수 있나요?', document_id: '공고 A', source_url: '', content: '공고 원문',
  content_sha256: 'd'.repeat(64), chunk_version: 'v1', chunks: [], expected_status: 'ANSWERED', expected_evidence: [],
  candidate: { answer: '저장된 후보 답변', answer_status: 'ANSWERED', retrieved_chunk_ids: ['chunk-1'], context_chunk_ids: ['chunk-1'], cited_chunk_ids: [], trace_id: null, failure: null },
  reference: { answer: null, answer_status: null, retrieved_chunk_ids: null, context_chunk_ids: null, cited_chunk_ids: null, trace_id: null, failure: { stage: 'not_started', code: 'SYNTHETIC' } },
}
const material = { data_type: 'official-html-snapshot', cases: [materialCase] } as RagMaterial
const execution = { run_id: 'capture', model: 'older-recorded-model', prompt_sha256: '', runner_sha256: '', capture_sha256: '', started_at: '2026-10-01T00:00:00Z', source_case_ids: ['H01'] }
const fixed: NonNullable<EvaluationRun['comparison']> = {
  schema_version: 2, scope: 'fixed-answer-context-only', retrieval_evaluated: false, comparison: 'self-replay', case_ids: ['H01'],
  candidate_execution: execution, reference_execution: execution,
  metrics: [
    { key: 'statusAccuracy', candidate: 1, reference: 1, delta: 0 },
    { key: 'meanLatencyMs', candidate: 1234.5, reference: 1234.5, delta: 0 },
    { key: 'meanInputTokens', candidate: 50, reference: 50, delta: 0 },
    { key: 'semanticFaithfulness', candidate: null, reference: null, delta: null },
  ],
  cases: [{ case_id: 'H01', candidate: { outcome: 'success', status_match: 1, citation_recall: null }, reference: { outcome: 'success', status_match: 1, citation_recall: null } }],
}
function mount(onExpired = vi.fn()) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/ops/evaluations/:runId/report" element={<EvaluationReport onExpired={onExpired} />} /></Routes></MemoryRouter>)
}
beforeEach(() => {
  vi.mocked(getEvaluation).mockResolvedValue(run())
  vi.mocked(getRagMaterial).mockResolvedValue(material)
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('평가 보고서 해설', () => {
  it('실제 기록의 모델·질문을 표시하고 후보 단독 측정, 0점, 미측정을 구분한다', async () => {
    mount()
    expect(await screen.findByText(materialCase.question)).toBeTruthy()
    expect(screen.getByText('답변 모델: saved-model')).toBeTruthy()
    expect(screen.getByText(/실제 모델의 성능 개선으로 해석할 수 없습니다/)).toBeTruthy()
    const retrieval = within(screen.getByRole('article', { name: '근거 검색 재현율' }))
    expect(retrieval.getByText('100%')).toBeTruthy()
    expect(retrieval.getByText('1건 측정 / 대상 1건')).toBeTruthy()
    expect(retrieval.getByText('미측정')).toBeTruthy()
    expect(retrieval.getByText('0건 측정 / 대상 1건')).toBeTruthy()
    expect(within(screen.getByRole('article', { name: '답변 인용 재현율' })).getByText('0%')).toBeTruthy()
    fireEvent.click(screen.getByText(materialCase.question))
    expect(screen.getByText('저장된 후보 답변')).toBeTruthy()
    expect(screen.getByText('저장된 답변 없음')).toBeTruthy()
    expect(getEvaluation).toHaveBeenCalledOnce()
    expect(getRagMaterial).toHaveBeenCalledWith(id, expect.any(AbortSignal))
    expect(getEvaluationReview).not.toHaveBeenCalled()
  })

  it('원본은 내부 삽입하지 않고 기존 인증 URL의 새 탭으로 연결한다', async () => {
    mount()
    await screen.findByText(materialCase.question)
    expect(document.querySelector('iframe')).toBeNull()
    const link = screen.getByRole('link', { name: '원본 차트 새 탭에서 보기 ↗' })
    expect(link.getAttribute('href')).toBe(reportUrl)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('고정 답변 평가는 검색 평가와 구분하고 응답 시간·토큰을 퍼센트로 표시하지 않는다', async () => {
    vi.mocked(getEvaluation).mockResolvedValue(run(fixed))
    vi.mocked(getEvaluationReview).mockResolvedValue({ material: { data_type: 'synthetic', cases: [{ case_id: 'H01', question: '고정 질문', document_title: '가상 공고', expected_status: 'INSUFFICIENT_EVIDENCE', answer: '근거가 부족합니다.', reference_answer: '근거가 부족합니다.' }] } } as EvaluationReview)
    mount()
    await screen.findByText('고정 질문')
    expect(screen.getByText(/검색·임베딩 성능은 이 보고서에 포함되지 않습니다/)).toBeTruthy()
    expect(screen.getByText(/동일한 저장 기록끼리의 재현 확인/)).toBeTruthy()
    expect(within(screen.getByRole('article', { name: '평균 응답 시간' })).getAllByText('1,234.5 ms')).toHaveLength(2)
    expect(within(screen.getByRole('article', { name: '평균 입력 토큰' })).getAllByText('50 토큰')).toHaveLength(2)
    expect(within(screen.getByRole('article', { name: '의미 충실도' })).getAllByText('미측정')).toHaveLength(2)
    expect(getRagMaterial).not.toHaveBeenCalled()
  })

  it('자료 조회 실패를 지표와 구분하고 다시 조회할 수 있다', async () => {
    vi.mocked(getRagMaterial).mockRejectedValueOnce(new OpsApiError('저장 자료 무결성 확인 실패', 503))
    mount()
    expect((await screen.findByRole('alert')).textContent).toContain('질문·답변 조회 실패')
    expect(screen.getByRole('article', { name: '근거 검색 재현율' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '보고서 새로고침' }))
    expect(await screen.findByText(materialCase.question)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('미완료 실행에는 보고서를 노출하지 않고 비교 기록 없는 과거 실행에는 원본을 안내한다', async () => {
    vi.mocked(getEvaluation).mockResolvedValueOnce({ ...run(), status: 'FAILED', status_label: '실패' }).mockResolvedValueOnce(run(null))
    mount()
    await screen.findByText('아직 완료된 평가 보고서가 없습니다.')
    expect(screen.queryByRole('region', { name: '지표 해설' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Evidently 원본 차트' })).toBeNull()
    expect(getRagMaterial).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '보고서 새로고침' }))
    await screen.findByText(/비교 기록이 없습니다/)
    expect(screen.getByRole('link', { name: '원본 차트 새 탭에서 보기 ↗' })).toBeTruthy()
  })

  it.each([401, 403])('자료 조회의 인증 오류 %s는 기존 인증 흐름으로 돌린다', async (status) => {
    vi.mocked(getRagMaterial).mockRejectedValue(new OpsApiError('인증 실패', status))
    const expired = vi.fn(); mount(expired)
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
    expect(screen.queryByText(materialCase.question)).toBeNull()
  })

  it('조회 오류를 표시하고 페이지 이탈 후 지연 응답을 무시한다', async () => {
    vi.mocked(getEvaluation).mockRejectedValueOnce(new OpsApiError('실행 조회 실패', 503))
    let resolve!: (value: EvaluationRun) => void
    vi.mocked(getEvaluation).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const view = mount()
    expect((await screen.findByRole('alert')).textContent).toContain('실행 조회 실패')
    fireEvent.click(screen.getByRole('button', { name: '보고서 새로고침' }))
    const signal = vi.mocked(getEvaluation).mock.calls[1][1]
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => resolve(run()))
    expect(getRagMaterial).not.toHaveBeenCalled()
  })
})
