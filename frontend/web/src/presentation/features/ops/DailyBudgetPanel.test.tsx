// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBudgetReservations, getLiveReadiness, type DailyBudget } from '../../../data/ops/opsApi'
import { DailyBudgetPanel } from './DailyBudgetPanel'

const day: DailyBudget = {
  state: 'enforced', timezone: 'Asia/Seoul', period_start: '2026-10-04T00:00:00+09:00', period_end: '2026-10-05T00:00:00+09:00',
  limits: { calls: 12, input_tokens: 400000, output_tokens: 24000 },
  current_day: { calls: 6, input_tokens: 196608, output_tokens: 12000 },
  carried: { calls: 1, input_tokens: 32768, output_tokens: 2000 },
  allocated: { calls: 7, input_tokens: 229376, output_tokens: 14000 },
  remaining: { calls: 5, input_tokens: 170624, output_tokens: 10000 }, recent_changes: [],
}
const profile = 'a'.repeat(64)
const summary = {
  state: 'consistent', limits: { calls: 100, input_tokens: 1000000, output_tokens: 200000 },
  allocated: { calls: 7, input_tokens: 229376, output_tokens: 14000 },
  remaining: { calls: 93, input_tokens: 770624, output_tokens: 186000 }, breakdown: null,
  reservation_count: 1, legacy_live_run_count: 0, change_count: 0, recent_changes: [], daily: day,
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('일별 평가 예산', () => {
  it('서울 날짜와 오늘 접수·이월·잔여를 분리해서 표시한다', () => {
    render(<DailyBudgetPanel value={day} />)
    expect(screen.getByText(/2026-10-04 00:00/)).toBeTruthy()
    const row = screen.getByRole('row', { name: '입력 토큰 400,000 196,608 32,768 170,624' })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['400,000', '196,608', '32,768', '170,624'])
    expect(screen.getByText(/자정을 넘긴 예약은 새 호출을 승인하지 않습니다/)).toBeTruthy()
  })

  it.each(['unknown', 'exceeded'] as const)('미확인·초과 상태 %s를 잔여 0으로 표시하지 않는다', (state) => {
    render(<DailyBudgetPanel value={{ ...day, state, remaining: null, ...(state === 'unknown' ? { allocated: null, current_day: null, carried: null } : {}) }} />)
    expect(screen.getByRole('alert').textContent).toContain('신규 예약을 차단')
    expect(screen.getAllByText('확인 불가').length).toBeGreaterThanOrEqual(3)
  })

  it('구 서버 응답 누락과 일별 정책 미적용을 구분한다', () => {
    const view = render(<DailyBudgetPanel value={undefined} />)
    expect(screen.getByText('서버에서 일별 예산 정보를 제공하지 않습니다.')).toBeTruthy()
    view.rerender(<DailyBudgetPanel value={{ ...day, state: 'disabled', limits: null, remaining: null, allocated: null, current_day: null, carried: null }} />)
    expect(screen.getByText('일별 제한 미적용 · 누적 한도는 계속 적용됩니다.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('일별 응답을 기존 예산 조회에서 보존한다', async () => {
    const fetch = vi.fn(async () => json({ as_of: day.period_start, summary, count: 0, next: null, previous: null, results: [] }))
    vi.stubGlobal('fetch', fetch)
    expect((await getBudgetReservations(1)).summary.daily).toEqual(day)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { remaining: { ...day.remaining, calls: 6 } }, { carried: null }, { period_end: day.period_start },
    { state: 'disabled' }, { state: 'unknown' }, { state: 'enforced', limits: null },
    { state: 'enforced', remaining: null }, { state: 'exceeded', remaining: null },
  ])('모순된 일별 장부를 정상 잔여량으로 받지 않는다: %j', async (changes) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ as_of: day.period_start, summary: { ...summary, daily: { ...day, ...changes } }, count: 0, next: null, previous: null, results: [] })))
    await expect(getBudgetReservations(1)).rejects.toThrow()
  })

  it('누적 예산이 충분해도 일별 부족을 정상 점검으로 받지 않는다', async () => {
    const value = {
      as_of: day.period_start, dataset_id: 'fixed', execution_profile: profile, evaluation_scope: 'fixed-answer-context-only',
      model: 'test-model', state: 'checked', required: { calls: 6, input_tokens: 196608, output_tokens: 12000 },
      remaining: summary.remaining, blockers: [], warnings: [], daily: day,
    }
    vi.stubGlobal('fetch', vi.fn(async () => json(value)))
    await expect(getLiveReadiness('fixed', profile)).rejects.toThrow()
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...value, state: 'blocked', blockers: [{ code: 'DAILY_INSUFFICIENT_CALLS', message: '일별 호출 부족' }] })))
    expect((await getLiveReadiness('fixed', profile)).daily).toEqual(day)
  })
})
