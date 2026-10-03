// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { EvaluationReview } from '../../../data/ops/opsApi'
import { EvaluationReviewProgress } from './EvaluationReviewProgress'

afterEach(cleanup)
function state(): EvaluationReview {
  return {
    material: { fixture_sha256: 'fixture', capture_sha256: 'capture', cases: [{ case_id: 'E01', question: '대상?', document_title: '가상 공고', evidence: [], answer: '법인', answer_status: 'ANSWERED', cited_orders: [], reference_answer: '법인', expected_status: 'ANSWERED', expected_citation_orders: [], reference_facts: [], forbidden_claims: [] }] },
    material_error: '', is_baseline: false, baseline_requires_review: false, baseline_version: 0, baseline_history: [],
    review_version: 0, can_approve: false, approval_current: false, can_promote: false, case_reviews: [], reviews: [],
    rubric: { version: 'answer-v1', criteria: [] },
    quality: { status: 'NOT_EVALUATED', is_current: false, current_id: null, input_sha256: 'input', blocked_reason: '', policy: null,
      fixture_version: 0, fixture_rubric_version: 'fixture-v1', fixture_reviews: [], history: [] },
  }
}
function approvedFixture(data: EvaluationReview) {
  data.quality!.fixture_reviews = [{ id: 1, version: 1, decision: 'APPROVED', comment: '자료 확인', fixture_sha256: 'fixture', case_ids: ['E01'], rubric_version: 'fixture-v1', reviewed_by: 'admin', created_at: '2026-10-03T00:00:00Z' }]
  return data
}
function suitableCases(data: EvaluationReview) {
  data.can_approve = true
  data.case_reviews = [{ id: 1, version: 1, case_id: 'E01', decision: 'SUITABLE', comment: '답변 확인', capture_sha256: 'capture', fixture_sha256: 'fixture', rubric_version: 'answer-v1', reviewed_by: 'admin', created_at: '2026-10-03T00:00:00Z' }]
  return data
}
function show(data: EvaluationReview, hasDrafts = false, disabled = false) {
  const navigate = vi.fn()
  render(<EvaluationReviewProgress data={data} hasDrafts={hasDrafts} disabled={disabled} onNavigate={navigate} />)
  return navigate
}

it('미검토 상태의 다음 위치만 안내하며 이동 전에는 아무 동작도 하지 않는다', () => {
  const navigate = show(state())
  expect(screen.getByText('적합 0 / 1건')).toBeTruthy()
  expect(screen.getByText('확인할 사례: E01 (미검토)')).toBeTruthy()
  expect(navigate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '기준 자료 검토로 이동' }))
  expect(navigate).toHaveBeenCalledExactlyOnceWith('fixture-review')
})

it.each(['fixture_sha256', 'rubric_version', 'case_ids'] as const)('기준 자료 승인의 %s가 현재 자료와 다르면 재검토를 안내한다', (field) => {
  const data = approvedFixture(state())
  if (field === 'case_ids') data.quality!.fixture_reviews[0].case_ids = ['E02']
  else data.quality!.fixture_reviews[0][field] = 'old'
  show(data)
  expect(screen.getByText('재검토 필요')).toBeTruthy()
  expect(screen.getByRole('button', { name: '기준 자료 검토로 이동' })).toBeTruthy()
})

it.each(['CHANGES_REQUESTED', 'DEFERRED'] as const)('기준 자료 %s는 승인으로 표시하지 않는다', (decision) => {
  const data = approvedFixture(state())
  data.quality!.fixture_reviews[0].decision = decision
  show(data)
  expect(screen.queryByText('승인 완료')).toBeNull()
  expect(screen.getByRole('button', { name: '기준 자료 검토로 이동' })).toBeTruthy()
})

it.each(['capture_sha256', 'fixture_sha256', 'rubric_version'] as const)('사례 적합의 %s가 바뀌면 과거 적합 기록을 합산하지 않는다', (field) => {
  const data = suitableCases(approvedFixture(state()))
  data.case_reviews[0][field] = 'old'
  show(data)
  expect(screen.getByText('적합 0 / 1건')).toBeTruthy()
  expect(screen.getByText('확인할 사례: E01 (재검토 필요)')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'E01 사례 검토로 이동' })).toBeTruthy()
})

it.each(['UNSUITABLE', 'DEFERRED'] as const)('새 %s 판단 뒤에 남은 과거 적합 기록으로 진행하지 않는다', (decision) => {
  const data = suitableCases(approvedFixture(state()))
  data.case_reviews.unshift({ ...data.case_reviews[0], id: 2, version: 2, decision })
  show(data)
  expect(screen.getByText('적합 0 / 1건')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'E01 사례 검토로 이동' })).toBeTruthy()
})

it('자료·사례 검토 후 전체 승인, 유효한 품질 판정, 기준 지정을 순서대로 안내한다', () => {
  const data = suitableCases(approvedFixture(state()))
  const navigate = vi.fn()
  const view = render(<EvaluationReviewProgress data={data} hasDrafts={false} disabled={false} onNavigate={navigate} />)
  expect(screen.getByRole('button', { name: '전체 응답 승인으로 이동' })).toBeTruthy()
  data.approval_current = true
  view.rerender(<EvaluationReviewProgress data={data} hasDrafts={false} disabled={false} onNavigate={navigate} />)
  expect(screen.getByRole('button', { name: '품질 판정과 사유로 이동' })).toBeTruthy()
  data.quality!.status = 'PASS'; data.quality!.is_current = true; data.can_promote = true
  view.rerender(<EvaluationReviewProgress data={data} hasDrafts={false} disabled={false} onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', { name: '비교 기준 지정으로 이동' }))
  expect(navigate).toHaveBeenCalledExactlyOnceWith('overall-review')
  data.is_baseline = true
  view.rerender(<EvaluationReviewProgress data={data} hasDrafts={false} disabled={false} onNavigate={navigate} />)
  expect(screen.getByText('지정 완료')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it('기존 기준에 과거 합격이 있어도 최신 판정이 아니면 완료로 표시하지 않는다', () => {
  const data = suitableCases(approvedFixture(state()))
  data.is_baseline = true; data.baseline_requires_review = true; data.approval_current = true
  data.quality!.status = 'PASS'; data.quality!.is_current = false
  show(data)
  expect(screen.queryByText('지정 완료')).toBeNull()
  expect(screen.getByRole('button', { name: '품질 판정과 사유로 이동' })).toBeTruthy()
})

it('현재 불합격은 기준 지정 대신 판정 사유 확인으로 안내한다', () => {
  const data = suitableCases(approvedFixture(state()))
  data.approval_current = true; data.quality!.status = 'FAIL'; data.quality!.is_current = true
  show(data)
  expect(screen.getByText('불합격 · 근거 확인 필요')).toBeTruthy()
  expect(screen.getByRole('button', { name: '품질 판정과 사유로 이동' })).toBeTruthy()
})

it('저장하지 않은 사례 판단은 완료로 계산하거나 다음 단계를 안내하지 않는다', () => {
  show(approvedFixture(state()), true)
  expect(screen.getByText('적합 0 / 1건')).toBeTruthy()
  expect(screen.getByText(/저장하지 않은 사례 판단/)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it.each(['material', 'quality', 'input', 'empty', 'disabled'])('%s를 확인할 수 없으면 진행 완료를 추정하지 않는다', (missing) => {
  const data = suitableCases(approvedFixture(state()))
  if (missing === 'material') data.material = null
  if (missing === 'quality') data.quality = null
  if (missing === 'input') data.quality!.input_sha256 = null
  if (missing === 'empty') data.material!.cases = []
  show(data, false, missing === 'disabled')
  expect(screen.getByText(/현재 검토 자료와 판정 정보를 확인한 뒤/)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})
