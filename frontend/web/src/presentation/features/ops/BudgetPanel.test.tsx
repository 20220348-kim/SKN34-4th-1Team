// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRunBudget, type BudgetPage, type RunBudget } from '../../../data/ops/opsApi'
import { BudgetOverview, RunBudgetPanel } from './BudgetPanel'

const id = '10000000-0000-4000-8000-000000000001'
const time = '2026-09-29T00:00:00Z'
const breakdown = {
  settled_calls: 1, confirmed_input_tokens: 100, confirmed_output_tokens: 50,
  unknown_calls: 1, unknown_output_tokens: 2000, unapproved_calls: 4, unapproved_output_tokens: 8000,
  pending_release_output_tokens: 1950, allocated_calls: 6, allocated_output_tokens: 12000,
}
const reservation = { run_id: id, dataset_id: '검토 자료', created_at: time, closed_at: null, max_calls: 6, max_output_tokens: 2000, breakdown }
const page: BudgetPage = {
  as_of: time, count: 1, next: null, previous: null, results: [reservation],
  summary: {
    state: 'consistent', limits: { calls: 12, output_tokens: 24000 }, allocated: { calls: 6, output_tokens: 12000 },
    remaining: { calls: 6, output_tokens: 12000 }, breakdown, reservation_count: 1,
    legacy_live_run_count: 2, change_count: 1, recent_changes: [{
      request_id: id, actor: '김 운영자', source: 'CLI', reason: '검토한 수동 평가 한도',
      previous_limits: null, limits: { calls: 12, output_tokens: 24000 }, created_at: time,
    }],
  },
}
const detail: RunBudget = {
  as_of: time, state: 'recorded', reservation,
  calls: [
    { sequence: 0, authorized_at: time, settled_at: time, input_tokens: 100, output_tokens: 50 },
    { sequence: 1, authorized_at: time, settled_at: null, input_tokens: null, output_tokens: null },
  ],
}
const cleanupRecord = {
  request_id: id, actor: '김 운영자', source: 'CLI', reason: '종료 후 close 실패 확인', created_at: time,
  evidence: { source: 'PREFECT', flow_id: id, run_id: id, spec_sha256: 'a'.repeat(64), parameters_sha256: 'b'.repeat(64), state_id: id, state_type: 'FAILED', state_timestamp: time, observed_at: time },
  before: { global_calls: 6, global_output_tokens: 12000, reservation_calls: 6, reservation_output_tokens: 12000 },
  after: { global_calls: 2, global_output_tokens: 2050, reservation_calls: 2, reservation_output_tokens: 2050, unknown_calls: 1, unknown_output_tokens: 2000 },
}
const correction = {
  request_id: id, run_id: id, sequence: 1, source: 'WORKER_RESPONSE', actor: '김 운영자', reason: '정산 전달 실패 검토',
  evidence_sha256: 'c'.repeat(64), response_id: 'resp_test', input_tokens: 100, output_tokens: 50, created_at: time,
  before: { global_calls: 2, global_output_tokens: 2050, reservation_calls: 2, reservation_output_tokens: 2050, unknown_calls: 1, unknown_output_tokens: 2000 },
  after: { global_calls: 2, global_output_tokens: 100, reservation_calls: 2, reservation_output_tokens: 100, unknown_calls: 0, unknown_output_tokens: 0 },
}
const correctedDetail = {
  ...detail, corrections: [correction], reservation: { ...reservation, closed_at: time, breakdown: {
    settled_calls: 2, confirmed_input_tokens: 200, confirmed_output_tokens: 100,
    unknown_calls: 0, unknown_output_tokens: 0, unapproved_calls: 0, unapproved_output_tokens: 0,
    pending_release_output_tokens: 0, allocated_calls: 2, allocated_output_tokens: 100,
  } },
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const legacyDetail = {
  as_of: time, state: 'legacy_recorded', reservation: null, calls: [], cleanup: null, corrections: [],
  legacy_usage: {
    request_id: id, run_id: id, source: 'SAVED_CAPTURE', provider_receipt_verified: false,
    actor: '과거 기록 담당자', reason: '전체 응답 사용량 검토', created_at: time,
    capture_sha256: 'a'.repeat(64), evidence_sha256: 'b'.repeat(64),
    usage: { calls: 6, input_tokens: 6834, output_tokens: 689 },
    before: { calls: 1, input_tokens: 1067, output_tokens: 87 },
    after: { calls: 7, input_tokens: 7901, output_tokens: 776 },
  },
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('관리자 예산 장부', () => {
  it('미반영 목록은 버튼으로 연 뒤에만 조회하고 닫을 수 있다', async () => {
    const fetch = vi.fn(async (url: string) => json(url.includes('unaccounted-runs')
      ? { as_of: time, count: 1, next: null, previous: null, results: [
        { run_id: id, dataset_id: 'legacy', dataset_label: '과거 자료', status: 'COMPLETED', status_label: '완료', created_at: time },
      ] } : page))
    vi.stubGlobal('fetch', fetch)
    render(<MemoryRouter><BudgetOverview onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    const button = await screen.findByRole('button', { name: '미반영 실행 목록 확인' })
    expect(fetch.mock.calls.some(([url]) => url.includes('unaccounted-runs'))).toBe(false)
    fireEvent.click(button)
    expect(await screen.findByRole('link', { name: '과거 자료 · 10000000' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '미반영 실행 목록 닫기' }))
    expect(screen.queryByRole('region', { name: '미반영 실행 검토' })).toBeNull()
  })

  it('과거 사용량은 예약·서명 영수증·품질 승인으로 표시하지 않고 출처를 보여준다', async () => {
    const fetch = vi.fn().mockResolvedValue(json(legacyDetail))
    vi.stubGlobal('fetch', fetch)
    render(<MemoryRouter><RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    const audit = await screen.findByRole('region', { name: '과거 사용량 반영 이력' })
    expect(within(audit).getByText(/저장 응답 사용량: 6회 · 입력 6,834 \/ 출력 689토큰/)).toBeTruthy()
    expect(within(audit).getByText(/당시 예약·서명 영수증·제공자 청구 확인이 아닙니다/)).toBeTruthy()
    expect(within(audit).getByText(/답변 품질 승인과도 별개/)).toBeTruthy()
    expect(screen.queryByText(/예약 상태:/)).toBeNull()
    expect(screen.queryByText(/사용량을 0으로 판단/)).toBeNull()
    expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true)
  })

  it.each([
    { legacy_usage: undefined },
    { state: 'missing' },
    { reservation },
    { calls: detail.calls },
    { legacy_usage: { ...legacyDetail.legacy_usage, provider_receipt_verified: true } },
    { legacy_usage: { ...legacyDetail.legacy_usage, source: 'WORKER_RESPONSE' } },
    { legacy_usage: { ...legacyDetail.legacy_usage, run_id: '20000000-0000-4000-8000-000000000002' } },
    { legacy_usage: { ...legacyDetail.legacy_usage, after: { calls: 6, input_tokens: 7901, output_tokens: 776 } } },
    { legacy_usage: { ...legacyDetail.legacy_usage, usage: { calls: 6, input_tokens: null, output_tokens: 689 } } },
    { legacy_usage: { ...legacyDetail.legacy_usage, capture_sha256: '' } },
  ])('불완전하거나 모순된 과거 사용량 응답을 거절한다: %j', async (changes) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...legacyDetail, ...changes })))
    await expect(getRunBudget(id)).rejects.toThrow()
  })

  it('전체 장부에 과거 저장 응답 몫을 별도 행으로 표시한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, summary: { ...page.summary,
      legacy_accounted_run_count: 2, legacy_live_run_count: 0,
      breakdown: { ...breakdown, legacy_calls: 7, legacy_input_tokens: 7901, legacy_output_tokens: 776 },
    } })))
    render(<MemoryRouter><BudgetOverview onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    const table = await screen.findByRole('table', { name: '예산 할당량 구성' })
    expect(within(table).getByRole('row', { name: '과거 저장 응답 반영 7 776 7,901토큰' })).toBeTruthy()
    expect(screen.getByText(/과거 실행 2건의 사용량을 합산/)).toBeTruthy()
    expect(screen.queryByText(/예약 기록이 없는 과거 모델 실행/)).toBeNull()
  })

  it('새 호출의 답변 작업을 표시하고 과거 호출의 사례를 추정하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, calls: [
      { ...detail.calls[0], operation_id: 'answer:TC01' },
      { ...detail.calls[1], operation_id: null },
    ] })))
    render(<MemoryRouter><RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    fireEvent.click(await screen.findByText('호출별 승인·정산 · 2건'))
    expect(screen.getByText('답변 작업 · answer:TC01')).toBeTruthy()
    expect(screen.getByText('작업 식별 기록 없음 · 과거 승인')).toBeTruthy()
    expect(screen.queryByText(/answer:TC02/)).toBeNull()
  })

  it('지원하지 않는 작업 ID가 포함된 장부 응답을 거절한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, calls: [
      { ...detail.calls[0], operation_id: 'unsupported:TC01' },
    ] })))
    await expect(getRunBudget(id)).rejects.toThrow()
  })

  it('확정·미확인·미승인·반환 대기와 CLI 감사 출처를 구분하고 GET만 사용한다', async () => {
    const fetch = vi.fn().mockResolvedValue(json(page))
    vi.stubGlobal('fetch', fetch)
    render(<MemoryRouter><BudgetOverview onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    const table = await screen.findByRole('table', { name: '예산 할당량 구성' })
    expect(within(table).getByRole('row', { name: '확정 사용량 1 50 100토큰' })).toBeTruthy()
    expect(within(table).getByRole('row', { name: '승인 후 사용량 미확인 1 2,000 미확인·미설정' })).toBeTruthy()
    expect(within(table).getByRole('row', { name: '아직 승인하지 않은 예약 4 8,000 미확인·미설정' })).toBeTruthy()
    expect(within(table).getByRole('row', { name: '종료 전 반환 대기 — 1,950 미확인·미설정' })).toBeTruthy()
    expect(screen.getByText(/예약 기록이 없는 과거 모델 실행 2건/)).toBeTruthy()
    fireEvent.click(screen.getByText('한도 변경 이력 · 최근 1 / 전체 1건'))
    expect(screen.getByText(/김 운영자 · CLI/)).toBeTruthy()
    expect(screen.getByText(/Core 로그인으로 인증한 신원은 아닙니다/)).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/api/v1/ops/budget/reservations?page=1', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true)
  })

  it('페이지 내역과 전체 합계를 혼동하지 않고 다음 예약 페이지를 조회한다', async () => {
    const fetch = vi.fn(async (url: string) => json({ ...page, count: 26,
      next: url.endsWith('page=1') ? '/api/v1/ops/budget/reservations?page=2' : null,
      previous: url.endsWith('page=2') ? '/api/v1/ops/budget/reservations?page=1' : null,
    }))
    vi.stubGlobal('fetch', fetch)
    render(<MemoryRouter><BudgetOverview onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: '예약 다음' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/ops/budget/reservations?page=2')
    expect(await screen.findByText(/총계는 전체 예약과 검토 후 반영한 과거 사용량 기준/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '예약 다음' })).toHaveProperty('disabled', true)
  })

  it.each(['unconfigured', 'inconsistent'] as const)('%s 상태는 잔여 한도를 0으로 표시하지 않는다', async (state) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, summary: { ...page.summary, state, remaining: null,
      ...(state === 'unconfigured' ? { limits: null, allocated: null, breakdown: null } : {}),
    } })))
    render(<MemoryRouter><BudgetOverview onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    expect(await screen.findByText(state === 'unconfigured' ? /누적 한도가 설정되지 않았습니다/ : /상세 장부가 일치하지 않습니다/)).toBeTruthy()
    expect(screen.queryByText('0회 · 0토큰')).toBeNull()
  })

  it('예약 기록이 없는 과거 실행을 무료 실행으로 해석하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ as_of: time, state: 'missing', reservation: null, calls: [] })))
    render(<RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} />)
    expect(await screen.findByText(/사용량을 0으로 판단할 수 없습니다/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('닫힌 예약도 미확인 호출을 표시하고 정산된 0토큰과 구분한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, reservation: { ...reservation, closed_at: time },
      calls: [{ ...detail.calls[0], output_tokens: 0 }, detail.calls[1]],
    })))
    render(<RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} />)
    expect(await screen.findByText(/예약 상태: 닫힘/)).toBeTruthy()
    fireEvent.click(screen.getByText('호출별 승인·정산 · 2건'))
    expect(screen.getByText(/입력 100 \/ 출력 0토큰/)).toBeTruthy()
    expect(screen.getByText(/호출 2 .* 사용량 미확인/)).toBeTruthy()
    expect(screen.getByText(/예약이 닫혀도 해당 호출의 최대 출력 몫은 유지/)).toBeTruthy()
  })

  it('갱신 실패에는 마지막 조회 기록과 오류를 함께 유지한다', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(page)).mockRejectedValue(new Error('offline')))
    render(<MemoryRouter><BudgetOverview onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('table', { name: '예산 할당량 구성' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('alert').textContent).toContain('마지막 조회 기록')
    expect(screen.getByRole('row', { name: '확정 사용량 1 50 100토큰' })).toBeTruthy()
  })

  it('종료 정리의 반환분·미확인 유지분·근거를 읽기 전용으로 표시한다', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...detail, reservation: { ...reservation, closed_at: time }, cleanup: cleanupRecord }))
    vi.stubGlobal('fetch', fetch)
    render(<RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} />)
    const audit = await screen.findByRole('region', { name: '종료 예약 정리 이력' })
    expect(within(audit).getByText('반환: 4회 · 9,950출력 토큰')).toBeTruthy()
    expect(within(audit).getByText('유지된 미확인 몫: 1회 · 2,000출력 토큰')).toBeTruthy()
    expect(within(audit).getByText(/종료 근거: Prefect FAILED/)).toBeTruthy()
    expect(within(audit).getByText(/실제 결제 환불이나 미확인 사용량 보정이 아니며/)).toBeTruthy()
    expect(within(audit).queryByRole('button')).toBeNull()
    expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true)
  })

  it.each(['active', 'wrong-run', 'not-closed', 'wrong-total'])('확인할 수 없는 정리 근거 %s는 거절한다', async (scenario) => {
    const body = { ...detail, reservation: { ...reservation, closed_at: scenario === 'not-closed' ? null : time },
      cleanup: { ...cleanupRecord, evidence: { ...cleanupRecord.evidence,
        ...(scenario === 'active' ? { state_type: 'RUNNING' } : {}),
        ...(scenario === 'wrong-run' ? { run_id: '20000000-0000-4000-8000-000000000002' } : {}),
      }, ...(scenario === 'wrong-total' ? { after: { ...cleanupRecord.after, global_output_tokens: 0 } } : {}) },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)))
    await expect(getRunBudget(id)).rejects.toThrow('운영 서버 응답을 확인할 수 없습니다.')
  })

  it('보정된 사용량과 원본 미정산 기록을 구분하고 증거·차액 이력을 GET으로 조회한다', async () => {
    const fetch = vi.fn().mockResolvedValue(json(correctedDetail))
    vi.stubGlobal('fetch', fetch)
    render(<RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} />)
    const audit = await screen.findByRole('region', { name: '사용량 보정 이력' })
    expect(within(audit).getByText('확인 사용량: 입력 100 / 출력 50토큰')).toBeTruthy()
    expect(within(audit).getByText('예약 차액 반환: 1,950출력 토큰 · 호출 횟수 유지')).toBeTruthy()
    expect(within(audit).getByText(/증거 SHA-256/)).toBeTruthy()
    expect(screen.getByText(/원본 정산 미수신 · 사용량 보정 이력 참조/)).toBeTruthy()
    expect(screen.getByRole('row', { name: '확정 사용량 2 100 200토큰' })).toBeTruthy()
    expect(within(audit).queryByRole('button')).toBeNull()
    expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true)
  })

  it.each(['wrong-run', 'wrong-call', 'settled', 'open', 'duplicate', 'wrong-delta', 'over-cap', 'fake-source'])('잘못된 사용량 보정 계약 %s를 거절한다', async (scenario) => {
    const record = { ...correction,
      ...(scenario === 'wrong-run' ? { run_id: '20000000-0000-4000-8000-000000000002' } : {}),
      ...(scenario === 'wrong-call' ? { sequence: 9 } : {}),
      ...(scenario === 'settled' ? { sequence: 0 } : {}),
      ...(scenario === 'wrong-delta' ? { after: { ...correction.after, global_output_tokens: 0 } } : {}),
      ...(scenario === 'over-cap' ? { output_tokens: 2001 } : {}),
      ...(scenario === 'fake-source' ? { source: 'MANUAL' } : {}),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...correctedDetail,
      reservation: { ...correctedDetail.reservation, closed_at: scenario === 'open' ? null : time },
      corrections: scenario === 'duplicate' ? [record, record] : [record],
    })))
    await expect(getRunBudget(id)).rejects.toThrow('운영 서버 응답을 확인할 수 없습니다.')
  })

  it.each([401, 403])('권한 오류 %s에는 세션을 재확인한다', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)))
    const expired = vi.fn()
    render(<MemoryRouter><BudgetOverview onExpired={expired} refreshKey={0} /></MemoryRouter>)
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('정산 시각만 있고 토큰이 없는 잘못된 응답은 거절한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, calls: [{ ...detail.calls[0], output_tokens: null }] })))
    await expect(getRunBudget(id)).rejects.toThrow('운영 서버 응답을 확인할 수 없습니다.')
  })
})

it.each(['enforced', 'legacy_unknown', 'unconfigured'] as const)('누적 입력 %s 상태와 잔여 토큰을 구분한다', async (input_state) => {
  const unknown = input_state === 'legacy_unknown'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, summary: { ...page.summary,
    input_state, legacy_live_run_count: 0,
    limits: { ...page.summary.limits, input_tokens: input_state === 'enforced' ? 300000 : null },
    allocated: { ...page.summary.allocated, input_tokens: unknown ? null : 196608 },
    remaining: { ...page.summary.remaining, input_tokens: input_state === 'enforced' ? 103392 : null },
    breakdown: { ...breakdown, unbounded_input_calls: unknown ? 1 : 0, unbounded_input_reservations: 0,
      unknown_input_tokens: 32768, unapproved_input_tokens: 131072, pending_release_input_tokens: 32668, allocated_input_tokens: 196608 },
  } })))
  render(<MemoryRouter><BudgetOverview onExpired={vi.fn()} refreshKey={0} /></MemoryRouter>)
  expect(await screen.findByText(input_state === 'enforced' ? '누적 입력 토큰 한도 적용 중'
    : input_state === 'legacy_unknown' ? /과거 입력 미확인:/ : /누적 입력 한도 미설정:/)).toBeTruthy()
  const row = screen.getByRole('row', { name: /^현재 할당량 합계/ })
  expect(row.textContent).toContain(unknown ? '미확인·미설정' : '196,608토큰')
  if (input_state === 'enforced') expect(screen.getByText(/입력 103,392토큰/)).toBeTruthy()
})

it('입력 보정 차액 불일치와 예약 상한 초과 사용량을 거절한다', async () => {
  const bounded = { ...correctedDetail, reservation: { ...correctedDetail.reservation, max_input_tokens: 32768 },
    corrections: [{ ...correction, before: { ...correction.before, global_input_tokens: 32868, reservation_input_tokens: 32868 },
      after: { ...correction.after, global_input_tokens: 200, reservation_input_tokens: 200 } }] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(bounded)))
  expect((await getRunBudget(id)).reservation?.max_input_tokens).toBe(32768)
  for (const changed of [
    { ...bounded.corrections[0], after: { ...bounded.corrections[0].after, global_input_tokens: 100 } },
    { ...bounded.corrections[0], input_tokens: 32769 },
  ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...bounded, corrections: [changed] })))
    await expect(getRunBudget(id)).rejects.toThrow()
  }
})


it('임베딩 승인과 답변의 개별 상한을 표시한다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, calls: [
    { ...detail.calls[0], operation_id: 'document_embedding:D1:0', max_input_tokens: 120, max_output_tokens: 0 },
    { ...detail.calls[1], operation_id: 'answer:E01', max_input_tokens: 32768, max_output_tokens: 2000 },
  ] })))
  render(<RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} />)
  fireEvent.click(await screen.findByText('호출별 승인·정산 · 2건'))
  expect(screen.getByText('문서 임베딩 · document_embedding:D1:0')).toBeTruthy()
  expect(screen.getByText('승인 상한: 입력 120토큰 / 출력 0토큰')).toBeTruthy()
  expect(screen.getByText('승인 상한: 입력 32,768토큰 / 출력 2,000토큰')).toBeTruthy()
})

const embeddingCorrection = {
  ...correction, source: 'WORKER_EMBEDDING_RESPONSE', response_id: null,
  provider_request_id: 'req_embedding_first', output_tokens: 0,
  before: { ...correction.before, global_input_tokens: 1000, reservation_input_tokens: 1000,
    global_output_tokens: 0, reservation_output_tokens: 0, unknown_calls: 2, unknown_output_tokens: 0 },
  after: { ...correction.after, global_input_tokens: 600, reservation_input_tokens: 600,
    global_output_tokens: 0, reservation_output_tokens: 0, unknown_calls: 1, unknown_output_tokens: 0 },
}
const correctedEmbedding = {
  ...correctedDetail,
  reservation: { ...correctedDetail.reservation, max_input_tokens: 32768 },
  calls: [{ ...detail.calls[1], operation_id: 'document_embedding:D1:0', max_input_tokens: 500, max_output_tokens: 0 }],
  corrections: [embeddingCorrection],
}

it('임베딩 보정은 실제 요청 ID와 입력 차액을 표시하고 GET만 사용한다', async () => {
  const fetch = vi.fn().mockResolvedValue(json(correctedEmbedding))
  vi.stubGlobal('fetch', fetch)
  render(<RunBudgetPanel runId={id} onExpired={vi.fn()} refreshKey={0} />)
  const audit = await screen.findByRole('region', { name: '사용량 보정 이력' })
  expect(within(audit).getByText(/임베딩 요청: req_embedding_first/)).toBeTruthy()
  expect(within(audit).getByText(/입력 차액 반환: 400토큰/)).toBeTruthy()
  expect(within(audit).getByText('확인 사용량: 입력 100 / 출력 0토큰')).toBeTruthy()
  expect(within(audit).queryByText(/응답:/)).toBeNull()
  expect(within(audit).queryByRole('button')).toBeNull()
  expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true)
})

it('서로 다른 임베딩 요청은 null 응답 ID가 같아도 조회할 수 있다', async () => {
  const second = { ...embeddingCorrection, sequence: 2, request_id: '20000000-0000-4000-8000-000000000002',
    provider_request_id: 'req_embedding_second', before: embeddingCorrection.after,
    after: { ...embeddingCorrection.after, global_input_tokens: 200, reservation_input_tokens: 200, unknown_calls: 0 } }
  const body = { ...correctedEmbedding, calls: [...correctedEmbedding.calls,
    { ...correctedEmbedding.calls[0], sequence: 2, operation_id: 'query_embedding:E01:0' }],
    corrections: [embeddingCorrection, second] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)))
  expect((await getRunBudget(id)).corrections).toHaveLength(2)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...body,
    corrections: [embeddingCorrection, { ...second, provider_request_id: embeddingCorrection.provider_request_id }],
  })))
  await expect(getRunBudget(id)).rejects.toThrow()
})

it.each(['missing-id', 'fake-response', 'answer-source', 'answer-call', 'legacy-call', 'output', 'input-delta', 'missing-input'])('잘못된 임베딩 보정 %s를 거절한다', async (fault) => {
  const record = { ...embeddingCorrection,
    ...(fault === 'missing-id' ? { provider_request_id: undefined } : {}),
    ...(fault === 'fake-response' ? { response_id: 'resp_invented' } : {}),
    ...(fault === 'answer-source' ? { source: 'WORKER_RESPONSE' } : {}),
    ...(fault === 'output' ? { output_tokens: 1 } : {}),
    ...(fault === 'input-delta' ? { after: { ...embeddingCorrection.after, global_input_tokens: 601, reservation_input_tokens: 601 } } : {}),
    ...(fault === 'missing-input' ? {
      before: { ...embeddingCorrection.before, global_input_tokens: undefined, reservation_input_tokens: undefined },
      after: { ...embeddingCorrection.after, global_input_tokens: undefined, reservation_input_tokens: undefined },
    } : {}),
  }
  const call = { ...correctedEmbedding.calls[0],
    ...(fault === 'answer-call' ? { operation_id: 'answer:E01' } : {}),
    ...(fault === 'legacy-call' ? { max_input_tokens: undefined, max_output_tokens: undefined } : {}),
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...correctedEmbedding, calls: [call], corrections: [record] })))
  await expect(getRunBudget(id)).rejects.toThrow()
})
