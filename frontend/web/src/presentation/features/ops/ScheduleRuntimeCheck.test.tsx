// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleRuntimeCheck } from './ScheduleRuntimeCheck'

const runtime = {
  scope: 'deployment_configuration', storage_transport: 'http', status: 'PASS',
  checks: { evidence: 'PASS', results_directory: 'PASS', prefect_deployment: 'PASS', result_artifact: 'NOT_CHECKED' },
  evaluation_executed: false, runner_liveness_verified: false, shared_volume_identity_verified: false, result_artifact_verified: false,
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const mount = (onExpired = vi.fn()) => render(<ScheduleRuntimeCheck onExpired={onExpired} />)
const check = () => fireEvent.click(screen.getByRole('button', { name: '연결 설정 점검' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('정기 실행 연결 설정 점검', () => {
  it('수동 버튼으로만 GET하고 통과를 실행 승인으로 표시하지 않는다', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(runtime)); vi.stubGlobal('fetch', fetch)
    mount()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getAllByText('미점검')).toHaveLength(3)
    expect(screen.getByText(/모델 API 키의 유효성/).textContent).toContain('실제 가동')
    check()
    expect((await screen.findByRole('status')).textContent).toContain('연결 설정 점검을 통과')
    expect(screen.getAllByText('통과')).toHaveLength(3)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/v1/ops/runtime', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }))
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body')
    expect(screen.getByText(/통과해도 유료 실행 활성화/)).toBeTruthy()
  })

  it('HTTP 503의 유효한 FAIL 진단은 오류로 숨기지 않고 실패 항목을 표시한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...runtime, status: 'FAIL', checks: { ...runtime.checks, prefect_deployment: 'FAIL' } }, 503)))
    mount(); check()
    expect((await screen.findByRole('status')).textContent).toContain('확인이 필요한 항목')
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('통과')).toBeTruthy()
    expect(within(rows[1]).getByText('통과')).toBeTruthy()
    expect(within(rows[2]).getByText('확인 필요')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    [{}, 200],
    [{ ...runtime, checks: {} }, 200],
    [{ ...runtime, checks: { ...runtime.checks, evidence: 'FAIL' } }, 200],
    [{ ...runtime, evaluation_executed: true }, 200],
    [{ ...runtime, runner_liveness_verified: true }, 200],
    [{ ...runtime, result_artifact_verified: true }, 200],
    [{ ...runtime, scope: 'evaluation_result' }, 200],
    [runtime, 503],
    [{ ...runtime, status: 'FAIL', checks: { ...runtime.checks, evidence: 'FAIL' } }, 200],
    [{ detail: '서비스 장애' }, 503],
  ])('유효하지 않거나 HTTP 상태와 불일치한 응답을 통과로 표시하지 않는다: %j / %s', async (body, status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(body, status)))
    mount(); check()
    expect((await screen.findByRole('alert')).textContent).toContain('점검 응답을 확인할 수 없습니다')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getAllByText('미점검')).toHaveLength(3)
  })

  it.each([401, 403])('관리자 인증 실패 %s를 상위 화면에 전달한다', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, status)))
    const expired = vi.fn(); mount(expired); check()
    await screen.findByRole('alert')
    expect(expired).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('새 점검 실패 시 이전 통과를 지우고 다시 시도할 수 있다', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(runtime)).mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(json(runtime))
    vi.stubGlobal('fetch', fetch)
    mount(); check(); await screen.findByRole('status')
    check(); await screen.findByRole('alert')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getAllByText('미점검')).toHaveLength(3)
    check(); await screen.findByRole('status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('조회 중 버튼을 막고 화면을 떠난 뒤 온 인증 실패는 처리하지 않는다', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const fetch = vi.fn<typeof globalThis.fetch>(() => pending); vi.stubGlobal('fetch', fetch)
    const expired = vi.fn(); const view = mount(expired); check()
    expect(screen.getByRole('button', { name: '점검 중…' }).hasAttribute('disabled')).toBe(true)
    view.unmount()
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => { resolve(json({}, 403)); await pending })
    expect(expired).not.toHaveBeenCalled()
  })
})
