// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvaluationLogsPanel } from './EvaluationLogsPanel'

const runId = '10000000-0000-4000-8000-000000000001'
const flowId = '20000000-0000-4000-8000-000000000002'
const log = { id: '30000000-0000-4000-8000-000000000003', timestamp: '2026-10-13T00:00:00+00:00', level: 40, name: 'prefect.flow_runs', message: '평가 실패\n<script>alert(1)</script>' }
const page = { run_id: runId, prefect_flow_run_id: flowId, offset: 0, next_offset: null, results: [log] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const mount = (onExpired = vi.fn()) => render(<EvaluationLogsPanel runId={runId} flowId={flowId} onExpired={onExpired} />)
const load = () => fireEvent.click(screen.getByRole('button', { name: 'Prefect 실행 로그' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('관리자 실행 로그', () => {
  it('클릭 시 같은 origin으로 조회하고 로그의 HTML을 텍스트로 표시한다', async () => {
    const fetch = vi.fn(async () => json(page))
    vi.stubGlobal('fetch', fetch)
    const view = mount()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('link')).toBeNull()
    load()
    const list = await screen.findByRole('list', { name: '실행 로그 목록' })
    expect(list.textContent).toContain(log.message)
    expect(view.container.querySelector('script')).toBeNull()
    expect(fetch).toHaveBeenCalledWith(`/api/v1/ops/evaluations/${runId}/logs?offset=0`, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(screen.queryByRole('button', { name: '더 오래된 로그' })).toBeNull()
  })

  it('이전 로그 페이지를 조회하고 새로고침하면 최신 페이지로 돌아온다', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ ...page, next_offset: 100, results: Array.from({ length: 100 }, (_, index) => ({ ...log, id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}` })) }))
      .mockResolvedValueOnce(json({ ...page, offset: 100 }))
      .mockResolvedValueOnce(json(page))
    vi.stubGlobal('fetch', fetch)
    mount(); load()
    fireEvent.click(await screen.findByRole('button', { name: '더 오래된 로그' }))
    await screen.findByRole('button', { name: '이전 페이지' })
    expect(fetch.mock.calls[1][0]).toBe(`/api/v1/ops/evaluations/${runId}/logs?offset=100`)
    fireEvent.click(screen.getByRole('button', { name: '최신 로그 새로고침' }))
    await screen.findByRole('list')
    expect(fetch.mock.calls[2][0]).toBe(`/api/v1/ops/evaluations/${runId}/logs?offset=0`)
    expect(screen.queryByRole('button', { name: '이전 페이지' })).toBeNull()
  })

  it('빈 로그와 조회 장애를 구분하고 실패 시 이전 로그를 지운다', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json({ code: 'PREFECT_LOGS_UNAVAILABLE' }, 503))
      .mockResolvedValueOnce(json({ ...page, results: [] })))
    mount(); load(); await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '최신 로그 새로고침' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Prefect 실행 로그를 가져오지 못했습니다.')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText(/저장된 실행 로그가 없습니다/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '최신 로그 새로고침' }))
    await screen.findByText('이 페이지에 저장된 실행 로그가 없습니다.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([401, 403])('관리자 인증 만료 %s를 상위 화면에 전달한다', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, status)))
    const expired = vi.fn(); mount(expired); load()
    await act(async () => {})
    expect(expired).toHaveBeenCalledOnce()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it.each([{ run_id: flowId }, { prefect_flow_run_id: runId }, { offset: 100 }, { next_offset: 1 }])('다른 실행·페이지 응답을 표시하지 않는다: %j', async (changes) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...page, ...changes })))
    mount(); load()
    await screen.findByRole('alert')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('화면을 떠난 뒤 도착한 응답이나 인증 오류를 사용하지 않는다', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const fetch = vi.fn(() => pending); vi.stubGlobal('fetch', fetch)
    const expired = vi.fn(); const view = mount(expired); load(); view.unmount()
    await act(async () => { resolve(json({}, 401)); await pending })
    expect(expired).not.toHaveBeenCalled()
  })
})
