// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLegacyUsagePreview } from '../../../data/ops/opsApi'
import { UnaccountedRunsPanel } from './UnaccountedRunsPanel'

const first = '10000000-0000-4000-8000-000000000001'
const second = '20000000-0000-4000-8000-000000000002'
const at = '2026-10-03T01:00:00Z'
const rows = [first, second].map((run_id) => ({ run_id, dataset_id: 'legacy', dataset_label: '검토 자료', status: 'COMPLETED', status_label: '완료', created_at: at }))
const listing = { as_of: at, count: 2, next: null, previous: null, results: rows }
const verified = {
  as_of: at, run_id: first, applied: false, state: 'verified', can_apply: true, blockers: [],
  source: 'SAVED_CAPTURE', provider_receipt_verified: false,
  capture_sha256: 'a'.repeat(64), evidence_sha256: 'b'.repeat(64),
  usage: { calls: 1, input_tokens: 100, output_tokens: 50 },
  before: { calls: 0, input_tokens: 0, output_tokens: 0 },
  after: { calls: 1, input_tokens: 100, output_tokens: 50 },
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const mount = (onExpired = vi.fn()) => render(<MemoryRouter><UnaccountedRunsPanel onExpired={onExpired} refreshKey={0} /></MemoryRouter>)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('미반영 실행 사용량 확인', () => {
  it('목록에서 선택한 실행만 검증하고 GET 조회로 예상 사용량과 출처를 표시한다', async () => {
    const fetch = vi.fn(async (url: string) => json(url.includes('unaccounted-runs') ? listing : verified))
    vi.stubGlobal('fetch', fetch)
    mount()
    const button = await screen.findByRole('button', { name: `사용량 확인 ${first}` })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: '검토 자료 · 10000000' }).getAttribute('href')).toBe(`/ops/evaluations/${first}`)
    fireEvent.click(button)
    expect(await screen.findByText('저장 응답 사용량: 1회 · 입력 100 / 출력 50토큰')).toBeTruthy()
    expect(screen.getByText(/반영 시 예상 전체 할당량/)).toBeTruthy()
    expect(screen.getByText(/장부 반영이나 한도 변경을 하지 않습니다/)).toBeTruthy()
    expect(screen.getByText(/별도 검토·반영이 필요/)).toBeTruthy()
    expect(fetch.mock.calls.every((call) => !(call as unknown as [string, RequestInit])[1]?.method)).toBe(true)
  })

  it('한도가 없으면 검증된 사용량을 보존하고 반영 보류 사유를 표시한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.includes('unaccounted-runs') ? listing : {
      ...verified, can_apply: false, before: null, after: null, blockers: ['먼저 누적 한도를 설정하세요.'],
    })))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: `사용량 확인 ${first}` }))
    expect(await screen.findByText('저장 응답 사용량: 1회 · 입력 100 / 출력 50토큰')).toBeTruthy()
    expect(screen.getByText('먼저 누적 한도를 설정하세요.')).toBeTruthy()
    expect(screen.queryByText(/반영 시 예상 전체 할당량/)).toBeNull()
  })

  it('증거가 없거나 불완전한 경우 사용량 0이나 합격으로 표시하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.includes('unaccounted-runs') ? listing : {
      as_of: at, run_id: first, applied: false, state: 'unavailable', blockers: ['전체 호출 사용량을 확인할 수 없습니다.'],
    })))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: `사용량 확인 ${first}` }))
    expect(await screen.findByText('사용량 확인 불가 · 0으로 반영하지 않습니다.')).toBeTruthy()
    expect(screen.queryByText(/저장 응답 사용량:/)).toBeNull()
    expect(screen.getByText('전체 호출 사용량을 확인할 수 없습니다.')).toBeTruthy()
  })

  it('다른 실행 선택 후 늦게 도착한 이전 결과를 표시하지 않는다', async () => {
    let resolveFirst!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const fetch = vi.fn((url: string) => url.includes('unaccounted-runs') ? Promise.resolve(json(listing))
      : url.includes(first) ? pending : Promise.resolve(json({ ...verified, run_id: second, usage: { calls: 2, input_tokens: 200, output_tokens: 100 }, after: { calls: 2, input_tokens: 200, output_tokens: 100 } })))
    vi.stubGlobal('fetch', fetch)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: `사용량 확인 ${first}` }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: `사용량 확인 ${second}` }))
    expect(await screen.findByText('저장 응답 사용량: 2회 · 입력 200 / 출력 100토큰')).toBeTruthy()
    await act(async () => { resolveFirst(json(verified)) })
    expect(screen.queryByText('저장 응답 사용량: 1회 · 입력 100 / 출력 50토큰')).toBeNull()
  })

  it('다음 페이지와 목록 새로고침은 이전 검증 결과를 지운다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.includes('unaccounted-runs')
      ? { ...listing, count: 26, results: url.endsWith('page=2') ? [rows[1]] : [rows[0]], next: url.endsWith('page=2') ? null : '/page2' }
      : { ...verified, run_id: url.includes(second) ? second : first })))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: `사용량 확인 ${first}` }))
    await screen.findByText(/저장 응답 사용량:/)
    fireEvent.click(screen.getByRole('button', { name: '미반영 다음' }))
    await screen.findByRole('button', { name: `사용량 확인 ${second}` })
    expect(screen.queryByRole('region', { name: '과거 사용량 미리보기' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `사용량 확인 ${second}` }))
    await screen.findByText(/저장 응답 사용량:/)
    fireEvent.click(screen.getByRole('button', { name: '미반영 목록 새로고침' }))
    await screen.findByRole('button', { name: `사용량 확인 ${second}` })
    expect(screen.queryByText(/저장 응답 사용량:/)).toBeNull()
  })

  it.each([401, 403])('사용량 조회의 인증 오류 %i는 관리자 세션 만료로 전달한다', async (status) => {
    const onExpired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('unaccounted-runs') ? json(listing) : json({}, status)))
    mount(onExpired)
    fireEvent.click(await screen.findByRole('button', { name: `사용량 확인 ${first}` }))
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/저장 응답 사용량:/)).toBeNull()
  })

  it('목록 조회 실패는 빈 목록으로 표시하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 503)))
    mount()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('미반영 실행이 없습니다.')).toBeNull()
  })

  it.each([
    { run_id: second }, { applied: true }, { provider_receipt_verified: true },
    { can_apply: true, blockers: ['한도 부족'] }, { can_apply: false, blockers: [] },
    { usage: { ...verified.usage, input_tokens: null } }, { source: 'WORKER_RESPONSE' },
    { after: { calls: 1, input_tokens: 99, output_tokens: 50 } }, { capture_sha256: '' },
    { before: null, after: null }, { state: 'unavailable', blockers: [] },
  ])('모순되거나 다른 실행의 미리보기는 거절한다: %j', async (changes) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...verified, ...changes })))
    await expect(getLegacyUsagePreview(first)).rejects.toThrow()
  })
})
