// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import App from './App'
import { appContainer } from './app/appContainer'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { createAppStore } from './app/store'
import { getEvaluation } from './data/ops/opsApi'

const id = '10000000-0000-4000-8000-000000000001'
const flowId = '20000000-0000-4000-8000-000000000002'
const dataset = { id: 'target-coverage-20260907-v1', label: '지원 대상 근거 답변 · 저장된 가상 평가 6건' }
const completed = {
  id, dataset_id: dataset.id, dataset_label: dataset.label, requested_by: 'operator@example.com', can_retry: false,
  status: 'COMPLETED', status_label: '완료', created_at: '2026-09-27T00:00:00Z',
  started_at: null, finished_at: null, synced_at: null, error_code: '', error_message: '',
  summary: { caseCount: 6, observedCaseCount: 6, statusAccuracy: 1, referenceCitationRecall: 1, semanticFaithfulness: null },
  model_api_calls: 0, evaluation_run_id: 'a'.repeat(32), prefect_flow_run_id: flowId,
  prefect_url: `http://localhost:14200/v2/runs/flow-run/${flowId}`,
  langfuse_url: 'http://localhost:13000/project/development/scores?filter=test',
  report_url: `/api/v1/ops/evaluations/${id}/report`,
}
let authenticated = true
let fetchMock: Mock<(path: string, options?: RequestInit) => Promise<Response>>
const session = () => ({ user: authenticated ? { username: 'operator@example.com' } : null, csrf_token: authenticated ? 'rotated-token' : 'anonymous-token', datasets: authenticated ? [dataset] : [] })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  authenticated = true
  fetchMock = vi.fn(async (path: string, _options?: RequestInit) => {
    if (path === '/api/v1/ops/session') return json(session())
    if (String(path).endsWith('/api/v1/auth/logout')) { authenticated = false; return new Response(null, { status: 204 }) }
    if (path.startsWith('/api/v1/ops/evaluations?page=')) return json({ count: 1, next: null, previous: null, results: [completed] })
    if (path === `/api/v1/ops/evaluations/${id}`) return json(completed)
    if (path === '/api/v1/ops/evaluations') return json(completed, 202)
    throw new Error(`예상하지 않은 호출: ${path}`)
  })
  vi.spyOn(appContainer.resolve('logInUseCase'), 'execute').mockImplementation(async () => {
    authenticated = true
    return { outcome: 'session', session: { account: { email: 'operator@example.com', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, company: null }, expiresAt: '2026-12-01T00:00:00+09:00' } }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function open(path = '/ops/evaluations') {
  return render(<Provider store={createAppStore()}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Provider>)
}

describe('React LLMOps 운영 화면', () => {
  it('기존 로그인 화면으로 갔다가 같은 Ops 상세로 돌아오고 Core 로그아웃을 실행한다', async () => {
    authenticated = false
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'LLMOps 로그인' })).toBeNull()
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'operator@example.com' } })
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'valid-password' } })
    fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))
    expect(await screen.findByRole('region', { name: '평가 결과' })).toBeTruthy()
    expect(appContainer.resolve('logInUseCase').execute).toHaveBeenCalledWith({ email: 'operator@example.com', password: 'valid-password', rememberMe: false })
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }))
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeTruthy()
    const logoutOptions = fetchMock.mock.calls.find(([path]) => path.endsWith('/api/v1/auth/logout'))?.[1]
    expect(logoutOptions?.credentials).toBe('include')
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/api/v1/ops/login'))).toBe(false)
  })

  it('일반 회원은 기존 서비스 로그인 상태를 유지하면서 Ops 접근이 차단된다', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'denied' }, 403))
    const store = createAppStore()
    store.dispatch(sessionRestored({ email: 'member@example.com', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }))
    render(<Provider store={store}><MemoryRouter initialEntries={['/ops/evaluations']}><App /></MemoryRouter></Provider>)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('관리자 계정만'))
    expect(screen.queryByRole('button', { name: '평가 실행' })).toBeNull()
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy()
  })

  it('완료 결과와 인증 보고서·외부 기록 링크를 표시한다', async () => {
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('link', { name: 'Evidently 보고서' })).toHaveProperty('pathname', completed.report_url)
    expect(screen.getByRole('link', { name: 'Langfuse 평가 점수' }).getAttribute('href')).toBe(completed.langfuse_url)
    expect(screen.getByText('6 / 6')).toBeTruthy()
    expect(screen.getByText('0회')).toBeTruthy()
    expect(screen.getByText(/의미 충실도는 미측정/)).toBeTruthy()
  })

  it('접수 응답 유실 뒤 같은 UUID로 재시도하며 503의 저장 요청 상세를 연다', async () => {
    const original = fetchMock.getMockImplementation()!
    const requests: string[] = []
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/ops/evaluations') {
        requests.push(JSON.parse(String(options?.body)).request_id)
        if (requests.length === 1) throw new TypeError('connection lost')
        return json({ ...completed, status: 'REQUESTED', status_label: '접수 중', can_retry: true, prefect_flow_run_id: null, report_url: null }, 503)
      }
      return original(path, options)
    })
    open()
    fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
    expect(await screen.findByRole('button', { name: '같은 요청으로 재시도' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
    expect(await screen.findByRole('heading', { name: '평가 실행 상세' })).toBeTruthy()
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(requests[1])
  })

  it('실행 중 상태를 조회하다 완료되면 자동 조회를 멈춘다', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json(++reads === 1 ? { ...completed, status: 'RUNNING', status_label: '실행 중', report_url: null } : completed)
      return original(path, options)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    open(`/ops/evaluations/${id}`)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('실행 중')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText('완료')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(reads).toBe(2)
  })

  it('목록 실패를 빈 목록으로 숨기지 않고 재조회하며 페이지를 이동한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let lists = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path.startsWith('/api/v1/ops/evaluations?page=')) {
        if (++lists === 1) return json({}, 502)
        return json({ count: 26, next: path.endsWith('page=1') ? '?page=2' : null, previous: null, results: [completed] })
      }
      return original(path, options)
    })
    open()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('아직 실행한 평가가 없습니다.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }))
    await screen.findByRole('heading', { name: '실행 이력 · 26건' })
    fireEvent.click(screen.getByRole('button', { name: '다음' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/ops/evaluations?page=2', expect.anything()))
  })

  it('세션 만료 시 결과 대신 운영자 로그인을 보여 준다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => {
      if (path.includes('/evaluations')) { authenticated = false; return json({}, 401) }
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '평가 결과' })).toBeNull()
  })

  it('결과 파일 오류를 완료로 표시하지 않고 접수 재확인에도 기존 요청을 쓴다', async () => {
    const original = fetchMock.getMockImplementation()!
    let submitted = false
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/ops/evaluations') {
        expect(JSON.parse(String(options?.body))).toEqual({ request_id: id, dataset_id: dataset.id })
        submitted = true
        return json({ ...completed, status: 'QUEUED', status_label: '실행 대기', report_url: null })
      }
      if (path === `/api/v1/ops/evaluations/${id}`) return json(submitted
        ? { ...completed, status: 'RESULT_ERROR', status_label: '결과 확인 실패', report_url: null, error_code: 'RESULTS_UNAVAILABLE', error_message: '결과 파일을 확인할 수 없습니다.' }
        : { ...completed, status: 'REQUESTED', status_label: '접수 중', can_retry: true, prefect_flow_run_id: null, report_url: null })
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: '같은 요청으로 접수 재확인' }))
    expect(await screen.findByText('결과 확인 실패')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('결과 파일을 확인할 수 없습니다.')
    expect(screen.queryByRole('link', { name: 'Evidently 보고서' })).toBeNull()
    expect(screen.queryByRole('region', { name: '평가 결과' })).toBeNull()
  })

  it('잘못된 응답이나 실행 가능한 외부 링크를 렌더링하지 않는다', async () => {
    fetchMock.mockResolvedValue(json({ ...completed, langfuse_url: 'javascript:alert(1)' }))
    await expect(getEvaluation(id)).rejects.toThrow('운영 서버 응답을 확인할 수 없습니다.')
  })
})
