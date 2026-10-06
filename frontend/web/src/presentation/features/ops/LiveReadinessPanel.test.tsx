// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { getLiveReadiness } from '../../../data/ops/opsApi'
import { LiveReadinessPanel } from './LiveReadinessPanel'

const profile = 'a'.repeat(64)
const checked = {
  as_of: '2026-10-03T01:00:00Z', dataset_id: 'fixed', execution_profile: profile,
  evaluation_scope: 'fixed-answer-context-only', model: 'test-model', state: 'checked',
  required: { calls: 6, input_tokens: 196608, output_tokens: 12000 },
  remaining: { calls: 12, input_tokens: 400000, output_tokens: 24000 }, blockers: [], warnings: [],
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const mount = (onExpired = vi.fn()) => render(<LiveReadinessPanel datasetId="fixed" executionProfile={profile} onExpired={onExpired} />, { wrapper: MemoryRouter })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('실행 설정·예산 점검', () => {
  it('명시적인 GET 점검만 수행하며 폼 접수나 예산 예약을 하지 않는다', async () => {
    const fetch = vi.fn(async () => json(checked)), submit = vi.fn((event) => event.preventDefault())
    vi.stubGlobal('fetch', fetch)
    render(<form onSubmit={submit}><LiveReadinessPanel datasetId="fixed" executionProfile={profile} onExpired={vi.fn()} /></form>, { wrapper: MemoryRouter })
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '실행 설정·예산 점검' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '조회 시점의 설정·예산에서 차단 사유가 없습니다.')
    expect(submit).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`/api/v1/ops/evaluations/live-readiness?dataset_id=fixed&execution_profile=${profile}`, expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }))
    const row = screen.getByRole('row', { name: '입력 토큰 196,608 400,000' })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['196,608', '400,000'])
    expect(screen.getByText(/이 결과는 실행 승인이 아니며/)).toBeTruthy()
  })

  it('미설정·미확인 사용량을 0으로 표시하지 않고 차단과 주의 사항을 구분한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...checked, state: 'blocked', remaining: null,
      blockers: [{ code: 'BUDGET_UNCONFIGURED', message: '누적 예산 한도를 설정하세요.' }],
      warnings: [{ code: 'INPUT_BUDGET_UNKNOWN', message: '미확인 과거 입력 사용량을 먼저 검토하세요.' }],
    })))
    mount(); fireEvent.click(screen.getByRole('button'))
    await screen.findByText('누적 예산 한도를 설정하세요.')
    expect(screen.getAllByText('확인 불가·미설정')).toHaveLength(3)
    expect(screen.getByRole('list', { name: '점검 주의 사항' }).textContent).toContain('미확인 과거 입력')
    expect(screen.getByRole('link', { name: '누적 예산 관리로 이동' }).getAttribute('href')).toBe('/ops/budget')
    expect(screen.queryByText('조회 시점의 설정·예산에서 차단 사유가 없습니다.')).toBeNull()
  })

  it('재점검 중 이전 성공을 지우고 오류를 표시한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(checked)).mockResolvedValueOnce(json({ detail: '실행 설정이 변경됐습니다.' }, 409)))
    mount(); fireEvent.click(screen.getByRole('button'))
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('table')).toBeNull()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '평가 조건이나 검토 기록이 변경되었습니다. 새로고침 후 확인하세요.')
  })

  it('새 자료 선택 뒤 도착한 이전 점검은 화면에 반영하지 않는다', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(json({ ...checked, dataset_id: 'second', model: 'second-model' })))
    const view = render(<LiveReadinessPanel key="first" datasetId="fixed" executionProfile={profile} onExpired={vi.fn()} />, { wrapper: MemoryRouter })
    fireEvent.click(screen.getByRole('button'))
    view.rerender(<LiveReadinessPanel key="second" datasetId="second" executionProfile={profile} onExpired={vi.fn()} />)
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    await screen.findByText(/second-model/)
    await act(async () => { resolve(json(checked)); await pending })
    expect(screen.queryByText(/test-model/)).toBeNull()
    expect(screen.getByText(/second-model/)).toBeTruthy()
  })

  it.each([401, 403])('관리자 인증 오류 %i는 세션을 다시 확인한다', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: '관리자 로그인 필요' }, status)))
    const expired = vi.fn(); mount(expired); fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('table')).toBeNull()
  })

  it.each([
    { dataset_id: 'another' }, { execution_profile: 'b'.repeat(64) }, { state: 'blocked' },
    { blockers: [{ code: 'BAD', message: '차단' }] }, { remaining: null },
    { remaining: { ...checked.remaining, calls: 5 } },
    { remaining: { ...checked.remaining, input_tokens: null } },
    { required: { ...checked.required, calls: 0 } }, { as_of: 'not-a-date' },
    { evaluation_scope: 'source-chunks-retrieval-answer', remaining: { ...checked.remaining, input_tokens: null }, warnings: [{ code: 'INPUT', message: '미설정' }] },
  ])('선택 불일치나 근거 없는 정상 판정을 거절한다: %j', async (changes) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...checked, ...changes })))
    await expect(getLiveReadiness('fixed', profile)).rejects.toThrow()
  })

  it('고정 근거의 입력 한도 미설정은 경고와 함께 허용한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...checked, remaining: { ...checked.remaining, input_tokens: null }, warnings: [{ code: 'INPUT_BUDGET_UNCONFIGURED', message: '입력 한도 미설정' }] })))
    mount(); fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('입력 한도 미설정')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('차단 사유가 없습니다')
    expect(screen.getByText('확인 불가·미설정')).toBeTruthy()
    expect(screen.getByRole('link', { name: '누적 예산 관리로 이동' })).toBeTruthy()
  })

  it('모델 비활성화만 있으면 예산 설정으로 해결할 수 있다고 안내하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...checked, state: 'blocked', blockers: [{ code: 'LIVE_DISABLED', message: '모델 평가 비활성화' }] })))
    mount(); fireEvent.click(screen.getByRole('button'))
    await screen.findByText('모델 평가 비활성화')
    expect(screen.queryByRole('link', { name: '누적 예산 관리로 이동' })).toBeNull()
  })
})
