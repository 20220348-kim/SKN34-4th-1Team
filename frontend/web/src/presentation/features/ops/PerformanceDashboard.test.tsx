// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'
import { getPerformanceDashboard } from '../../../data/ops/opsApi'
import type { PerformanceDashboard as Dashboard, PerformancePoint } from '../../../data/ops/opsApi'
import { PerformanceDashboard } from './PerformanceDashboard'

// 검토 조회의 계약·오류·경쟁 응답은 DashboardReviewStatus.test.tsx에서 별도로 검증한다.
vi.mock('./DashboardReviewStatus', () => ({ DashboardReviewStatus: ({ runId }: { runId: string }) => <output aria-label="검토 대상 실행">{runId}</output> }))

const point = (id: string, measuredAt: string, value: number): PerformancePoint => ({
  run_id: id, source_run_id: null, mode: 'live', measured_at: measuredAt, evaluated_at: measuredAt,
  prompt_sha256: 'a'.repeat(64),
  values: { status: value, citation: 0, retrieval: null, latency: 1234, input_tokens: null, output_tokens: null },
  samples: { status: 6, citation: 2, retrieval: null, latency: null, input_tokens: null, output_tokens: null },
  coverage: { status: 'same-status-cases', citation: 'same-citation-cases', retrieval: null, latency: null, input_tokens: null, output_tokens: null },
})
const old = point('10000000-0000-4000-8000-000000000001', '2026-08-01T02:00:00Z', 1)
const latest = point('10000000-0000-4000-8000-000000000002', '2026-10-07T02:00:00Z', 0.5)
const data = (): Dashboard => ({
  as_of: '2026-10-07T03:00:00Z', configured_model: 'current-model',
  window: { limit: 200, loaded: 3, total: 3, truncated: false },
  states: { completed: 2, failed: 1, active: 0, cancelled: 0 },
  excluded: { replay: 1, incomplete: 0, unverifiable: 0, duplicate: 0 },
  series: [{ id: 'answer-series', dataset_id: 'answer', dataset_label: '공식 공고 답변 6건',
    model: 'current-model', scope: 'fixed-answer-context-only', fixture_sha256: 'b'.repeat(64),
    evaluator_version: 'c'.repeat(64), case_ids: ['H01', 'H02', 'H03', 'H04', 'H05', 'H06'], retrieval_k: null,
    points: [old, latest],
  }],
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function Location() { const location = useLocation(); return <output aria-label="현재 경로">{location.pathname}{location.search}</output> }
function mount(onExpired = vi.fn(), path = '/ops/dashboard') {
  return render(<MemoryRouter initialEntries={[path]}><PerformanceDashboard onExpired={onExpired} /><Location /></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('성능 대시보드', () => {
  it('실측 지표·퍼센트포인트 하락·표본과 상세 링크를 표시하며 조회만 한다', async () => {
    const fetch = vi.fn(async () => json(data())); vi.stubGlobal('fetch', fetch)
    mount()
    const cards = await screen.findByRole('region', { name: '최근 성능 지표' })
    expect(within(cards).getByText('50%')).toBeTruthy()
    expect(within(cards).getByText('이전 대비 −50%p')).toBeTruthy()
    expect(within(cards).getByText('0%')).toBeTruthy()
    expect(within(cards).getByText('2개 사례 측정 / 전체 6개')).toBeTruthy()
    expect(within(cards).getByText('미측정')).toBeTruthy()
    expect(screen.getByRole('link', { name: '최근 답변·검토 확인 →' }).getAttribute('href')).toBe(`/ops/evaluations/${latest.run_id}`)
    expect(screen.getByLabelText('검토 대상 실행').textContent).toBe(latest.run_id)
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('2회 중 2회 측정')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/v1/ops/dashboard', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(fetch.mock.calls.every((args) => !(args as unknown as [string, RequestInit])[1]?.method)).toBe(true)
  })

  it('모델 변경과 기간 선택을 URL에 보존하고 추가 실행을 하지 않는다', async () => {
    const payload = data()
    payload.series.push({ ...payload.series[0], id: 'other-series', model: 'older-model', points: [old] })
    const fetch = vi.fn(async () => json(payload)); vi.stubGlobal('fetch', fetch)
    mount()
    await screen.findByRole('region', { name: '최근 성능 지표' })
    fireEvent.change(screen.getByLabelText('측정 기간'), { target: { value: '30' } })
    expect(screen.getByText('측정 1회만 있어 변화 추이를 판단할 수 없습니다.')).toBeTruthy()
    expect(screen.getByLabelText('현재 경로').textContent).toContain('days=30')
    fireEvent.change(screen.getByLabelText('측정 모델'), { target: { value: 'older-model' } })
    expect(screen.getByRole('region', { name: '실측 없음' })).toBeTruthy()
    expect(screen.getByLabelText('현재 경로').textContent).toContain('model=older-model')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('다른 자료·채점 버전은 별도 선택하고 지표 없는 구간을 0으로 그리지 않는다', async () => {
    const payload = data()
    payload.series.push({ ...payload.series[0], id: 'rag-series', dataset_label: 'RAG 자료', scope: 'source-chunks-retrieval-answer',
      points: [{ ...latest, values: { ...latest.values, retrieval: 0.75 }, samples: { ...latest.samples, retrieval: 2 } }] })
    vi.stubGlobal('fetch', vi.fn(async () => json(payload)))
    mount()
    await screen.findByRole('region', { name: '최근 성능 지표' })
    fireEvent.click(screen.getByRole('button', { name: '근거 검색 재현율' }))
    expect(screen.getByText('이 지표는 측정되지 않았습니다.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('평가 자료 · 채점 버전'), { target: { value: 'rag-series' } })
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('근거 검색 재현율 추이, 1회')
    expect(screen.getByRole('table').textContent).toContain('75%')
    expect(screen.getByLabelText('현재 경로').textContent).toContain('series=rag-series')
  })

  it('측정한 사례가 다르면 차이와 연결선을 표시하지 않는다', async () => {
    const payload = data()
    payload.series[0].points[1] = { ...latest, coverage: { ...latest.coverage, status: 'different-cases' } }
    vi.stubGlobal('fetch', vi.fn(async () => json(payload)))
    mount()
    await screen.findByRole('region', { name: '최근 성능 지표' })
    expect(screen.queryByText('이전 대비 −50%p')).toBeNull()
    expect(screen.getByRole('img').querySelectorAll('line')).toHaveLength(3) // 축만 표시
  })

  it('실측이 없어도 구성 모델·집계 범위를 알리고 실행을 유도하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...data(), series: [], window: { limit: 200, loaded: 200, total: 400, truncated: true } })))
    mount()
    expect(await screen.findByRole('region', { name: '실측 없음' })).toBeTruthy()
    expect(screen.getByText(/최근 200건까지만 조회하므로/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: '최근 성능 지표' })).toBeNull()
  })

  it('새로고침 오류에는 마지막 결과를 남기고 재시도할 수 있다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(data())).mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(data())))
    mount()
    await screen.findByRole('region', { name: '최근 성능 지표' })
    fireEvent.click(screen.getByRole('button', { name: '지표 새로고침' }))
    expect((await screen.findByRole('alert')).textContent).toContain('마지막 조회 결과')
    expect(screen.getByRole('region', { name: '최근 성능 지표' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '지표 새로고침' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it.each([401, 403])('인증 오류 %s는 기존 로그인 처리를 사용한다', async (status) => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => json({}, status)))
    mount(expired)
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
  })

  it('페이지를 떠나면 조회를 취소하고 지연 응답을 무시한다', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn((_path, _options) => new Promise<Response>((done) => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    const view = mount()
    const signal = fetch.mock.calls[0][1].signal as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(json(data())))
    expect(screen.queryByRole('region', { name: '최근 성능 지표' })).toBeNull()
  })

  it('범위를 벗어난 지표는 API 계약에서 거부한다', async () => {
    const payload = data(); payload.series[0].points[0].values.status = 2
    vi.stubGlobal('fetch', vi.fn(async () => json(payload)))
    await expect(getPerformanceDashboard()).rejects.toThrow()
  })
})
