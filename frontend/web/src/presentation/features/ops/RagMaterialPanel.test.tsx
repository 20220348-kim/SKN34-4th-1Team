// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RagMaterial, RagReviewState } from '../../../data/ops/opsApi'
import { RagMaterialPanel } from './RagMaterialPanel'

const material: RagMaterial = {
  schema_version: 1, evaluation_scope: 'source-chunks-retrieval-answer',
  reference_source: 'ai-authored-not-human-reviewed', baseline_eligible: false,
  material_sha256: 'a'.repeat(64), fixture_sha256: 'b'.repeat(64),
  candidate_capture_sha256: 'c'.repeat(64), reference_capture_sha256: 'd'.repeat(64),
  candidate_measurement_kind: 'integration-stub-replay', reference_measurement_kind: 'synthetic-contract-check',
  cases: [{
    case_id: 'R01', question: '지원 대상은?', document_id: 'BIZINFO:TEST',
    source_url: 'javascript:alert(1)', content: '<script>원문</script>\n한글 공고', content_sha256: 'e'.repeat(64), chunk_version: 'v1',
    chunks: [{ id: 'chunk-a', order: 0, text: '청년 사업자' }, { id: 'chunk-b', order: 1, text: '신청 기한 없음' }],
    expected_status: 'ANSWERED', expected_evidence: [{ chunk_id: 'chunk-a', quote: '청년 사업자' }],
    candidate: { answer: null, answer_status: null, retrieved_chunk_ids: ['chunk-b', 'chunk-a'], context_chunk_ids: ['chunk-b', 'chunk-a'], cited_chunk_ids: null, trace_id: 'f'.repeat(32), failure: { stage: 'answer', code: 'timeout' } },
    reference: { answer: '<img src=x onerror=alert(1)> 근거가 부족합니다.', answer_status: 'INSUFFICIENT_EVIDENCE', retrieved_chunk_ids: ['chunk-a'], context_chunk_ids: ['chunk-a'], cited_chunk_ids: [], trace_id: null, failure: null },
  }],
}
const reviewState = (source = material): RagReviewState => ({
  material: source, reviewer_id: 'core:91', review_version: 0,
  reference_review: { rubric: { version: 'rag-reference-review-v1', scope: 'this-run-all-cases', description: '전체 사례의 원문과 기대 조건을 검토합니다.' }, fixture_sha256: source.fixture_sha256,
    case_ids: source.cases.map((item) => item.case_id), approved: false, current_id: null, can_revoke: false, history: [] },
  quality: { status: 'NOT_EVALUATED', is_current: false, current_id: null, input_sha256: '1'.repeat(64), baseline_eligible: false,
    policy: { definition: { version: 'rag-review-quality-v2', scope: 'source-chunks-retrieval-answer', pass_enabled: false, baseline_eligible: false, reference_review_supported: true }, code_sha256: '2'.repeat(64) }, history: [] },
  rubric: { version: 'rag-case-review-v1', criteria: [
    { key: 'retrieval', label: '검색 적합성', description: '질문에 맞는 근거 검색' },
    { key: 'answer', label: '답변 정확성', description: '원문과 일치하는 답변' },
    { key: 'citation', label: '인용 적합성', description: '주장을 뒷받침하는 인용' },
  ] }, case_reviews: [],
})
const session = { user: { id: 'core:91', username: 'reviewer@example.com' }, csrf_token: 'current-token', live_enabled: false, datasets: [] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('버튼을 누른 뒤에만 GET으로 고정 자료를 읽고 실패·미확인·빈 인용을 구분한다', async () => {
  const fetcher = vi.fn().mockResolvedValue(json(reviewState()))
  vi.stubGlobal('fetch', fetcher)
  const { container } = render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  expect(fetcher).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례')
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/ops/evaluations/run-a/rag-reviews')
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  const candidate = within(screen.getByRole('article', { name: '후보 답변과 근거' }))
  const reference = within(screen.getByRole('article', { name: '비교 답변과 근거' }))
  expect(candidate.getByText('답변 실패 · timeout')).toBeTruthy()
  expect(candidate.getByText(/답변 입력 순서:/).closest('p')?.textContent).toContain('청크 2 → 청크 1')
  expect(candidate.getByText(/인용 근거:/).closest('p')?.textContent).toContain('미실행 또는 미확인')
  expect(reference.getByText(/인용 근거:/).closest('p')?.textContent).toBe('인용 근거: 없음')
  expect(screen.getByText(/후보: 검색됨 \/ 인용 미확인 · 비교: 검색됨 \/ 인용되지 않음/)).toBeTruthy()
  expect(screen.getByText('AI 작성 참조 조건')).toBeTruthy()
  expect(container.querySelector('script, img, a[href^="javascript:"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /승인|판정|기준 지정/ })).toBeNull()
})

it('다른 사례를 선택하면 질문과 양쪽 근거를 함께 전환한다', async () => {
  const second = structuredClone(material.cases[0])
  second.case_id = 'R02'; second.question = '신청 기한은?'; second.content = '두 번째 원문'
  second.candidate = { ...second.candidate, retrieved_chunk_ids: null, context_chunk_ids: null, failure: { stage: 'search', code: 'unavailable' } }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(reviewState({ ...material, cases: [...material.cases, second] }))))
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  fireEvent.change(await screen.findByLabelText('검토 사례'), { target: { value: '1' } })
  expect(screen.getByText('검색 실패 · unavailable')).toBeTruthy()
  expect(screen.getByText('두 번째 원문')).toBeTruthy()
  expect(screen.getByText(/후보: 검색 미확인 \/ 인용 미확인 · 비교: 검색됨/)).toBeTruthy()
  expect(screen.queryByText('답변 실패 · timeout')).toBeNull()
})

it.each([401, 403])('인증 오류 %s이면 로그인 처리를 요청하고 자료를 표시하지 않는다', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ detail: 'denied' }, status)))
  const onExpired = vi.fn()
  render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' })) })
  expect(onExpired).toHaveBeenCalledOnce()
  expect(screen.queryByLabelText('검토 사례')).toBeNull()
})

it('손상된 자료 오류 뒤 재시도하고 새 응답 계약이 잘못되면 오래된 자료를 제거한다', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(json({ code: 'RESULTS_UNAVAILABLE' }, 503))
    .mockResolvedValueOnce(json(reviewState()))
    .mockResolvedValueOnce(json({ ...reviewState(), material: { ...material, baseline_eligible: true } })))
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  expect((await screen.findByRole('alert')).textContent).toContain('무결성을 확인할 수 없습니다')
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례')
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 새로고침' }))
  expect(screen.queryByLabelText('검토 사례')).toBeNull()
  expect((await screen.findByRole('alert')).textContent).toContain('운영 서버 응답을 확인할 수 없습니다')
})

it('실행 이동 시 이전 요청을 중단하고 늦은 응답을 새 실행 자료로 표시하지 않는다', async () => {
  let resolve!: (response: Response) => void
  const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  const onExpired = vi.fn()
  const view = render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal
  view.rerender(<RagMaterialPanel runId="run-b" onExpired={onExpired} />)
  expect(signal.aborted).toBe(true)
  await act(async () => { resolve(json(reviewState())) })
  expect(screen.queryByLabelText('검토 사례')).toBeNull()
  expect(screen.getByRole('button', { name: '검토 자료 보기' })).toHaveProperty('disabled', false)
  expect(fetcher).toHaveBeenCalledOnce()
})

function fillReview() {
  fireEvent.change(screen.getByRole('combobox', { name: '검색 적합성' }), { target: { value: 'UNSUITABLE' } })
  fireEvent.change(screen.getByLabelText('검토 근거'), { target: { value: '원문 조건을 찾지 못했고 답변은 미측정입니다.' } })
}

function savedState(): RagReviewState {
  return { ...reviewState(), quality: { ...reviewState().quality, input_sha256: '3'.repeat(64) }, review_version: 1, case_reviews: [{
    id: 1, case_id: 'R01', version: 1, retrieval_decision: 'UNSUITABLE', answer_decision: 'DEFERRED', citation_decision: 'DEFERRED',
    comment: '원문 조건을 찾지 못했고 답변은 미측정입니다.', material_sha256: material.material_sha256,
    fixture_sha256: material.fixture_sha256, candidate_capture_sha256: material.candidate_capture_sha256,
    reference_capture_sha256: material.reference_capture_sha256, execution_spec_sha256: 'e'.repeat(64),
    rubric_version: 'rag-case-review-v1', is_current: true, reviewed_by: 'reviewer@example.com', created_at: '2026-10-02T01:00:00Z',
  }] }
}

it('판단과 근거를 요구하고 미측정은 보류로 저장하며 최신 세션·CSRF·자료 버전을 전송한다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(savedState()))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  const save = await screen.findByRole('button', { name: '사례 검토 저장' })
  expect(save).toHaveProperty('disabled', true)
  for (const label of ['답변 정확성', '인용 적합성']) {
    const select = screen.getByRole('combobox', { name: label })
    expect(select).toHaveProperty('disabled', true)
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['판단 보류'])
  }
  fireEvent.change(screen.getByLabelText('검토 근거'), { target: { value: '원문 확인' } })
  expect(save).toHaveProperty('disabled', true)
  fillReview()
  expect(screen.getByLabelText('검토 사례')).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '검토 자료 새로고침' })).toHaveProperty('disabled', true)
  fireEvent.click(save)
  expect((await screen.findByRole('status')).textContent).toContain('사례 검토가 저장되었습니다')
  expect(screen.getByRole('article', { name: '검토 이력 1' }).textContent).toContain('검색: 부적합 · 답변: 판단 보류 · 인용: 판단 보류')
  expect(fetcher.mock.calls[1][0]).toBe('/api/v1/ops/session')
  expect(fetcher.mock.calls[2][1].headers['X-CSRFToken']).toBe('current-token')
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ case_id: 'R01', retrieval_decision: 'UNSUITABLE', answer_decision: 'DEFERRED', citation_decision: 'DEFERRED', comment: '원문 조건을 찾지 못했고 답변은 미측정입니다.', material_sha256: material.material_sha256, rubric_version: 'rag-case-review-v1', review_version: 0 })
  expect(screen.getByLabelText('검토 사례')).toHaveProperty('disabled', false)
  expect(screen.getByLabelText('검토 근거')).toHaveProperty('value', '')
  fireEvent.change(screen.getByLabelText('검토 근거'), { target: { value: '추가 검토 중' } })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('article', { name: '검토 이력 1' })).toBeTruthy()
})

it('측정된 답변도 적합을 미리 선택하지 않고 세 항목 모두 판단해야 저장한다', async () => {
  const source = structuredClone(material)
  source.cases[0].candidate.answer = '청년 사업자 대상입니다.'
  source.cases[0].candidate.cited_chunk_ids = ['chunk-a']
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(reviewState(source))))
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  const save = await screen.findByRole('button', { name: '사례 검토 저장' })
  fillReview()
  expect(save).toHaveProperty('disabled', true)
  for (const label of ['답변 정확성', '인용 적합성']) {
    const select = screen.getByRole('combobox', { name: label })
    expect(select).toHaveProperty('value', '')
    fireEvent.change(select, { target: { value: 'SUITABLE' } })
  }
  expect(save).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: '입력 취소' }))
  expect(save).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('검토 사례')).toHaveProperty('disabled', false)
})

it('충돌 시 입력을 보존하고 자동 재전송·버전 갱신 없이 취소 후 재조회를 요구한다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json({ code: 'REVIEW_CONFLICT' }, 409)).mockResolvedValueOnce(json(savedState()))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례'); fillReview()
  fireEvent.click(screen.getByRole('button', { name: '사례 검토 저장' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('검토 근거')).toHaveProperty('value', '원문 조건을 찾지 못했고 답변은 미측정입니다.')
  expect(screen.getByRole('button', { name: '사례 검토 저장' })).toHaveProperty('disabled', true)
  expect(fetcher).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('button', { name: '입력 취소' }))
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 새로고침' }))
  await screen.findByRole('article', { name: '검토 이력 1' })
  expect(screen.getByLabelText('검토 근거')).toHaveProperty('value', '')
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

it('응답 유실 후 같은 본문·버전으로 재시도하고 중복 클릭은 요청 하나만 만든다', async () => {
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(json(session)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례'); fillReview()
  fireEvent.click(screen.getByRole('button', { name: '사례 검토 저장' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '사례 검토 저장' }))
  fireEvent.submit(screen.getByLabelText('검토 근거').closest('form')!)
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5))
  expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[4][1].body)
  await act(async () => { resolve(json(savedState())) })
  expect(screen.getAllByRole('article', { name: '검토 이력 1' })).toHaveLength(1)
})

it('검토 중 계정이 바뀌면 POST 전에 중단한다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json({ ...session, user: { id: 'core:92', username: 'other@example.com' } }))
  vi.stubGlobal('fetch', fetcher)
  const onExpired = vi.fn()
  render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례'); fillReview()
  fireEvent.click(screen.getByRole('button', { name: '사례 검토 저장' }))
  await waitFor(() => expect(onExpired).toHaveBeenCalledOnce())
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('저장 중 실행 이동 후 늦은 응답은 새 실행에 표시하지 않는다', async () => {
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  const onExpired = vi.fn()
  const view = render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례'); fillReview()
  fireEvent.click(screen.getByRole('button', { name: '사례 검토 저장' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  view.rerender(<RagMaterialPanel runId="run-b" onExpired={onExpired} />)
  await act(async () => { resolve(json(savedState())) })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('article', { name: '검토 이력 1' })).toBeNull()
  expect(screen.getByRole('button', { name: '검토 자료 보기' })).toHaveProperty('disabled', false)
})

function assessedState(status: 'NEEDS_REVIEW' | 'FAIL' = 'NEEDS_REVIEW'): RagReviewState {
  const state = reviewState()
  state.quality = { ...state.quality, status, is_current: true, current_id: 7, history: [{
    id: 7, status, policy: state.quality.policy, policy_sha256: '4'.repeat(64), input_sha256: state.quality.input_sha256,
    inputs: { review_version: 0 }, assessed_by: 'reviewer@example.com', created_at: '2026-10-02T03:00:00Z',
    reasons: [
      { code: 'REFERENCE_REVIEW_REQUIRED', case_id: null, dimension: null, message: '참조 조건의 사람 검토 승인이 필요합니다.' },
      { code: 'NOT_MEASURED', case_id: 'R01', dimension: 'answer', message: '미측정입니다.' },
    ],
  }] }
  return state
}

it('품질 점검을 명시적으로 요청하고 저장 중 사례 입력·갱신과 중복 클릭을 막는다', async () => {
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  const save = await screen.findByRole('button', { name: '현재 검토로 품질 점검 저장' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('검토 근거'), { target: { value: '미저장 초안' } })
  expect(save).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '입력 취소' }))
  fireEvent.click(save); fireEvent.click(save)
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  expect(screen.getByLabelText('검토 근거')).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('검토 사례')).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '검토 자료 새로고침' })).toHaveProperty('disabled', true)
  expect(fetcher.mock.calls[2][0]).toBe('/api/v1/ops/evaluations/run-a/rag-quality')
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ input_sha256: '1'.repeat(64) })
  expect(fetcher.mock.calls[2][1].headers['X-CSRFToken']).toBe('current-token')
  await act(async () => { resolve(json(assessedState())) })
  const panel = within(screen.getByRole('region', { name: 'RAG 품질 점검' }))
  expect(panel.getByRole('status').textContent).toContain('현재 판정: 검토 필요')
  expect(panel.getByRole('status').textContent).toContain('R01 · 답변: 미측정입니다.')
  expect(panel.getByText('RAG 품질 점검 이력 · 1건')).toBeTruthy()
  expect(screen.getByLabelText('검토 근거')).toHaveProperty('disabled', false)
})

it('사례 검토 변경 뒤 과거 판정을 현재 상태로 보여주지 않는다', async () => {
  const changed = savedState()
  changed.quality.history = assessedState().quality.history
  const fetcher = vi.fn().mockResolvedValueOnce(json(assessedState())).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(changed))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례'); fillReview()
  fireEvent.click(screen.getByRole('button', { name: '사례 검토 저장' }))
  await screen.findByText('자료·정책·검토가 변경되어 다시 점검해야 합니다. 이전 판정은 이력으로 보존됩니다.')
  const panel = within(screen.getByRole('region', { name: 'RAG 품질 점검' }))
  expect(panel.queryByRole('status')).toBeNull()
  expect(panel.getByText('RAG 품질 점검 · 미판정')).toBeTruthy()
  expect(panel.getByText('RAG 품질 점검 이력 · 1건')).toBeTruthy()
})

it('품질 충돌은 자동 갱신·재전송 없이 자료를 재조회해야 해제된다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json({ code: 'REVIEW_CONFLICT' }, 409)).mockResolvedValueOnce(json(savedState()))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  fireEvent.click(await screen.findByRole('button', { name: '현재 검토로 품질 점검 저장' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: '현재 검토로 품질 점검 저장' })).toHaveProperty('disabled', true)
  expect(fetcher).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 새로고침' }))
  expect(await screen.findByRole('button', { name: '현재 검토로 품질 점검 저장' })).toHaveProperty('disabled', false)
})

it('품질 응답 유실은 같은 근거 해시로 재시도한다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(assessedState()))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  fireEvent.click(await screen.findByRole('button', { name: '현재 검토로 품질 점검 저장' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '현재 검토로 품질 점검 저장' }))
  await screen.findByRole('status')
  expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[4][1].body)
})

it('품질 저장 전에 계정이 바뀌면 요청을 중단한다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json({ ...session, user: { id: 'core:92', username: 'other' } }))
  vi.stubGlobal('fetch', fetcher)
  const onExpired = vi.fn()
  render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  fireEvent.click(await screen.findByRole('button', { name: '현재 검토로 품질 점검 저장' }))
  await waitFor(() => expect(onExpired).toHaveBeenCalledOnce())
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('다른 실행으로 이동하면 이전 품질 저장 응답을 무시한다', async () => {
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  const onExpired = vi.fn()
  const view = render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  fireEvent.click(await screen.findByRole('button', { name: '현재 검토로 품질 점검 저장' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  view.rerender(<RagMaterialPanel runId="run-b" onExpired={onExpired} />)
  await act(async () => { resolve(json(assessedState())) })
  expect(screen.queryByRole('region', { name: 'RAG 품질 점검' })).toBeNull()
})

it('현재 RAG 정책에 없는 합격 응답은 거절한다', async () => {
  const state = assessedState()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...state, quality: { ...state.quality, status: 'PASS' } })))
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  expect((await screen.findByRole('alert')).textContent).toContain('운영 서버 응답을 확인할 수 없습니다.')
  expect(screen.queryByRole('region', { name: 'RAG 품질 점검' })).toBeNull()
})

function referenceState(decision: 'APPROVED' | 'REVOKED' = 'APPROVED', source = material): RagReviewState {
  const state = reviewState(source)
  const approved = decision === 'APPROVED'
  state.review_version = approved ? 1 : 2
  const first = { id: 41, version: 1, decision: 'APPROVED' as const, comment: '전체 원문과 기대 조건 대조 완료', fixture_sha256: source.fixture_sha256,
    case_ids: state.reference_review.case_ids, rubric_version: state.reference_review.rubric.version, execution_spec_sha256: 'e'.repeat(64),
    revoked_review_id: null, reviewed_by: 'reviewer@example.com', created_at: '2026-10-02T03:00:00Z', is_current: approved }
  state.reference_review = { ...state.reference_review, approved, can_revoke: approved, current_id: approved ? 41 : 42,
    history: approved ? [first] : [{ ...first, id: 42, version: 2, decision: 'REVOKED', revoked_review_id: 41, comment: '기대 인용 오류 발견', is_current: true }, first] }
  state.quality.input_sha256 = (approved ? '6' : '7').repeat(64)
  return state
}
const referenceConfirmation = '전체 대상의 원문·청크·질문·기대 상태·기대 인용을 확인했습니다.'
function fillReference(decision = 'APPROVED') {
  fireEvent.change(screen.getByLabelText('참조 자료 판단'), { target: { value: decision } })
  fireEvent.change(screen.getByLabelText('참조 검토 근거'), { target: { value: '전체 원문과 기대 조건 대조 완료' } })
  fireEvent.click(screen.getByRole('checkbox', { name: referenceConfirmation }))
}

it('참조 초안은 사례 전환을 허용하고 전체 확인·근거 뒤에만 최신 관리자 CSRF로 저장한다', async () => {
  const source = { ...material, cases: [...material.cases, { ...material.cases[0], case_id: 'R02', question: '두 번째 질문' }] }
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState(source))).mockResolvedValueOnce(json(session)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  const save = await screen.findByRole('button', { name: '참조 검토 저장' })
  expect(save).toHaveProperty('disabled', true)
  expect(screen.queryByRole('option', { name: '승인 철회' })).toBeNull()
  fireEvent.change(screen.getByLabelText('참조 자료 판단'), { target: { value: 'APPROVED' } })
  fireEvent.change(screen.getByLabelText('참조 검토 근거'), { target: { value: '전체 원문과 기대 조건 대조 완료' } })
  expect(save).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('검색 적합성')).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '현재 검토로 품질 점검 저장' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '검토 자료 새로고침' })).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('검토 사례')).toHaveProperty('disabled', false)
  fireEvent.change(screen.getByLabelText('검토 사례'), { target: { value: '1' } })
  expect(screen.getByLabelText('참조 검토 근거')).toHaveProperty('value', '전체 원문과 기대 조건 대조 완료')
  fireEvent.click(screen.getByRole('checkbox', { name: referenceConfirmation }))
  fireEvent.click(save)
  fireEvent.submit(screen.getByLabelText('참조 검토 근거').closest('form')!)
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  expect(screen.getByLabelText('검토 사례')).toHaveProperty('disabled', true)
  expect(fetcher.mock.calls[2][0]).toBe('/api/v1/ops/evaluations/run-a/rag-reference-review')
  expect(fetcher.mock.calls[2][1].headers['X-CSRFToken']).toBe('current-token')
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ decision: 'APPROVED', comment: '전체 원문과 기대 조건 대조 완료', confirmed_all_cases: true,
    case_ids: ['R01', 'R02'], fixture_sha256: source.fixture_sha256, rubric_version: 'rag-reference-review-v1', review_version: 0 })
  await act(async () => { resolve(json(referenceState('APPROVED', source))) })
  expect(screen.getByText('원문·참조 자료 검토 · 참조 자료 승인')).toBeTruthy()
  expect(screen.getByLabelText('참조 검토 근거')).toHaveProperty('value', '')
  expect(screen.getByRole('option', { name: '승인 철회' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '검토 자료 새로고침' })).toHaveProperty('disabled', false)
  expect(screen.getByLabelText('검토 사례')).toHaveProperty('value', '1')
})

it('후보 검토나 품질 저장 중 참조 판단을 바꿀 수 없다', async () => {
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례'); fillReview()
  expect(screen.getByLabelText('참조 자료 판단')).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '입력 취소' }))
  expect(screen.getByLabelText('참조 자료 판단')).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: '현재 검토로 품질 점검 저장' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  expect(screen.getByLabelText('참조 자료 판단')).toHaveProperty('disabled', true)
  await act(async () => { resolve(json(assessedState())) })
  expect(screen.getByLabelText('참조 자료 판단')).toHaveProperty('disabled', false)
})

it('참조 철회 이력·대상과 이전 v1 품질 이력을 보존하며 현재 판정은 미판정으로 표시한다', async () => {
  const before = referenceState()
  const legacy = assessedState().quality
  legacy.policy.definition = { ...legacy.policy.definition, version: 'rag-review-quality-v1', reference_review_supported: false }
  const after = referenceState('REVOKED')
  after.quality.history = legacy.history
  const fetcher = vi.fn().mockResolvedValueOnce(json(before)).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(after))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('참조 자료 판단'); fillReference('REVOKED')
  fireEvent.click(screen.getByRole('button', { name: '참조 검토 저장' }))
  await screen.findByText('원문·참조 자료 검토 · 승인 철회')
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ decision: 'REVOKED', review_version: 1 })
  const history = screen.getByRole('region', { name: 'RAG 참조 자료 검토' }).querySelector('details')!
  fireEvent.click(within(history).getByText('참조 검토 이력 · 2건'))
  expect(within(history).getByText('철회 대상 기록: #41')).toBeTruthy()
  expect(screen.getByRole('article', { name: '참조 검토 이력 1' })).toBeTruthy()
  expect(screen.getByText('RAG 품질 점검 · 미판정')).toBeTruthy()
  expect(screen.getByText(/자료·정책·검토가 변경되어 다시 점검/)).toBeTruthy()
  expect(screen.getByText('RAG 품질 점검 이력 · 1건')).toBeTruthy()
  expect(screen.queryByRole('option', { name: '승인 철회' })).toBeNull()
})

it('참조 저장 충돌 시 입력을 유지하고 취소·새로고침 전 자동 재전송하지 않는다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json({ code: 'REVIEW_CONFLICT' }, 409)).mockResolvedValueOnce(json(referenceState()))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('참조 자료 판단'); fillReference()
  fireEvent.click(screen.getByRole('button', { name: '참조 검토 저장' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('참조 검토 근거')).toHaveProperty('value', '전체 원문과 기대 조건 대조 완료')
  expect(screen.getByRole('button', { name: '참조 검토 저장' })).toHaveProperty('disabled', true)
  expect(fetcher).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('button', { name: '참조 입력 취소' }))
  expect(screen.getByLabelText('참조 자료 판단')).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 새로고침' }))
  expect(await screen.findByLabelText('참조 자료 판단')).toHaveProperty('disabled', false)
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

it('참조 저장 응답 유실 후 동일 본문·버전으로 재시도한다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(referenceState()))
  vi.stubGlobal('fetch', fetcher)
  render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('참조 자료 판단'); fillReference()
  fireEvent.click(screen.getByRole('button', { name: '참조 검토 저장' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '참조 검토 저장' }))
  await screen.findByText('원문·참조 자료 검토 · 참조 자료 승인')
  expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[4][1].body)
})

it('참조 저장 전 계정 변경은 POST를 차단한다', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json({ ...session, user: { id: 'core:92', username: 'other@example.com' } }))
  vi.stubGlobal('fetch', fetcher)
  const onExpired = vi.fn()
  render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('참조 자료 판단'); fillReference()
  fireEvent.click(screen.getByRole('button', { name: '참조 검토 저장' }))
  await waitFor(() => expect(onExpired).toHaveBeenCalledOnce())
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('다른 실행으로 이동하면 늦은 참조 저장 응답을 무시한다', async () => {
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(json(reviewState())).mockResolvedValueOnce(json(session)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  const onExpired = vi.fn()
  const view = render(<RagMaterialPanel runId="run-a" onExpired={onExpired} />)
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('참조 자료 판단'); fillReference()
  fireEvent.click(screen.getByRole('button', { name: '참조 검토 저장' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  view.rerender(<RagMaterialPanel runId="run-b" onExpired={onExpired} />)
  await act(async () => { resolve(json(referenceState())) })
  expect(screen.queryByRole('region', { name: 'RAG 참조 자료 검토' })).toBeNull()
  expect(screen.getByRole('button', { name: '검토 자료 보기' })).toHaveProperty('disabled', false)
})
