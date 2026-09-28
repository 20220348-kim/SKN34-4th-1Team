// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import App from './App'
import { appContainer } from './app/appContainer'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { createAppStore } from './app/store'
import { readPendingEvaluation, storePendingEvaluation } from './data/ops/pendingEvaluation'
import { getEvaluation } from './data/ops/opsApi'

const id = '10000000-0000-4000-8000-000000000001'
const flowId = '20000000-0000-4000-8000-000000000002'
const capture = { id: 'target-coverage-20260907-v1', label: '저장 캡처' }
const liveConfig = { model: 'gpt-6-luna', fixture_sha256: 'c'.repeat(64), max_model_calls: 6, max_output_tokens: 2000 }
const dataset = { baseline: null, fixture: 'target-coverage-fixture.json', live_config: liveConfig, id: capture.id, label: '지원 대상 근거 답변 · 저장된 가상 평가 6건', case_ids: ['TC01', 'TC02', 'TC03', 'TC04', 'TC05', 'TC06'], captures: [capture] }
const comparisonDataset = { baseline: null, fixture: 'fixture.json', live_config: { ...liveConfig, max_model_calls: 1 }, id: 'fixed-context-e01-v1', label: '공통 E01 비교', case_ids: ['E01'], captures: [{ id: 'reference', label: '기준 프롬프트' }, { id: 'candidate', label: '후보 프롬프트' }] }
const completed = {
  execution_mode: 'replay', live_config: null, trace_links: [],
  candidate_capture_id: capture.id, reference_capture_id: capture.id, candidate_label: capture.label, reference_label: capture.label, comparison: null,
  id, dataset_id: dataset.id, dataset_label: dataset.label, requested_by: 'operator@example.com', requested_by_id: 'core:99', can_retry: false,
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
const session = () => ({ live_enabled: true, user: authenticated ? { id: 'core:99', username: 'operator@example.com' } : null, csrf_token: authenticated ? 'rotated-token' : 'anonymous-token', datasets: authenticated ? [dataset, comparisonDataset] : [] })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  authenticated = true
  sessionStorage.clear()
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(id)
  fetchMock = vi.fn(async (path: string, _options?: RequestInit) => {
    if (path === '/api/v1/ops/session') return json(session())
    if (String(path).endsWith('/api/v1/auth/logout')) { authenticated = false; return new Response(null, { status: 204 }) }
    if (path.startsWith('/api/v1/ops/evaluations?page=')) return json({ count: 1, next: null, previous: null, results: [completed] })
    if (path === `/api/v1/ops/evaluations/${id}/review`) return json({ is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [], material: null, material_error: '' })
    if (path === `/api/v1/ops/evaluations/${id}`) return json(completed)
    if (path === '/api/v1/ops/evaluations') return json(completed, 202)
    if (/^\/api\/v1\/ops\/evaluations\/[a-f0-9-]+$/.test(path)) return json({}, 404)
    throw new Error(`예상하지 않은 호출: ${path}`)
  })
  vi.spyOn(appContainer.resolve('logInUseCase'), 'execute').mockImplementation(async () => {
    authenticated = true
    return { outcome: 'session', session: { account: { email: 'operator@example.com', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }, expiresAt: '2026-12-01T00:00:00+09:00' } }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function open(path = '/ops/evaluations') {
  return render(<Provider store={createAppStore()}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Provider>)
}

describe('React LLMOps 운영 화면', () => {
  it('상세를 열지 않아도 목록을 갱신하고 상태 확인 지연과 복구를 표시한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path.startsWith('/api/v1/ops/evaluations?page=')) return json({ count: 1, next: null, previous: null, results: [++reads === 1
        ? { ...completed, status: 'RUNNING', status_label: '실행 중', status_stale: true,
            error_message: '실행 서버에 연결할 수 없습니다.', report_url: null }
        : { ...completed, synced_at: '2026-09-27T00:01:00Z', status_stale: false }] })
      return original(path, options)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const view = open()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('실행 중')).toBeTruthy()
    expect(screen.getByText(/상태 확인 지연/)).toBeTruthy()
    expect(screen.getByText(/마지막 확인: 아직 확인되지 않음/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText('완료')).toBeTruthy()
    expect(screen.queryByText(/상태 확인 지연/)).toBeNull()
    expect(fetchMock.mock.calls.some(([path]) => path === `/api/v1/ops/evaluations/${id}`)).toBe(false)
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(reads).toBe(2)
  })

  it('목록 자동 갱신 실패 때 기존 결과를 유지하고 다음 조회로 복구한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path.startsWith('/api/v1/ops/evaluations?page=')) {
        if (++reads === 2) return json({}, 503)
        return json({ count: 1, next: null, previous: null, results: [completed] })
      }
      return original(path, options)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    open()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('완료')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('실패 후처리를 새 이력으로 복구하고 원본 연결과 추가 호출 0회를 표시한다', async () => {
    const original = fetchMock.getMockImplementation()!
    const child = '30000000-0000-4000-8000-000000000003'
    const recovered = { ...completed, id: child, execution_mode: 'recovery', source_run_id: id, report_url: `/api/v1/ops/evaluations/${child}/report` }
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({ ...completed, status: 'FAILED', report_url: null, postprocessing: {
        inputs_ready: true, stage: 'publish', can_recover: true, blocked_reason: '', attempts: [],
      } })
      if (path === `/api/v1/ops/evaluations/${id}/recover`) return json(recovered, 202)
      if (path === `/api/v1/ops/evaluations/${child}`) return json(recovered)
      if (path === `/api/v1/ops/evaluations/${child}/review`) return json({ is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [], material: null, material_error: '' })
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: '후처리 다시 실행' }))
    const link = await screen.findByRole('link', { name: '원본 실행과 실패 기록 보기' })
    expect(link.getAttribute('href')).toBe(`/ops/evaluations/${id}`)
    expect(screen.getByText(/추가 모델 호출은 0회/)).toBeTruthy()
    const options = fetchMock.mock.calls.find(([path]) => path.endsWith('/recover'))![1]!
    expect(Object.keys(JSON.parse(String(options.body)))).toEqual(['request_id'])
    expect(options.credentials).toBe('same-origin')
    expect(options.headers).toMatchObject({ 'X-CSRFToken': 'rotated-token' })
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/ops/evaluations')).toBe(false)
  })

  it('복구 접수 응답 유실과 재확인 모두 같은 UUID와 복구 API를 사용한다', async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue('30000000-0000-4000-8000-000000000003')
    const original = fetchMock.getMockImplementation()!
    const requests: string[] = []
    let child = ''
    const pending = () => ({ ...completed, id: child, execution_mode: 'recovery', source_run_id: id,
      status: 'REQUESTED', can_retry: true, prefect_flow_run_id: null, report_url: null })
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({ ...completed, status: 'FAILED', postprocessing: {
        inputs_ready: true, stage: 'report', can_recover: true, blocked_reason: '', attempts: [],
      } })
      if (path === `/api/v1/ops/evaluations/${id}/recover`) {
        child = JSON.parse(String(options?.body)).request_id
        requests.push(child)
        if (requests.length === 1) throw new TypeError('response lost')
        return json(pending(), 503)
      }
      if (child && path === `/api/v1/ops/evaluations/${child}`) return json(pending())
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: '후처리 다시 실행' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('연결할 수 없습니다'))
    const recoverAgain = screen.getByRole('button', { name: '후처리 다시 실행' })
    await waitFor(() => expect(recoverAgain).toHaveProperty('disabled', false))
    fireEvent.click(recoverAgain)
    await waitFor(() => expect(requests).toHaveLength(2))
    const retry = await screen.findByRole('button', { name: '같은 요청으로 접수 재확인' })
    await waitFor(() => expect(retry).toHaveProperty('disabled', false))
    fireEvent.click(retry)
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(new Set(requests).size).toBe(1)
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/ops/evaluations')).toBe(false)
  })

  it('불완전한 입력은 복구 버튼을 숨기고 이전 복구 이력을 보여 준다', async () => {
    const original = fetchMock.getMockImplementation()!
    const child = '30000000-0000-4000-8000-000000000003'
    fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}`
      ? json({ ...completed, status: 'FAILED', postprocessing: {
        inputs_ready: false, stage: 'unverified', can_recover: false, blocked_reason: '완료된 응답을 확인할 수 없습니다.',
        attempts: [{ id: child, status: 'CRASHED', status_label: '실행 중단' }],
      } }) : original(path, options))
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByText('완료된 응답을 확인할 수 없습니다.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '후처리 다시 실행' })).toBeNull()
    expect(screen.getByRole('link', { name: '복구 실행 30000000 · 실행 중단' }).getAttribute('href')).toBe(`/ops/evaluations/${child}`)
  })

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
    store.dispatch(sessionRestored({ email: 'member@example.com', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }))
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
    expect(screen.getAllByText('0회')).toHaveLength(2)
    expect(screen.getByText(/의미 충실도는 미측정/)).toBeTruthy()
  })

  it('접수 응답 유실 뒤 같은 UUID로 재시도하며 503의 저장 요청 상세를 연다', async () => {
    const original = fetchMock.getMockImplementation()!
    const requests: string[] = []
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}` && requests.length < 2) return json({}, 404)
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
        expect(JSON.parse(String(options?.body))).toEqual({ request_id: id, dataset_id: dataset.id, candidate_capture_id: capture.id, reference_capture_id: capture.id, execution_mode: 'replay', live_config: {}, confirm_paid_run: false, baseline_version: null })
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
  it('자료에 맞는 기준·후보를 선택하고 접수 재시도에서도 두 선택을 유지한다', async () => {
    const original = fetchMock.getMockImplementation()!
    const bodies: unknown[] = []
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({}, 404)
      if (path === '/api/v1/ops/evaluations') {
        bodies.push(JSON.parse(String(options?.body)))
        throw new TypeError('connection lost')
      }
      return original(path, options)
    })
    open()
    const select = await screen.findByLabelText('평가 자료')
    fireEvent.change(select, { target: { value: comparisonDataset.id } })
    expect((screen.getByLabelText('기준 실행') as HTMLSelectElement).value).toBe('reference')
    expect((screen.getByLabelText('후보 실행') as HTMLSelectElement).value).toBe('candidate')
    expect(screen.getByText(/비교 범위: E01/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '평가 실행' }))
    await screen.findByRole('button', { name: '같은 요청으로 재시도' })
    expect((screen.getByLabelText('후보 실행') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toMatchObject({ dataset_id: comparisonDataset.id, reference_capture_id: 'reference', candidate_capture_id: 'candidate' })
  })

  it('지표 차이와 원본 범위를 표시하고 미측정을 0으로 바꾸지 않는다', async () => {
    const execution = { run_id: 'a'.repeat(32), model: 'test-model', prompt_sha256: 'p'.repeat(64), runner_sha256: 'r'.repeat(64), capture_sha256: 'c'.repeat(64), started_at: null, source_case_ids: ['E01'] }
    const comparison = { schema_version: 2, comparison: 'candidate-reference', case_ids: ['E01'],
      reference_execution: execution, candidate_execution: { ...execution, source_case_ids: ['E01', 'E07', 'E10', 'E12'] },
      metrics: [
        { key: 'meanOutputTokens', reference: 128, candidate: 91, delta: -37 },
        { key: 'statusAccuracy', reference: 0, candidate: 1, delta: 1 },
        { key: 'semanticFaithfulness', reference: null, candidate: null, delta: null },
      ], cases: [],
    }
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}` ? json({ ...completed, comparison }) : original(path, options))
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('region', { name: '기준·후보 비교' })).toBeTruthy()
    expect(screen.getByText('-37.00')).toBeTruthy()
    expect(screen.getByText('+1.00')).toBeTruthy()
    expect(screen.getByText('비교 불가')).toBeTruthy()
    expect(screen.getAllByText('미측정')).toHaveLength(2)
    expect(screen.getByText('원본 사례: E01, E07, E10, E12')).toBeTruthy()
  })

})

it('새 모델 평가는 전송 자료와 호출 예산 확인 후 한 번만 접수한다', async () => {
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  const button = screen.getByRole('button', { name: '새 응답 생성 및 평가' })
  expect(button).toHaveProperty('disabled', true)
  expect(screen.getByText('gpt-6-luna')).toBeTruthy()
  expect(screen.queryByLabelText('후보 실행')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  const posts = fetchMock.mock.calls.filter(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ execution_mode: 'live', candidate_capture_id: 'new-model-response', live_config: liveConfig, confirm_paid_run: true })
})

it('평가 자료를 바꾸면 기존 예산 확인을 해제한다', async () => {
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('평가 자료'), { target: { value: comparisonDataset.id } })
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/최대 1회/)).toBeTruthy()
})

it('서버에서 비활성화한 새 모델 평가를 접수하지 않는다', async () => {
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session' ? Promise.resolve(json({ ...session(), live_enabled: false })) : fallback(path, options))
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
})

it('새 평가의 호출 수와 사례별 추적 링크를 표시하고 과거 재현 문구를 쓰지 않는다', async () => {
  fetchMock.mockResolvedValueOnce(json(session())).mockResolvedValueOnce(json({ ...completed, execution_mode: 'live', live_config: liveConfig, model_api_calls: 6, langfuse_url: null, trace_links: [{ case_id: 'TC01', url: 'http://localhost:13000/project/test/traces/abc' }] }))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByRole('link', { name: 'Langfuse TC01 추적·점수' })).toHaveProperty('href', 'http://localhost:13000/project/test/traces/abc')
  expect(screen.queryByText(/새 모델 호출은 없으며/)).toBeNull()
  expect(screen.getAllByText('6회').length).toBeGreaterThan(0)
})

const reviewMaterial = {
  capture_sha256: 'd'.repeat(64), fixture_sha256: 'c'.repeat(64),
  cases: [{ case_id: 'E01', question: '지원 대상은 누구인가요?', document_title: '가상 공고',
    evidence: [{ order: 0, text: '서울 소재 법인만 가능합니다.' }],
    answer: '<script>후보 답변은 텍스트로 표시</script>', answer_status: 'ANSWERED', cited_orders: [0],
    reference_answer: '과거 기준 답변', expected_status: 'ANSWERED', expected_citation_orders: [0],
    reference_facts: ['서울 소재 법인'], forbidden_claims: ['개인도 신청 가능'],
  }],
}

it('근거·응답을 검토한 후 의견과 승인 기록을 저장하고 기준을 지정한다', async () => {
  const original = fetchMock.getMockImplementation()!
  let state = { material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] as Array<{ id: number; decision: string; comment: string; capture_sha256: string; reviewed_by: string; created_at: string }> }
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}/review`) {
      if (options?.method === 'POST') {
        expect(options.headers).toMatchObject({ 'X-CSRFToken': 'rotated-token' })
        const input = JSON.parse(String(options.body))
        state = { ...state, reviews: [{ ...input, id: 1, reviewed_by: 'operator@example.com', created_at: completed.created_at }] }
      }
      return json(state)
    }
    if (path === `/api/v1/ops/evaluations/${id}/baseline`) {
      expect(JSON.parse(String(options?.body))).toEqual({ review_id: 1, baseline_version: 0 })
      state = { ...state, is_baseline: true }
      return json(state)
    }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText('서울 소재 법인만 가능합니다.')).toBeTruthy()
  expect(screen.getByText('<script>후보 답변은 텍스트로 표시</script>')).toBeTruthy()
  expect(document.querySelector('script')).toBeNull()
  const approve = screen.getByRole('button', { name: '검토 승인 저장' })
  const promote = screen.getByRole('button', { name: '비교 기준으로 지정' })
  expect(approve).toHaveProperty('disabled', true)
  expect(promote).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('검토 의견'), { target: { value: '지역과 법인 조건을 확인했습니다.' } })
  fireEvent.click(screen.getByLabelText('위 모든 사례의 질문·근거·후보 답변을 검토했습니다.'))
  fireEvent.click(approve)
  expect(await screen.findByText('검토 기록을 저장했습니다.')).toBeTruthy()
  await waitFor(() => expect(promote).toHaveProperty('disabled', false))
  fireEvent.click(promote)
  expect(await screen.findByText('현재 데이터셋의 비교 기준')).toBeTruthy()
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
})

it('검토 기준을 다음 평가의 기준 선택에 표시하고 후보 목록과 구별한다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
    ? Promise.resolve(json({ ...session(), datasets: [{ ...dataset, baseline: { version: 1, id: `run:${id}`, label: '검토 기준 · 10000000' } }] }))
    : original(path, options))
  open()
  expect(await screen.findByLabelText('기준 실행')).toHaveProperty('value', `run:${id}`)
  expect(screen.getByLabelText('후보 실행')).toHaveProperty('value', capture.id)
  fireEvent.click(screen.getByRole('button', { name: '평가 실행' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  const payload = fetchMock.mock.calls.find(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')?.[1]?.body
  expect(JSON.parse(String(payload))).toMatchObject({ reference_capture_id: `run:${id}`, execution_mode: 'replay' })
})

it('확인할 수 없는 자료를 승인하거나 기준으로 지정하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path.endsWith('/review')
    ? Promise.resolve(json({ material: null, material_error: '검토 자료를 확인할 수 없습니다.', reviews: [], is_baseline: false, baseline_version: 0, baseline_history: [] }))
    : original(path, options))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText('검토 자료를 확인할 수 없습니다.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '검토 승인 저장' })).toBeNull()
  expect(screen.queryByRole('button', { name: '비교 기준으로 지정' })).toBeNull()
})

const pendingRequest = () => ({ request_id: id, dataset_id: dataset.id, candidate_capture_id: 'new-model-response', reference_capture_id: capture.id, live_config: liveConfig, baseline_version: null })

it('유료 접수 응답 유실 후 새로고침·재로그인하면 기존 요청만 조회한다', async () => {
  const original = fetchMock.getMockImplementation()!
  let modelCalls = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v1/ops/evaluations') { modelCalls++; throw new TypeError('accepted but response lost') }
    return original(path, options)
  })
  const view = open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: '새 응답 생성 및 평가' }))
  await screen.findByRole('button', { name: '같은 요청으로 재시도' })
  expect(readPendingEvaluation('core:99')).toEqual(pendingRequest())
  view.unmount()
  authenticated = false
  open()
  await screen.findByRole('heading', { name: '로그인' })
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'operator@example.com' } })
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'valid-password' } })
  fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  expect(modelCalls).toBe(1)
  expect(readPendingEvaluation('core:99')).toBeNull()
})

it('서버에 없는 보관 요청은 자동 전송하지 않고 확인 후 같은 UUID와 조건으로 접수한다', async () => {
  storePendingEvaluation('core:99', pendingRequest())
  const original = fetchMock.getMockImplementation()!
  let accepted = false
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}` && !accepted) return json({}, 404)
    if (path === '/api/v1/ops/evaluations') {
      expect(JSON.parse(String(options?.body))).toMatchObject({ ...pendingRequest(), execution_mode: 'live', confirm_paid_run: true })
      accepted = true
    }
    return original(path, options)
  })
  open()
  await screen.findByText(/아직 접수된 요청을 찾지 못했습니다/)
  expect(accepted).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  expect(accepted).toBe(true)
  expect(readPendingEvaluation('core:99')).toBeNull()
})

it('다른 관리자의 보관 요청은 복원하거나 제거하지 않는다', async () => {
  storePendingEvaluation('core:other', pendingRequest())
  open()
  await screen.findByRole('button', { name: '평가 실행' })
  expect(screen.queryByText(/보관한 요청:/)).toBeNull()
  expect(fetchMock.mock.calls.some(([path]) => path === `/api/v1/ops/evaluations/${id}`)).toBe(false)
  expect(readPendingEvaluation('core:other')).toEqual(pendingRequest())
})

it('손상된 보관 요청은 지우고 새 유료 요청을 만드는 대신 접수를 차단한다', async () => {
  sessionStorage.setItem('govbiz.ops.pending.v1.core%3A99', '{broken')
  open()
  await screen.findByText(/보관한 요청을 읽을 수 없습니다/)
  expect(screen.getByRole('button', { name: '평가 실행' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('요청 보관에 실패하면 네트워크 접수를 시작하지 않는다', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
  await screen.findByText(/요청을 보관할 수 없어 전송하지 않았습니다/)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('복원 조회 장애는 새 UUID 생성이나 자동 재접수로 처리하지 않는다', async () => {
  storePendingEvaluation('core:99', pendingRequest())
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}` ? json({}, 503) : original(path, options))
  open()
  await screen.findByText(/관리자 인증 또는 운영 서버에 연결할 수 없습니다/)
  expect(readPendingEvaluation('core:99')).toEqual(pendingRequest())
  expect(crypto.randomUUID).not.toHaveBeenCalled()
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('서버가 접수를 거절한 조건은 명시적으로 다시 선택하고 기존 유료 확인을 해제한다', async () => {
  storePendingEvaluation('core:99', pendingRequest())
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}`) return json({}, 404)
    if (path === '/api/v1/ops/evaluations') return json({ code: 'INVALID_REFERENCE' }, 400)
    return original(path, options)
  })
  open()
  await screen.findByText(/아직 접수된 요청을 찾지 못했습니다/)
  expect(screen.getByLabelText('실행 방식')).toHaveProperty('value', 'live')
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
  fireEvent.click(await screen.findByRole('button', { name: '접수되지 않은 조건 다시 선택' }))
  await screen.findByRole('button', { name: '평가 실행' })
  expect(readPendingEvaluation('core:99')).toBeNull()
  fireEvent.change(screen.getByLabelText('실행 방식'), { target: { value: 'live' } })
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

it('접수 전 관리자 계정이 바뀌면 보관 요청을 다른 계정으로 전송하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  let sessions = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v1/ops/session' && ++sessions > 1) return json({ ...session(), user: { id: 'core:other', username: 'other@example.com' } })
    return original(path, options)
  })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
  await screen.findByText('other@example.com')
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
  expect(readPendingEvaluation('core:99')?.request_id).toBe(id)
})

it.each([true, false])('자료 확인 가능 여부(%s)와 무관하게 기준 해제는 버전과 사유를 보내고 이력을 표시한다', async (available) => {
  const original = fetchMock.getMockImplementation()!
  const state = { material: available ? reviewMaterial : null, material_error: available ? '' : '저장 자료 손상', reviews: [], is_baseline: true, baseline_version: 1, baseline_history: [] }
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return json(state)
    if (path.endsWith('/baseline')) {
      expect(options?.method).toBe('DELETE')
      expect(JSON.parse(String(options?.body))).toEqual({ baseline_version: 1, reason: '조건 오류 재검토' })
      return json({ ...state, is_baseline: false, baseline_version: 2, baseline_history: [{ version: 2, previous_run_id: id, run_id: null, capture_sha256: null, fixture_sha256: 'c'.repeat(64), changed_by: 'operator@example.com', reason: '조건 오류 재검토', created_at: completed.created_at }] })
    }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  await screen.findByText('현재 데이터셋의 비교 기준')
  fireEvent.change(screen.getByLabelText('검토 의견'), { target: { value: '조건 오류 재검토' } })
  fireEvent.click(screen.getByRole('button', { name: '의견을 사유로 기준 해제' }))
  await screen.findByText('비교 기준을 해제했습니다.')
  expect(screen.getByText(/버전 2 · 해제/)).toBeTruthy()
})
