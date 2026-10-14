// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleSettingsPanel } from './ScheduleSettingsPanel'
import type { ScheduleSettings, ScheduleSettingsInput } from '../../../data/ops/opsApi'

const initial: ScheduleSettings = { enabled: false, revision: 0, source: 'environment', live_enabled: false, rag_live_enabled: false, changes: [] }
const session = { user: { id: 'core:81', username: '관리자' }, csrf_token: 'csrf-test', live_enabled: false }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const changeResult = (input: ScheduleSettingsInput) => {
  const change = { request_id: input.request_id, revision: input.expected_revision + 1, enabled: input.enabled,
    previous_enabled: !input.enabled, actor: session.user.id, reason: input.reason, created_at: '2026-10-14T08:00:00Z' }
  return { ...initial, source: 'admin' as const, enabled: input.enabled, revision: change.revision, changes: [change], change }
}
const setup = (overrides: { get?: () => Promise<Response>; post?: (data: ScheduleSettingsInput) => Promise<Response>; session?: () => Promise<Response> } = {}) => {
  let current = initial
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    if (url === '/api/v1/ops/session') return overrides.session?.() ?? json(session)
    if (url === '/api/v1/ops/schedules/settings') {
      if (options?.method === 'POST') {
        const data = JSON.parse(options.body as string) as ScheduleSettingsInput
        if (overrides.post) return overrides.post(data)
        const result = changeResult(data); current = result; return json(result)
      }
      return overrides.get?.() ?? json(current)
    }
    throw new Error(`Unexpected request: ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const mount = (props = {}) => render(<ScheduleSettingsPanel owner="core:81" onSaved={vi.fn()} onExpired={vi.fn()} {...props} />)
const choose = async (enabled = true, reason = '검토된 정기 계획 접수 준비') => {
  fireEvent.change(await screen.findByRole('combobox', { name: '변경할 정기 접수 상태' }), { target: { value: enabled ? 'enabled' : 'disabled' } })
  fireEvent.change(screen.getByRole('textbox', { name: '정기 접수 변경 사유' }), { target: { value: reason } })
}
const review = () => fireEvent.click(screen.getByRole('button', { name: '정기 접수 변경 내용 확인' }))
const save = () => fireEvent.click(screen.getByRole('button', { name: '확인한 정기 접수 설정 저장' }))
const posts = (fetch: ReturnType<typeof setup>) => fetch.mock.calls.filter(([, options]) => options?.method === 'POST')
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('정기 접수 관리자 설정', () => {
  it('꺼진 상태에도 설정과 별도 유료 차단을 보여주며 선택·확인만으로 저장하지 않는다', async () => {
    const fetch = setup(); mount()
    await choose()
    expect(screen.getAllByText('서버에서 차단됨')).toHaveLength(2)
    expect(screen.getByText(/서버 초기 설정/)).toBeTruthy()
    expect(screen.getByText(/아직 관리자가 저장한 변경 이력이 없습니다/)).toBeTruthy()
    expect(posts(fetch)).toHaveLength(0)
    review()
    expect(screen.getByText(/도래한 일정이 접수될 수 있습니다/)).toBeTruthy()
    expect(screen.getByText(/실제 유료 실행을 켜거나 예산·계획을 등록하지 않습니다/)).toBeTruthy()
    expect(posts(fetch)).toHaveLength(0)
    expect(fetch.mock.calls.every(([url]) => url === '/api/v1/ops/schedules/settings')).toBe(true)
  })

  it('현재 상태와 같거나 사유가 공백이면 확인 버튼을 막는다', async () => {
    setup(); mount()
    await screen.findByRole('combobox')
    expect(screen.getByRole('button', { name: '정기 접수 변경 내용 확인' }).hasAttribute('disabled')).toBe(true)
    await choose(true, '   ')
    expect(screen.getByRole('button', { name: '정기 접수 변경 내용 확인' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe('500')
  })

  it('최종 확인 시 관리자 세션과 CSRF를 검사하고 접수 설정만 저장한다', async () => {
    const fetch = setup(); const onSaved = vi.fn(); mount({ onSaved })
    await choose(true, '  승인 계획의 접수 준비  '); review(); save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    const [url, options] = posts(fetch)[0]
    expect(url).toBe('/api/v1/ops/schedules/settings')
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json', 'X-CSRFToken': 'csrf-test' })
    expect(JSON.parse(options?.body as string)).toEqual({ request_id: expect.any(String), expected_revision: 0, enabled: true, reason: '승인 계획의 접수 준비' })
    expect(posts(fetch)).toHaveLength(1)
    await screen.findByRole('combobox')
    expect(screen.getByText(/현재 정기 접수는 활성/)).toBeTruthy()
    expect(screen.getByText(/버전 1 · 비활성 → 활성/)).toBeTruthy()
    expect(screen.getAllByText('서버에서 차단됨')).toHaveLength(2)
  })

  it('비활성 변경은 이미 접수된 실행을 취소하지 않는다고 확인받는다', async () => {
    setup({ get: async () => json({ ...initial, enabled: true, live_enabled: true, rag_live_enabled: true }) }); mount()
    await choose(false, '정기 실행 점검'); review()
    expect(screen.getByText(/이미 접수되었거나 실행 중인 평가는 취소되지 않습니다/)).toBeTruthy()
    expect(screen.getAllByText('서버에서 허용됨')).toHaveLength(2)
  })

  it('응답 유실 후 같은 UUID와 내용으로 재시도하고 외부 새로고침에도 보존한다', async () => {
    let attempts = 0
    const fetch = setup({ post: async (data) => { if (++attempts === 1) throw new TypeError('network'); return json(changeResult(data)) } })
    const onSaved = vi.fn(); const onExpired = vi.fn()
    const view = mount({ onSaved, onExpired, refreshKey: 0 })
    await choose(); review(); save()
    await screen.findByText(/저장이 반영되었을 수 있습니다/)
    expect(screen.getByRole('button', { name: '변경 내용 다시 작성' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<ScheduleSettingsPanel owner="core:81" onSaved={onSaved} onExpired={onExpired} refreshKey={1} />)
    fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 저장 결과 재확인' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(posts(fetch)).toHaveLength(2)
    expect(posts(fetch)[0][1]?.body).toBe(posts(fetch)[1][1]?.body)
  })

  it('다른 관리자가 먼저 변경하면 최신 상태를 조회하고 새 확인을 요구한다', async () => {
    let current = initial
    const fetch = setup({ get: async () => json(current), post: async (data) => {
      current = changeResult(data)
      return json({ code: 'SCHEDULE_SETTINGS_CONFLICT', detail: '새 상태를 확인하세요.' }, 409)
    } })
    mount(); await choose(); review(); save()
    await screen.findByText(/설정이 다른 요청에 의해 변경되었습니다/)
    await screen.findByRole('combobox')
    expect(screen.queryByRole('button', { name: '확인한 정기 접수 설정 저장' })).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('enabled')
    await choose(false, '새 상태 확인 후 중지'); review(); save()
    await waitFor(() => expect(posts(fetch)).toHaveLength(2))
    const before = JSON.parse(posts(fetch)[0][1]?.body as string)
    const after = JSON.parse(posts(fetch)[1][1]?.body as string)
    expect(after.expected_revision).toBe(1)
    expect(after.request_id).not.toBe(before.request_id)
  })

  it('검증 실패는 다시 작성할 수 있고 저장 성공으로 표시하지 않는다', async () => {
    setup({ post: async () => json({}, 400) }); const onSaved = vi.fn(); mount({ onSaved })
    await choose(); review(); save()
    await screen.findByText(/500자 이내의 변경 사유를 확인/)
    expect(await screen.findByRole('combobox')).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it.each([401, 403])('설정 조회 인증 실패 %s를 전달하고 폼을 감춘다', async (status) => {
    setup({ get: async () => json({}, status) }); const onExpired = vi.fn(); mount({ onExpired })
    await screen.findByRole('alert')
    expect(onExpired).toHaveBeenCalledOnce()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('설정 조회 실패를 비활성으로 오인하지 않고 재조회한다', async () => {
    let attempt = 0
    setup({ get: async () => ++attempt === 1 ? json({ enabled: false }) : json(initial) }); mount()
    await screen.findByRole('alert')
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '설정 새로고침' }))
    await screen.findByRole('combobox')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('확인 후 로그인 계정이 바뀌면 저장 요청을 보내지 않는다', async () => {
    const fetch = setup({ session: async () => json({ ...session, user: { id: 'other', username: '다른 관리자' } }) })
    const onExpired = vi.fn(); mount({ onExpired }); await choose(); review(); save()
    await waitFor(() => expect(onExpired).toHaveBeenCalledOnce())
    expect(posts(fetch)).toHaveLength(0)
  })

  it('같은 버튼을 빠르게 눌러도 중복 저장하지 않고 조회 중 화면을 떠나면 응답을 무시한다', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const fetch = setup({ post: () => pending }); const onSaved = vi.fn(); const onExpired = vi.fn()
    const view = mount({ onSaved, onExpired }); await choose(); review(); save()
    fireEvent.click(screen.getByRole('button', { name: '정기 접수 설정 저장 중…' }))
    await waitFor(() => expect(posts(fetch)).toHaveLength(1))
    view.unmount()
    expect(posts(fetch)[0][1]?.signal?.aborted).toBe(true)
    await act(async () => { resolve(json({}, 403)); await pending })
    expect(onSaved).not.toHaveBeenCalled(); expect(onExpired).not.toHaveBeenCalled()
  })

  it('계정 전환은 이전 입력과 확인 화면을 초기화한다', async () => {
    const fetch = setup(); const onExpired = vi.fn(); const onSaved = vi.fn()
    const view = mount({ onExpired, onSaved }); await choose(); review()
    view.rerender(<ScheduleSettingsPanel owner="core:82" onExpired={onExpired} onSaved={onSaved} />)
    await screen.findByRole('combobox')
    expect(screen.queryByRole('button', { name: '확인한 정기 접수 설정 저장' })).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect(posts(fetch)).toHaveLength(0)
  })

  it('관리자 세션 확인 중 화면을 떠나면 뒤늦게 저장 요청을 보내지 않는다', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const fetch = setup({ session: () => pending })
    const view = mount(); await choose(); review(); save()
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/ops/session')).toBe(true))
    view.unmount()
    await act(async () => { resolve(json(session)); await pending })
    expect(posts(fetch)).toHaveLength(0)
  })

  it('재확인 응답의 현재 설정이 이후 변경되었으면 원래 변경 결과와 현재 상태를 구분한다', async () => {
    let current = initial
    setup({ get: async () => json(current), post: async (data) => {
      const result = changeResult(data)
      current = { ...result, enabled: false, revision: 2, changes: [{ ...result.change, request_id: crypto.randomUUID(), revision: 2, previous_enabled: true, enabled: false }, result.change] }
      return json({ ...current, change: result.change })
    } })
    const onSaved = vi.fn(); mount({ onSaved }); await choose(); review(); save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(await screen.findByText(/활성 변경을 확인했습니다. 현재 정기 접수는 비활성/)).toBeTruthy()
    await screen.findByRole('combobox')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('disabled')
  })

  it.each(['request_id', 'actor', 'reason', 'revision', 'enabled'])('저장 응답의 %s가 요청과 다르면 성공으로 처리하지 않는다', async (field) => {
    setup({ post: async (data) => {
      const result = changeResult(data)
      return json({ ...result, change: { ...result.change, [field]: field === 'revision' ? 3 : field === 'enabled' ? false : field === 'request_id' ? crypto.randomUUID() : 'different' } })
    } })
    const onSaved = vi.fn(); mount({ onSaved }); await choose(); review(); save()
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '같은 요청으로 저장 결과 재확인' })).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })
})
