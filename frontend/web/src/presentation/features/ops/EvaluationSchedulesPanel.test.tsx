// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationCatalog, EvaluationSchedule, ScheduleInput } from '../../../data/ops/opsApi'
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
const mount = (datasets: EvaluationCatalog['datasets'] = [dataset]) => {
  const onExpired = vi.fn()
  render(<MemoryRouter><EvaluationSchedulesPanel owner={owner} datasets={datasets} onExpired={onExpired} refreshKey={0} /></MemoryRouter>)
  return onExpired
}
const setup = ({ enabled = true, rows = [] as EvaluationSchedule[], readinessResult = readiness as unknown, write = async (input: ScheduleInput) => json(result(input)) } = {}) => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/session')) return json(session)
    if (url.includes('/live-readiness?')) return json(readinessResult)
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
  await waitFor(() => expect(screen.getByRole('checkbox')).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('checkbox'))
  await waitFor(() => expect((screen.getByRole('button', { name: '정기 계획 내용 확인' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '정기 계획 내용 확인' }))
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at)) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('일별 정기 평가 계획', () => {
  it('비활성 상태에도 설정 항목과 기존 계획·읽기 전용 점검을 표시하고 유료 승인은 막는다', async () => {
    const fetch = setup({ enabled: false, rows: [result(initial)] }); mount()
    await screen.findByText(/정기 접수: 비활성화/)
    await screen.findByRole('table', { name: '회당 최대량과 누적·일별 예산' })
    expect(screen.getByRole('list', { name: '정기 계획 설정 순서' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '정기 평가 자료', description: /매일 같은 질문·평가 조건/ })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '고정 모델', description: /다른 모델로 자동 전환되지는 않습니다/ })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '고정 비교 기준', description: /사람 검토를 거쳐 지정한 결과/ })).toBeTruthy()
    for (const [name, text] of [['매일 접수 시각 · 서울', '실제 실행·완료 시각을 보장하지 않습니다'], ['시작일', '시작일·종료일을 모두 포함해 최대 31일'], ['종료일', '같은 날짜면 1일']] as const) {
      const description = screen.getByLabelText(name).getAttribute('aria-describedby')!
      expect(document.getElementById(description)?.textContent).toContain(text)
    }
    expect(screen.getByRole('textbox', { name: '정기 계획 승인 사유', description: /무엇을 확인하려는지와 승인 범위/ })).toBeTruthy()
    fireEvent.click(screen.getByText('예산 표 읽는 법과 한도 설정 기준'))
    fireEvent.click(screen.getByText('등록된 계획과 날짜별 접수 기록 읽는 법'))
    expect(screen.getByText(/평가 1번이 API 호출 1회를 뜻하지는 않습니다/)).toBeTruthy()
    expect(screen.getByText(/차단된 날짜는 조건을 고쳐도 당일 자동 재접수하지 않습니다/)).toBeTruthy()
    expect(screen.getByLabelText('정기 계획 승인 사유').closest('fieldset')).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByLabelText('정기 계획 승인 사유'), { target: { value: '나중에 승인할 설정' } })
    expect(screen.getByLabelText('정기 계획 승인 사유')).toHaveProperty('value', '나중에 승인할 설정')
    expect(screen.getByLabelText('고정 모델')).toHaveProperty('readOnly', true)
    expect(screen.getByLabelText('고정 비교 기준')).toHaveProperty('readOnly', true)
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox', { description: /승인 기간에는 매번 다시 묻지 않고/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: '정기 계획 내용 확인' })).toHaveProperty('disabled', true)
    expect(screen.getByText('공통 E01 · 승인된 계획')).toBeTruthy()
    expect(screen.getByRole('link', { name: '예산 관리에서 한도 확인' }).getAttribute('href')).toBe('/ops/budget')
    expect(screen.getByRole('link', { name: '평가 이력에서 비교 기준 확인' }).getAttribute('href')).toBe('/ops/evaluations')
    expect(fetch.mock.calls.some(([url]) => url.includes('/live-readiness?'))).toBe(true)
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true)
  })
  it('비교 기준이 없는 자료도 선택해 부족 조건을 확인하며 등록하지 않는다', async () => {
    const missingBaseline = { ...dataset, id: 'fixed-context-e02-v1', label: '기준 미지정 자료', baseline: null }
    const fetch = vi.fn(async (url: string) => url.includes('/live-readiness?')
      ? json({ ...readiness, dataset_id: new URL(url, 'https://govbiz.test').searchParams.get('dataset_id') })
      : json({ enabled: true, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] }))
    vi.stubGlobal('fetch', fetch)
    mount([dataset, missingBaseline])
    await waitFor(() => expect(screen.getByRole('checkbox')).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByLabelText('정기 평가 자료'), { target: { value: missingBaseline.id } })
    await screen.findByText('설정·예산 점검: 조회 완료')
    expect(screen.getByText(/비교 기준: 미지정/)).toBeTruthy()
    expect(screen.getByLabelText('고정 비교 기준')).toHaveProperty('value', '미지정')
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(fetch.mock.calls.every(([url]) => !url.endsWith('/schedules'))).toBe(true)
  })
  it('자료가 없어도 입력 항목을 보여주고 이후 들어온 자료를 자동 선택한다', async () => {
    const fetch = setup({ enabled: false })
    const view = render(<MemoryRouter><EvaluationSchedulesPanel owner={owner} datasets={[]} onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    expect(screen.getByLabelText('정기 평가 자료')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('정기 계획 승인 사유')).toBeTruthy()
    expect(screen.getByText(/새 모델 평가 설정이 있는 자료가 없습니다/)).toBeTruthy()
    expect(fetch.mock.calls.some(([url]) => url.includes('/live-readiness?'))).toBe(false)
    view.rerender(<MemoryRouter><EvaluationSchedulesPanel owner={owner} datasets={[dataset]} onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    await screen.findByRole('table', { name: '회당 최대량과 누적·일별 예산' })
    expect(screen.getByLabelText('정기 평가 자료')).toHaveProperty('value', dataset.id)
  })
  it.each(['input', 'daily-disabled', 'daily-missing'] as const)('점검이 checked여도 정기 계획 필수 조건 %s가 없으면 승인을 차단한다', async (missing) => {
    const value = missing === 'input'
      ? { ...readiness, remaining: { ...remaining, input_tokens: null }, warnings: [{ code: 'INPUT_BUDGET_UNCONFIGURED', message: '누적 입력 토큰 한도가 설정되지 않았습니다.' }] }
      : { ...readiness, daily: missing === 'daily-missing' ? undefined : { ...readiness.daily, state: 'disabled', remaining: null, allocated: null, current_day: null, carried: null } }
    setup({ readinessResult: value }); mount()
    await screen.findByText('설정·예산 점검: 조회 완료')
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '정기 계획 내용 확인' })).toHaveProperty('disabled', true)
    if (missing === 'input') {
      expect(screen.getByText(/정기 계획에는 누적 입력 토큰 한도가 필수/)).toBeTruthy()
      expect(within(screen.getByRole('list', { name: '정기 계획 주의 사항' })).getByText('누적 입력 토큰 한도가 설정되지 않았습니다.')).toBeTruthy()
    } else expect(screen.getByText(/일별 예산:.*정기 계획에는 일별 한도/)).toBeTruthy()
  })
  it('누적·일별 부족량과 차단 사유를 분리하고 실제 0과 미설정을 구분한다', async () => {
    const dailyLeft = { calls: 0, input_tokens: 0, output_tokens: 0 }
    setup({ enabled: false, readinessResult: { ...readiness, state: 'blocked', remaining: { ...dailyLeft, input_tokens: null },
      daily: { ...readiness.daily, limits: dailyLeft, remaining: dailyLeft },
      blockers: [{ code: 'LIVE_DISABLED', message: '선택한 새 모델 평가가 비활성화되어 있습니다.' }],
      warnings: [{ code: 'INPUT_BUDGET_UNKNOWN', message: '미확인 과거 입력 사용량을 먼저 검토하세요.' }] } }); mount()
    const table = await screen.findByRole('table', { name: '회당 최대량과 누적·일별 예산' })
    const inputRow = within(table).getByRole('row', { name: '입력 토큰 32,768 확인 불가·미설정 0 0' })
    expect(within(inputRow).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['32,768', '확인 불가·미설정', '0', '0'])
    expect(screen.getByText('누적 호출 부족량: 1 · 회당 최대량 기준')).toBeTruthy()
    expect(screen.getByText('오늘 일별 입력 토큰 부족량: 32,768 · 회당 최대량 기준')).toBeTruthy()
    expect(within(screen.getByRole('list', { name: '정기 계획 차단 사유' })).getByText(/새 모델 평가가 비활성화/)).toBeTruthy()
    expect(within(screen.getByRole('list', { name: '정기 계획 주의 사항' })).getByText(/미확인 과거 입력/)).toBeTruthy()
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
  })
  it('새로고침 중·실패 후에는 이전 점검으로 승인하지 않고 GET 재조회만 수행한다', async () => {
    let finish!: (value: Response) => void
    const read = vi.fn().mockResolvedValueOnce(json(readiness)).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    const fetch = vi.fn(async (url: string) => url.includes('/live-readiness?') ? read() : json({ enabled: true, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] }))
    vi.stubGlobal('fetch', fetch); mount()
    await waitFor(() => expect(screen.getByRole('checkbox')).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '정기 계획 새로고침' }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
    expect(screen.queryByRole('table', { name: '회당 최대량과 누적·일별 예산' })).toBeNull()
    await act(async () => finish(json({ detail: '점검 서버 연결 실패' }, 503)))
    await screen.findByText('설정·예산 점검: 조회 실패')
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '정기 계획 내용 확인' })).toHaveProperty('disabled', true)
    expect(fetch.mock.calls.every(([url]) => url.includes('/live-readiness?') || url.includes('/schedules?page='))).toBe(true)
  })
  it.each(['dataset', 'profile'] as const)('%s 변경 뒤 늦게 도착한 이전 준비 상태를 폐기한다', async (changed) => {
    let finish!: (value: Response) => void
    let checks = 0
    const next = { ...dataset, id: changed === 'dataset' ? 'fixed-context-e02-v1' : dataset.id,
      execution_profiles: { ...dataset.execution_profiles, live: changed === 'profile' ? 'f'.repeat(64) : dataset.execution_profiles.live } }
    const fetch = vi.fn(async (url: string) => {
      if (!url.includes('/live-readiness?')) return json({ enabled: true, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] })
      checks += 1
      if (checks === 1) return new Promise<Response>((resolve) => { finish = resolve })
      return json({ ...readiness, dataset_id: next.id, execution_profile: next.execution_profiles.live, state: 'blocked', blockers: [{ code: 'LIVE_DISABLED', message: '변경된 설정은 평가 비활성 상태입니다.' }] })
    })
    vi.stubGlobal('fetch', fetch)
    const view = render(<MemoryRouter><EvaluationSchedulesPanel owner={owner} datasets={[dataset]} onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    await waitFor(() => expect(checks).toBe(1))
    view.rerender(<MemoryRouter><EvaluationSchedulesPanel owner={owner} datasets={[next]} onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    await screen.findByText('변경된 설정은 평가 비활성 상태입니다.')
    await act(async () => finish(json(readiness)))
    expect(screen.getByText('변경된 설정은 평가 비활성 상태입니다.')).toBeTruthy()
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('정기 평가 자료')).toHaveProperty('value', next.id)
  })
  it('정기 접수 상태 조회가 실패하면 예산 점검이 통과해도 승인하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/live-readiness?') ? json(readiness) : json({ detail: '조회 실패' }, 503)))
    mount()
    await screen.findByText(/정기 접수 상태 조회 실패:/)
    await screen.findByText('설정·예산 점검: 조회 완료')
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
  })
  it.each([['2026-10-02', '2026-10-03'], ['2026-11-03', '2026-11-03'], ['2026-10-03', '2026-11-03']])('잘못된 승인 기간 %s ~ %s는 확인을 막는다', async (start, end) => {
    setup(); mount()
    await waitFor(() => expect(screen.getByRole('checkbox')).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByLabelText('시작일'), { target: { value: start } })
    fireEvent.change(screen.getByLabelText('종료일'), { target: { value: end } })
    fireEvent.change(screen.getByLabelText('정기 계획 승인 사유'), { target: { value: '일정 준비' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: '정기 계획 내용 확인' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/오늘부터 30일 안에 시작하는 1~31일 기간/)).toBeTruthy()
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
  it('처음 전송하기 전 준비 조건이 바뀌면 최종 저장을 차단한다', async () => {
    const value = { ...readiness, blockers: [] as { code: string; message: string }[] }
    const fetch = setup({ readinessResult: value }); mount(); await fill()
    value.state = 'blocked'; value.blockers = [{ code: 'LIVE_DISABLED', message: '새 모델 평가 비활성화' }]
    fireEvent.click(screen.getByRole('button', { name: '정기 계획 새로고침' }))
    await screen.findByText('새 모델 평가 비활성화')
    expect(screen.getByRole('button', { name: '확인한 정기 계획 저장' })).toHaveProperty('disabled', true)
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })
  it('이미 전송한 승인 응답이 유실되면 이후 비활성화되어도 같은 UUID로 저장 여부를 재확인한다', async () => {
    const writes: ScheduleInput[] = []
    let enabled = true
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/session')) return json(session)
      if (url.includes('/live-readiness?')) return json(readiness)
      if (url.includes('/schedules?page=')) return json({ enabled, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] })
      const input = JSON.parse(options!.body as string) as ScheduleInput
      writes.push(input)
      if (writes.length === 1) { enabled = false; throw new TypeError('network') }
      return json(result(input))
    })
    vi.stubGlobal('fetch', fetch); mount(); await fill()
    fireEvent.click(screen.getByRole('button', { name: '확인한 정기 계획 저장' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '정기 계획 새로고침' }))
    await screen.findByText(/정기 접수: 비활성화/)
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '확인한 정기 계획 저장' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: '정기 계획 수정' })).toBeNull()
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
    await within(await screen.findByRole('list', { name: '날짜별 접수 기록' })).findByText(/접수 확인 중/)
    fireEvent.change(screen.getByLabelText('공통 E01 계획 중지 사유'), { target: { value: '배포 전 중지' } })
    fireEvent.click(screen.getByRole('button', { name: '계획 중지 내용 확인' }))
    fireEvent.click(screen.getByRole('button', { name: '확인한 계획 중지' }))
    await screen.findByText(/접수 차단: 계획이 중지되었거나 승인 기간이 끝났습니다/)
    expect(within(screen.getByRole('list', { name: '날짜별 접수 기록' })).queryByText(/접수 확인 중/)).toBeNull()
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
    await waitFor(() => expect(expired).toHaveBeenCalled())
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
  })
})
