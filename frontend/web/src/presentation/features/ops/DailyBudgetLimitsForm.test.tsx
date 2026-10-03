// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setDailyBudgetLimits, type DailyBudget, type DailyBudgetLimitsInput } from '../../../data/ops/opsApi'
import { DailyBudgetLimitsForm } from './DailyBudgetLimitsForm'

const owner = 'core:81'
const at = '2026-10-03T00:00:00+09:00'
const daily: DailyBudget = {
  limits_revision: 'a'.repeat(64), state: 'disabled', timezone: 'Asia/Seoul',
  period_start: at, period_end: '2026-10-04T00:00:00+09:00', limits: null,
  allocated: null, current_day: null, carried: null, remaining: null, recent_changes: [],
}
const limits = { calls: 12, input_tokens: 400000, output_tokens: 24000 }
const session = { user: { id: owner, username: '관리자' }, csrf_token: 'daily-csrf', live_enabled: false, datasets: [] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const success = (value: DailyBudgetLimitsInput) => ({ change: {
  request_id: value.request_id, expected_revision: value.expected_revision, actor: owner, source: 'CORE_ADMIN', reason: value.reason, created_at: at,
  previous: value.disable ? { enabled: true, limits } : null,
  policy: { enabled: !value.disable, limits: value.disable ? limits : { calls: value.calls, input_tokens: value.input_tokens, output_tokens: value.output_tokens } },
} })
const mount = (value = daily) => {
  const props = { daily: value, owner, onSaved: vi.fn(), onExpired: vi.fn() }
  return { ...render(<DailyBudgetLimitsForm {...props} />), props }
}
const fill = () => {
  fireEvent.click(screen.getByRole('button', { name: '일별 한도 설정' }))
  fireEvent.change(screen.getByLabelText('일별 호출 한도'), { target: { value: '12' } })
  fireEvent.change(screen.getByLabelText('일별 입력 토큰 한도'), { target: { value: '400000' } })
  fireEvent.change(screen.getByLabelText('일별 출력 토큰 한도'), { target: { value: '24000' } })
  fireEvent.change(screen.getByLabelText('일별 한도 변경 사유'), { target: { value: ' 승인한 일별 한도 ' } })
}
const confirm = () => fireEvent.click(screen.getByRole('button', { name: '일별 변경 내용 확인' }))
const save = () => fireEvent.click(screen.getByRole('button', { name: '확인한 일별 정책 저장' }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('관리자 일별 한도 변경', () => {
  it('최종 확인 전에는 전송하지 않고 로그인 관리자·CSRF·조회 버전으로 저장한다', async () => {
    const fetch = vi.fn(async (url: string, options?: RequestInit) => json(url.endsWith('/session') ? session : success(JSON.parse(options!.body as string))))
    vi.stubGlobal('fetch', fetch)
    const { props } = mount()
    fill(); confirm()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText('일별 제한: 미적용 → 적용')).toBeTruthy()
    expect(screen.getByText('입력 토큰: 미설정 → 400,000')).toBeTruthy()
    save()
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/ops/budget/daily-limits')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-CSRFToken': 'daily-csrf' } })
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({ ...limits, expected_revision: daily.limits_revision, disable: false, reason: '승인한 일별 한도' })
  })

  it('해제는 누적 한도 유지 안내를 확인하고 정수 한도 없이 명시적으로 전송한다', async () => {
    const fetch = vi.fn(async (url: string, options?: RequestInit) => json(url.endsWith('/session') ? session : success(JSON.parse(options!.body as string))))
    vi.stubGlobal('fetch', fetch)
    const { props } = mount({ ...daily, state: 'enforced', limits })
    fill()
    fireEvent.change(screen.getByLabelText('일별 정책 변경'), { target: { value: 'disable' } })
    confirm()
    expect(screen.getByText(/일별 제한을 해제하면 누적 한도만 적용됩니다/)).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
    save()
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({ disable: true, calls: null, input_tokens: null, output_tokens: null })
  })

  it('응답 유실 뒤 조회 정책이 달라져도 원래 요청 UUID·조건으로만 재확인한다', async () => {
    const writes: DailyBudgetLimitsInput[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/session')) return json(session)
      const value = JSON.parse(options!.body as string) as DailyBudgetLimitsInput
      writes.push(value)
      if (writes.length === 1) throw new TypeError('응답 유실')
      return json(success(value))
    }))
    const view = mount()
    fill(); confirm(); save()
    await screen.findByRole('alert')
    view.rerender(<DailyBudgetLimitsForm {...view.props} daily={{ ...daily, limits_revision: 'b'.repeat(64) }} />)
    save()
    await waitFor(() => expect(view.props.onSaved).toHaveBeenCalledOnce())
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
  })

  it('저장 전 폴링에서 정책 변경을 발견하면 초안을 보존하고 전송을 차단한다', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const view = mount()
    fill(); confirm()
    view.rerender(<DailyBudgetLimitsForm {...view.props} daily={{ ...daily, limits_revision: 'b'.repeat(64) }} />)
    expect(screen.getByRole('alert').textContent).toContain('예산 새로고침')
    expect(screen.getByRole('button', { name: '확인한 일별 정책 저장' })).toHaveProperty('disabled', true)
    save()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('409 충돌은 확인 내용을 유지하고 재전송 대신 재조회를 요구한다', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/session') ? json(session) : json({ code: 'DAILY_BUDGET_CHANGE_CONFLICT', detail: '최신 정책을 다시 확인하세요.' }, 409))
    vi.stubGlobal('fetch', fetch)
    const { props } = mount()
    fill(); confirm(); save()
    await screen.findByText('최신 정책을 다시 확인하세요.')
    expect(screen.getByRole('button', { name: '확인한 일별 정책 저장' })).toHaveProperty('disabled', true)
    save()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(props.onSaved).not.toHaveBeenCalled()
    expect(screen.getByText('사유: 승인한 일별 한도')).toBeTruthy()
  })

  it.each([null, { id: 'core:82', username: '다른 관리자' }])('세션 만료·소유자 변경은 정책 전송 전에 중단한다: %j', async (user) => {
    const fetch = vi.fn().mockResolvedValue(json({ ...session, user })); vi.stubGlobal('fetch', fetch)
    const { props } = mount()
    fill(); confirm(); save()
    await waitFor(() => expect(props.onExpired).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledOnce()
    expect(props.onSaved).not.toHaveBeenCalled()
  })

  it.each(['-1', '1.5', '9007199254740992'])('잘못된 한도 %s는 확인 단계에서 거절한다', (value) => {
    mount(); fill()
    fireEvent.change(screen.getByLabelText('일별 입력 토큰 한도'), { target: { value } })
    confirm()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '확인한 일별 정책 저장' })).toBeNull()
  })

  it('버전 없는 구형 응답에는 변경 버튼을 제공하지 않는다', () => {
    mount({ ...daily, limits_revision: undefined })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([{ source: 'CLI' }, { actor: 'core:82' }, { expected_revision: 'b'.repeat(64) }, { request_id: '20000000-0000-4000-8000-000000000002' }, { policy: { enabled: false, limits } }])('다른 요청·정책·변경자의 응답을 성공으로 받지 않는다: %j', async (change) => {
    const value: DailyBudgetLimitsInput = { request_id: '10000000-0000-4000-8000-000000000001', expected_revision: daily.limits_revision!, reason: '검토', disable: false, ...limits }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/session') ? session : { change: { ...success(value).change, ...change } })))
    await expect(setDailyBudgetLimits(value, owner)).rejects.toThrow()
  })
})
