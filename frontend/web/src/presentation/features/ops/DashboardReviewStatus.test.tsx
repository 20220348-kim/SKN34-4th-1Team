// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { getDashboardReviewStatus } from '../../../data/ops/opsApi'
import type { DashboardReviewStatus as Status } from '../../../data/ops/opsApi'
import { DashboardReviewStatus } from './DashboardReviewStatus'

const id = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const data = (runId = id): Status => ({
  run_id: runId, checked_at: '2026-10-07T03:00:00Z',
  review: { cases: { total: 6, suitable: 0, unsuitable: 0, deferred: 0, stale: 0, unreviewed: 6 },
    reference_approved: false, approval: 'pending', quality: 'NOT_EVALUATED' },
  baseline: { status: 'none', run_id: null, version: 0 },
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const view = (runId = id, onExpired = vi.fn(), refresh = 0) => <MemoryRouter><DashboardReviewStatus key={`${runId}:${refresh}`} runId={runId} onExpired={onExpired} /></MemoryRouter>
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('대시보드 사람 검토 상태', () => {
  it('자동 점수 대신 실제 미검토·미판정·미지정을 구분하며 GET만 사용한다', async () => {
    const fetch = vi.fn(async () => json(data())); vi.stubGlobal('fetch', fetch)
    render(view())
    expect(await screen.findByText('미판정')).toBeTruthy()
    expect(screen.getByText('미지정')).toBeTruthy()
    expect(screen.getByText(/미검토 6건/)).toBeTruthy()
    expect(screen.getByText('참조 자료 승인 필요 · 답변 전체 승인 필요')).toBeTruthy()
    expect(screen.getByRole('link', { name: '검토 이어가기 →' }).getAttribute('href')).toBe(`/ops/evaluations/${id}`)
    expect(fetch).toHaveBeenCalledWith(`/api/v1/ops/dashboard/runs/${id}/review-status`, expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }))
    expect(fetch.mock.calls.every((args) => !(args as unknown as [string, RequestInit])[1]?.method)).toBe(true)
  })

  it('최신 실행과 다른 활성 기준의 링크를 정확히 분리한다', async () => {
    const value = data()
    value.review = { ...value.review, cases: { ...value.review.cases, suitable: 6, unreviewed: 0 }, reference_approved: true, approval: 'approved', quality: 'PASS' }
    value.baseline = { status: 'active', run_id: other, version: 3 }
    vi.stubGlobal('fetch', vi.fn(async () => json(value)))
    render(view())
    expect(await screen.findByText('다른 실행이 기준')).toBeTruthy()
    expect(screen.getByText('합격')).toBeTruthy()
    expect(screen.getByRole('link', { name: '기준 실행 확인 →' }).getAttribute('href')).toBe(`/ops/evaluations/${other}`)
    expect(screen.getByRole('link', { name: '검토 기록 보기 →' }).getAttribute('href')).toBe(`/ops/evaluations/${id}`)
  })

  it('RAG의 재검토·보류와 과거 합격의 만료를 현재 승인으로 표시하지 않는다', async () => {
    const value = data()
    value.review.cases = { total: 6, suitable: 2, unsuitable: 1, deferred: 1, stale: 2, unreviewed: 0 }
    value.review.approval = 'not_required'; value.review.quality = 'STALE'
    value.baseline = { status: 'needs_review', run_id: id, version: 1 }
    vi.stubGlobal('fetch', vi.fn(async () => json(value)))
    render(view())
    expect(await screen.findByText('재판정 필요')).toBeTruthy()
    expect(screen.getByText('기준 재검토 필요')).toBeTruthy()
    expect(screen.getByText(/자료 변경으로 재검토 2건/)).toBeTruthy()
    expect(screen.getByText(/RAG은 검색·답변·인용을 모두/)).toBeTruthy()
    expect(screen.queryByText(/답변 전체 승인/)).toBeNull()
    expect(screen.queryByText('합격')).toBeNull()
  })

  it('조회 실패를 미검토나 기준 없음으로 표시하지 않고 재시도한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(data())))
    render(view())
    expect((await screen.findByRole('alert')).textContent).toContain('승인 여부나 비교 기준을 판단할 수 없습니다')
    expect(screen.queryByText('미지정')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '검토 상태 다시 확인' }))
    expect(await screen.findByText('미판정')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('기준만 조회 불가인 경우 최신 실행의 검토와 구분한다', async () => {
    const value = data(); value.baseline = { status: 'unavailable', run_id: other, version: 1 }
    vi.stubGlobal('fetch', vi.fn(async () => json(value)))
    render(view())
    expect(await screen.findByText('기준 확인 불가')).toBeTruthy()
    expect(screen.getByText('미판정')).toBeTruthy()
    expect(screen.queryByText('미지정')).toBeNull()
  })

  it('선택 변경 시 이전 요청을 취소하고 늦은 승인 응답을 무시한다', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn((_path, _options) => new Promise<Response>((done) => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    const mounted = render(view())
    const first = resolve, signal = fetch.mock.calls[0][1].signal as AbortSignal
    mounted.rerender(view(other))
    expect(signal.aborted).toBe(true)
    const approved = data(); approved.review.quality = 'PASS'
    await act(async () => first(json(approved)))
    expect(screen.queryByText('합격')).toBeNull()
    await act(async () => resolve(json(data(other))))
    expect(screen.getByRole('link', { name: '검토 이어가기 →' }).getAttribute('href')).toBe(`/ops/evaluations/${other}`)
  })

  it('상단 새로고침에 해당하는 재조회 중 과거 승인 표시는 제거한다', async () => {
    const approved = data(); approved.review.quality = 'PASS'
    const fetch = vi.fn().mockResolvedValueOnce(json(approved)).mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetch)
    const mounted = render(view())
    await screen.findByText('합격')
    mounted.rerender(view(id, vi.fn(), 1))
    expect(screen.queryByText('합격')).toBeNull()
    expect(within(screen.getByRole('region')).getByRole('status')).toBeTruthy()
  })

  it.each([401, 403])('인증 오류 %s는 관리자 로그인 처리로 전달한다', async (status) => {
    const expired = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => json({}, status)))
    render(view(id, expired))
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
  })

  it('다른 실행 응답과 잘못된 검토 합계는 API 계약에서 거부한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(data(other))))
    await expect(getDashboardReviewStatus(id)).rejects.toThrow()
    const invalid = data(); invalid.review.cases.suitable = 6
    vi.stubGlobal('fetch', vi.fn(async () => json(invalid)))
    await expect(getDashboardReviewStatus(id)).rejects.toThrow()
  })
})
