// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RagMaterial } from '../../../data/ops/opsApi'
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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('버튼을 누른 뒤에만 GET으로 고정 자료를 읽고 실패·미확인·빈 인용을 구분한다', async () => {
  const fetcher = vi.fn().mockResolvedValue(json(material))
  vi.stubGlobal('fetch', fetcher)
  const { container } = render(<RagMaterialPanel runId="run-a" onExpired={vi.fn()} />)
  expect(fetcher).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '검토 자료 보기' }))
  await screen.findByLabelText('검토 사례')
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/ops/evaluations/run-a/rag-material')
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  const candidate = within(screen.getByRole('article', { name: '후보 답변과 근거' }))
  const reference = within(screen.getByRole('article', { name: '비교 답변과 근거' }))
  expect(candidate.getByText('답변 실패 · timeout')).toBeTruthy()
  expect(candidate.getByText(/답변 입력 순서:/).closest('p')?.textContent).toContain('청크 2 → 청크 1')
  expect(candidate.getByText(/인용 근거:/).closest('p')?.textContent).toContain('미실행 또는 미확인')
  expect(reference.getByText(/인용 근거:/).closest('p')?.textContent).toBe('인용 근거: 없음')
  expect(screen.getByText(/후보: 검색됨 \/ 인용 미확인 · 비교: 검색됨 \/ 인용되지 않음/)).toBeTruthy()
  expect(screen.getByText('AI 작성 참조 조건 · 사람 검토 전')).toBeTruthy()
  expect(container.querySelector('script, img, a[href^="javascript:"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /저장|승인|판정|기준 지정/ })).toBeNull()
})

it('다른 사례를 선택하면 질문과 양쪽 근거를 함께 전환한다', async () => {
  const second = structuredClone(material.cases[0])
  second.case_id = 'R02'; second.question = '신청 기한은?'; second.content = '두 번째 원문'
  second.candidate = { ...second.candidate, retrieved_chunk_ids: null, context_chunk_ids: null, failure: { stage: 'search', code: 'unavailable' } }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...material, cases: [...material.cases, second] })))
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
    .mockResolvedValueOnce(json(material))
    .mockResolvedValueOnce(json({ ...material, baseline_eligible: true })))
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
  await act(async () => { resolve(json(material)) })
  expect(screen.queryByLabelText('검토 사례')).toBeNull()
  expect(screen.getByRole('button', { name: '검토 자료 보기' })).toHaveProperty('disabled', false)
  expect(fetcher).toHaveBeenCalledOnce()
})
