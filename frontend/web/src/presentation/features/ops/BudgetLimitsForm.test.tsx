// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBudgetLimits, type BudgetLimitsInput, type BudgetSummary } from '../../../data/ops/opsApi'
import { BudgetLimitsForm } from './BudgetLimitsForm'

const at = '2026-10-03T01:00:00Z'
const owner = 'core:81'
const summary: BudgetSummary = {
  state: 'unconfigured', limits_revision: 'a'.repeat(64), limits: null, allocated: null,
  remaining: null, breakdown: null, reservation_count: 0, legacy_live_run_count: 2,
  change_count: 0, recent_changes: [],
}
const session = { user: { id: owner, username: '관리자' }, csrf_token: 'csrf-test', live_enabled: false, datasets: [] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const success = (data: BudgetLimitsInput) => ({ change: {
  request_id: data.request_id, actor: owner, source: 'CORE_ADMIN', reason: data.reason,
  previous_limits: null, limits: { calls: data.calls, output_tokens: data.output_tokens, input_tokens: data.input_tokens }, created_at: at,
} })
const mount = (onSaved = vi.fn(), onExpired = vi.fn(), data = summary) => {
  render(<BudgetLimitsForm summary={data} owner={owner} onSaved={onSaved} onExpired={onExpired} />)
  return { onSaved, onExpired }
}
const fill = () => {
  fireEvent.click(screen.getByRole('button', { name: '누적 한도 설정' }))
  fireEvent.change(screen.getByLabelText('호출 누적 한도'), { target: { value: '7' } })
  fireEvent.change(screen.getByLabelText('출력 토큰 누적 한도'), { target: { value: '776' } })
  fireEvent.change(screen.getByLabelText('한도 변경 사유'), { target: { value: ' 검토한 과거 사용량 한도 ' } })
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('관리자 누적 한도 변경', () => {
  it('변경 내용을 확인한 후에만 세션·CSRF와 한도 버전을 보내고 입력 미설정은 null로 보낸다', async () => {
    const fetch = vi.fn(async (url: string, options?: RequestInit) => json(url.endsWith('/session') ? session : success(JSON.parse(options!.body as string))))
    vi.stubGlobal('fetch', fetch)
    const { onSaved } = mount()
    fill()
    fireEvent.click(screen.getByRole('button', { name: '변경 내용 확인' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText('호출: 미설정 → 7회')).toBeTruthy()
    expect(screen.getByText('입력: 미설정 → 미설정')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '확인한 한도 저장' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const [url, options] = fetch.mock.calls[1]
    expect(url).toBe('/api/v1/ops/budget/limits')
    expect(options).toMatchObject({ method: 'POST', headers: { 'X-CSRFToken': 'csrf-test' } })
    expect(JSON.parse(options!.body as string)).toMatchObject({ calls: 7, output_tokens: 776, input_tokens: null, expected_revision: summary.limits_revision, reason: '검토한 과거 사용량 한도' })
  })

  it('응답 유실 후 재시도는 같은 요청 ID와 조회 버전을 유지한다', async () => {
    const writes: BudgetLimitsInput[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/session')) return json(session)
      const data = JSON.parse(options!.body as string) as BudgetLimitsInput
      writes.push(data)
      if (writes.length === 1) throw new TypeError('응답 유실')
      return json(success(data))
    }))
    const { onSaved } = mount()
    fill(); fireEvent.click(screen.getByRole('button', { name: '변경 내용 확인' }))
    fireEvent.click(screen.getByRole('button', { name: '확인한 한도 저장' }))
    await screen.findByRole('alert')
    expect(onSaved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '확인한 한도 저장' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
  })

  it('다른 관리자가 먼저 수정한 한도는 자동으로 덮어쓰지 않고 재검토를 안내한다', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/session') ? json(session) : json({ code: 'BUDGET_CHANGE_CONFLICT', detail: '최신 한도를 조회하고 다시 검토하세요.' }, 409))
    vi.stubGlobal('fetch', fetch)
    const { onSaved } = mount()
    fill(); fireEvent.click(screen.getByRole('button', { name: '변경 내용 확인' }))
    fireEvent.click(screen.getByRole('button', { name: '확인한 한도 저장' }))
    expect((await screen.findByRole('alert')).textContent).toContain('최신 한도를 조회하고 다시 검토하세요.')
    expect(onSaved).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([null, { id: 'core:82', username: '다른 관리자' }])('검토 도중 세션 소유자가 변경되면 저장하지 않는다: %j', async (user) => {
    const fetch = vi.fn().mockResolvedValue(json({ ...session, user }))
    vi.stubGlobal('fetch', fetch)
    const { onSaved, onExpired } = mount()
    fill(); fireEvent.click(screen.getByRole('button', { name: '변경 내용 확인' }))
    fireEvent.click(screen.getByRole('button', { name: '확인한 한도 저장' }))
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['-1', '1.2', '9007199254740992'])('잘못된 정수 한도 %s는 저장 확인으로 진행하지 않는다', (calls) => {
    mount(); fill()
    fireEvent.change(screen.getByLabelText('호출 누적 한도'), { target: { value: calls } })
    fireEvent.click(screen.getByRole('button', { name: '변경 내용 확인' }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '확인한 한도 저장' })).toBeNull()
  })

  it('한도 버전이 없는 구형 서버와 불일치 장부에서는 수정할 수 없다', () => {
    const { unmount } = render(<BudgetLimitsForm summary={{ ...summary, limits_revision: undefined }} owner={owner} onSaved={vi.fn()} onExpired={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    unmount(); mount(vi.fn(), vi.fn(), { ...summary, state: 'inconsistent' })
    expect((screen.getByRole('button', { name: '누적 한도 설정' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([{ source: 'CLI' }, { actor: 'core:82' }, { request_id: '20000000-0000-4000-8000-000000000002' }, { limits: { calls: 999, output_tokens: 776, input_tokens: null } }])('다른 요청이나 인증되지 않은 이력을 저장 성공으로 표시하지 않는다: %j', async (changes) => {
    const data: BudgetLimitsInput = { request_id: '10000000-0000-4000-8000-000000000001', expected_revision: summary.limits_revision!, calls: 7, output_tokens: 776, input_tokens: null, reason: '검토' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/session') ? session : { change: { ...success(data).change, ...changes } })))
    await expect(setBudgetLimits(data, owner)).rejects.toThrow()
  })
})
