// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationSchedule, ScheduleInput } from '../../../data/ops/opsApi'
import { EvaluationSchedulesPanel } from './EvaluationSchedulesPanel'

const owner = 'core:81'
const id = '10000000-0000-4000-8000-000000000001'
const at = '2026-10-03T00:00:00Z'
const config = { model: 'gpt-6-luna', fixture_sha256: 'a'.repeat(64), max_model_calls: 1, max_input_tokens: 32768, max_output_tokens: 2000 }
const dataset = { id: 'fixed-context-e01-v1', label: '공통 E01', case_ids: ['E01'], evaluation_scope: 'fixed-answer-context-only', fixture: 'fixture.json',
  captures: [{ id: 'capture', label: '기록' }], baseline: { id: `run:${id}`, label: '검토 기준', version: 3 }, live_config: config, execution_profiles: { replay: 'b'.repeat(64), live: 'c'.repeat(64) } }
const capacity = { calls: 1, input_tokens: 32768, output_tokens: 2000 }
const remaining = { calls: 10, input_tokens: 327680, output_tokens: 20000 }
const readiness = { as_of: at, dataset_id: dataset.id, execution_profile: dataset.execution_profiles.live, evaluation_scope: dataset.evaluation_scope,
  model: config.model, state: 'checked', required: capacity, remaining, blockers: [], warnings: [],
  daily: { limits_revision: 'd'.repeat(64), state: 'enforced', timezone: 'Asia/Seoul', period_start: '2026-10-03T00:00:00+09:00', period_end: '2026-10-04T00:00:00+09:00',
    limits: remaining, allocated: { calls: 0, input_tokens: 0, output_tokens: 0 }, current_day: { calls: 0, input_tokens: 0, output_tokens: 0 }, carried: { calls: 0, input_tokens: 0, output_tokens: 0 }, remaining, recent_changes: [] } }
const result = (input: ScheduleInput): EvaluationSchedule => ({ id: input.request_id, dataset_id: input.dataset_id, requested_by: owner,
  request: { dataset_id: input.dataset_id, reference_capture_id: input.reference_capture_id, baseline_version: input.baseline_version,
    execution_profile: input.execution_profile, live_config: config, confirm_paid_run: true, execution_mode: 'live', candidate_capture_id: 'new-model-response' },
  max_usage: capacity, daily_at: input.daily_at, starts_on: input.starts_on, ends_on: input.ends_on, reason: input.reason,
  created_at: at, state: 'active', paused_at: null, paused_by: null, pause_reason: '', occurrences: [] })
const initial = { request_id: id, dataset_id: dataset.id, reference_capture_id: `run:${id}`, baseline_version: 3, execution_profile: dataset.execution_profiles.live,
  live_config: config, confirm_paid_run: true as const, daily_at: '09:00', starts_on: '2026-10-03', ends_on: '2026-10-05', reason: '3일 승인' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const session = { user: { id: owner, username: '관리자' }, csrf_token: 'schedule-csrf', live_enabled: true, datasets: [dataset] }
const mount = () => {
  const onExpired = vi.fn()
  render(<MemoryRouter><EvaluationSchedulesPanel owner={owner} datasets={[dataset]} onExpired={onExpired} refreshKey={0} /></MemoryRouter>)
  return onExpired
}
const setup = ({ enabled = true, rows = [] as EvaluationSchedule[], write = async (input: ScheduleInput) => json(result(input)) } = {}) => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/session')) return json(session)
    if (url.includes('/live-readiness?')) return json(readiness)
    if (url.includes('/schedules?page=')) return json({ enabled, timezone: 'Asia/Seoul', page: 1, total: rows.length, results: rows })
    return write(JSON.parse(options!.body as string))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const fill = async () => {
  await screen.findByLabelText('정기 계획 승인 사유')
  fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-10-03' } })
  fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-10-05' } })
  fireEvent.change(screen.getByLabelText('정기 계획 승인 사유'), { target: { value: '3일 승인' } })
  fireEvent.click(screen.getByRole('checkbox'))
  await waitFor(() => expect((screen.getByRole('button', { name: '정기 계획 내용 확인' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '정기 계획 내용 확인' }))
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('일별 정기 평가 계획', () => {
  it('비활성 상태에서는 유료 승인 폼을 열지 않고 기존 계획을 표시한다', async () => {
    const fetch = setup({ enabled: false }); mount()
    await screen.findByText(/정기 접수가 비활성화/)
    expect(screen.queryByLabelText('정기 계획 승인 사유')).toBeNull()
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true)
  })
  it('기간 전체 상한을 확인한 뒤 관리자·CSRF·고정 기준으로만 저장한다', async () => {
    const fetch = setup(); mount(); await fill()
    expect(screen.getByText(/3일 전체 최대 3회/)).toBeTruthy()
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '확인한 정기 계획 저장' }))
    await screen.findByText(/정기 계획을 저장했습니다/)
    const writes = fetch.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toMatchObject({ headers: { 'X-CSRFToken': 'schedule-csrf' }, credentials: 'same-origin' })
    expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({ ...initial, request_id: expect.any(String) })
  })
  it('응답 유실 후 같은 UUID와 조건으로 재시도하고 폼 변경을 막는다', async () => {
    const writes: ScheduleInput[] = []
    setup({ write: async (input) => { writes.push(input); if (writes.length === 1) throw new TypeError('network'); return json(result(input)) } })
    mount(); await fill()
    fireEvent.click(screen.getByRole('button', { name: '확인한 정기 계획 저장' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: '정기 계획 수정' })).toBeNull()
    expect(screen.getByLabelText('정기 계획 승인 사유').closest('fieldset')!.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '확인한 정기 계획 저장' }))
    await screen.findByText(/정기 계획을 저장했습니다/)
    expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1])
  })
  it('활성 계획의 중지는 명시적 확인과 사유로 저장한다', async () => {
    const row = result(initial)
    const fetch = setup({ rows: [row], write: async (input) => json({ ...row, state: 'paused', paused_at: at, paused_by: owner, pause_reason: input.reason }) })
    mount()
    fireEvent.change(await screen.findByLabelText('공통 E01 계획 중지 사유'), { target: { value: '모델 변경으로 중지' } })
    fireEvent.click(screen.getByRole('button', { name: '계획 중지 내용 확인' }))
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '확인한 계획 중지' }))
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith(`/${id}/pause`))).toBe(true))
  })
  it('최종 전송 전에 수정하면 유료 실행 동의를 다시 받는다', async () => {
    const fetch = setup(); mount(); await fill()
    fireEvent.click(screen.getByRole('button', { name: '정기 계획 수정' }))
    expect(screen.queryByRole('region', { name: '정기 계획 최종 확인' })).toBeNull()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })
  it('계획 중지 후 대기 기록은 중지 사유를 표시하고 접수된 실행 링크는 유지한다', async () => {
    const row = result(initial)
    row.occurrences = [{ id, scheduled_on: '2026-10-03', status: 'PENDING', reason_code: '', run_id: null, run_status: null },
      { id: '20000000-0000-4000-8000-000000000002', scheduled_on: '2026-10-04', status: 'SUBMITTED', reason_code: '', run_id: id, run_status: 'QUEUED' }]
    const rows = [row]
    setup({ rows, write: async (input) => {
      rows[0] = { ...row, state: 'paused', paused_at: at, paused_by: owner, pause_reason: input.reason,
        occurrences: [{ ...row.occurrences[0], status: 'BLOCKED', reason_code: 'SCHEDULE_CLOSED' }, row.occurrences[1]] }
      return json(rows[0])
    } })
    mount()
    await screen.findByText(/접수 확인 중/)
    fireEvent.change(screen.getByLabelText('공통 E01 계획 중지 사유'), { target: { value: '배포 전 중지' } })
    fireEvent.click(screen.getByRole('button', { name: '계획 중지 내용 확인' }))
    fireEvent.click(screen.getByRole('button', { name: '확인한 계획 중지' }))
    await screen.findByText(/접수 차단: 계획이 중지되었거나 승인 기간이 끝났습니다/)
    expect(screen.queryByText(/접수 확인 중/)).toBeNull()
    expect(screen.getByRole('link', { name: '실행 보기 · QUEUED' }).getAttribute('href')).toBe(`/ops/evaluations/${id}`)
  })
  it('차단 사유와 접수된 실행 링크를 함께 보여준다', async () => {
    const row = result(initial)
    row.occurrences = [{ id, scheduled_on: '2026-10-03', status: 'BLOCKED', reason_code: 'PREVIOUS_RUN_UNFINISHED', run_id: null, run_status: null },
      { id: '20000000-0000-4000-8000-000000000002', scheduled_on: '2026-10-04', status: 'SUBMITTED', reason_code: '', run_id: id, run_status: 'COMPLETED' }]
    setup({ rows: [row] }); mount()
    await screen.findByText(/이 자료의 이전 실행이 아직 끝나지 않았습니다/)
    expect(screen.getByRole('link', { name: '실행 보기 · COMPLETED' }).getAttribute('href')).toBe(`/ops/evaluations/${id}`)
  })
  it('세션 만료는 기존 로그인 경로로 처리한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)))
    const expired = mount()
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
  })
})
