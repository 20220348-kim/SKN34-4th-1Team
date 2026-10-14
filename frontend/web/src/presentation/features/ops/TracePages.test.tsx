// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TraceDetailPage, TraceListPage } from './TracePages'

const from = '2026-10-07T00:00:00Z'
const to = '2026-10-14T00:00:00Z'
const traceId = 'abcdef1234567890abcdef1234567890'
const root = {
  id: 'root-001', trace_id: traceId, name: 'search.total', type: 'SPAN',
  started_at: '2026-10-13T09:00:00Z', ended_at: null, level: 'DEFAULT', status_message: null, model: null,
  latency_seconds: null, total_cost: null, environment: 'production',
}
const child = {
  ...root, id: 'child-02', name: 'search.ranking.model', type: 'GENERATION', parent_observation_id: root.id,
  input: '<img src=x onerror=alert(1)>', output: '<script>alert(2)</script>',
  metadata: { source: '정부지원사업' }, usage_details: { input: 123, output: 42 }, model: 'gpt-6-luna',
}
const callSummary = { models: ['gpt-6-luna'], call_count: 1, missing_model_count: 0, recorded_cost: 0.0001952, missing_cost_count: 0, status: 'complete' }
const listRoot = { ...root, call_summary: callSummary }
const page = { results: [listRoot], from_time: from, to_time: to, next_cursor: 'page-2' }
const detail = {
  trace_id: traceId, next_cursor: null,
  observations: [{ ...root, parent_observation_id: null, input: null, output: null, metadata: null, usage_details: null }, child],
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function mount(url = '/ops/traces', onExpired = vi.fn()) {
  return render(<MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/ops/traces" element={<TraceListPage onExpired={onExpired} />} />
    <Route path="/ops/traces/:traceId" element={<TraceDetailPage onExpired={onExpired} />} />
  </Routes></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('관리자 AI 실행 추적', () => {
  it('동일 trace의 루트 단계를 각각 표시하고 다음 페이지에 고정 기간과 필터를 유지한다', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...page, results: [listRoot, { ...listRoot, id: 'root-002' }] })).mockResolvedValue(json({ ...page, results: [], next_cursor: null }))
    vi.stubGlobal('fetch', fetch)
    mount('/ops/traces?name=support-program-search')
    expect(await screen.findByRole('link', { name: '공고 검색 · root-001' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '공고 검색 · root-002' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다음 페이지' }))
    await screen.findByRole('heading', { name: '이 기간에 기록된 실행이 없습니다.' })
    const query = new URL(fetch.mock.calls[1][0], 'https://govbiz.test').searchParams
    expect(Object.fromEntries(query)).toEqual({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'page-2' })
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    expect(screen.getByRole('button', { name: '다음 페이지' })).toHaveProperty('disabled', true)
  })

  it.each([
    ['support-program-search', '공고 검색', 'search.total'],
    ['assistant-agent', 'AI 도우미 에이전트', 'assistant.agent'],
    ['support-program-evidence', '공고 근거 답변', 'evidence.answer'],
  ])('%s 업무·기간을 조회하면 페이지를 초기화하고 해당 업무 결과를 표시한다', async (name, label, observationName) => {
    const results = [
      listRoot,
      { ...listRoot, id: 'agent-01', name: 'assistant.agent' },
      { ...listRoot, id: 'answer-1', name: 'evidence.answer' },
    ]
    const filterNames: Record<string, string> = {
      'support-program-search': 'search.total', 'assistant-agent': 'assistant.agent', 'support-program-evidence': 'evidence.answer',
    }
    const fetch = vi.fn(async (url: string) => {
      const selected = new URL(url, 'https://govbiz.test').searchParams.get('name')
      return json({ ...page, results: selected ? results.filter((item) => item.name === filterNames[selected]) : results })
    })
    vi.stubGlobal('fetch', fetch)
    mount(`/ops/traces?${new URLSearchParams({ from_time: from, to_time: to, cursor: 'old-cursor' })}`)
    await screen.findByRole('link', { name: '공고 검색 · root-001' })
    expect(screen.getAllByRole('article')).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('실행 이름'), { target: { value: name } })
    fireEvent.change(screen.getByLabelText('조회 기간'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: /^조회$/ }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const query = new URL(fetch.mock.calls[1][0], 'https://govbiz.test').searchParams
    expect(query.get('name')).toBe(name)
    expect(query.has('cursor')).toBe(false)
    expect(Date.parse(query.get('to_time')!) - Date.parse(query.get('from_time')!)).toBe(30 * 86_400_000)
    const selected = results.find((item) => item.name === observationName)!
    await screen.findByRole('link', { name: `${label} · ${selected.id}` })
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('article').textContent).toContain(observationName)
    expect(screen.getByText(/선택 업무의 서비스별 시작 단계를 최신순으로 조회/)).toBeTruthy()
    expect(screen.getByText(/최신순 고정/)).toBeTruthy()
  })

  it('상세에서 부모 단계와 입력·출력을 안전한 텍스트로 읽고 같은 목록으로 복귀한다', async () => {
    const fetch = vi.fn(async (url: string) => json(url.startsWith(`/api/v1/ops/traces/${traceId}`) ? detail : page))
    vi.stubGlobal('fetch', fetch)
    mount(`/ops/traces?${new URLSearchParams({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'list-2' })}`)
    fireEvent.click(await screen.findByRole('link', { name: '공고 검색 · root-001' }))
    const stages = await screen.findByRole('region', { name: '실행 단계' })
    expect(within(stages).getByText(/상위 단계: 공고 검색 \(root-001\)/)).toBeTruthy()
    expect(within(stages).getByText(child.input)).toBeTruthy()
    expect(within(stages).getByText(child.output)).toBeTruthy()
    expect(stages.querySelectorAll('img,script,iframe').length).toBe(0)
    const back = screen.getByRole('link', { name: '← 조회하던 실행 목록으로' })
    expect(new URL(back.getAttribute('href')!, 'https://govbiz.test').searchParams.get('from_time')).toBe(from)
    fireEvent.click(back)
    await screen.findByRole('link', { name: '공고 검색 · root-001' })
    const query = new URL(fetch.mock.calls.at(-1)![0], 'https://govbiz.test').searchParams
    expect(Object.fromEntries(query)).toEqual({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'list-2' })
  })

  it('상세 페이지 이동은 별도 커서를 사용하고 목록의 커서를 보존한다', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...detail, next_cursor: 'stage-2' })).mockResolvedValue(json({ ...detail, observations: [child] }))
    vi.stubGlobal('fetch', fetch)
    mount(`/ops/traces/${traceId}?${new URLSearchParams({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'list-2' })}`)
    await screen.findByRole('region', { name: '실행 단계' })
    fireEvent.click(screen.getByRole('button', { name: '다음 단계' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][0]).toBe(`/api/v1/ops/traces/${traceId}?cursor=stage-2`)
    const back = new URL(screen.getByRole('link', { name: '← 조회하던 실행 목록으로' }).getAttribute('href')!, 'https://govbiz.test')
    expect(Object.fromEntries(back.searchParams)).toEqual({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'list-2' })
    expect(back.searchParams.has('detail_cursor')).toBe(false)
  })

  it.each([null, '', '   ', '상위 단계 모델'])('SPAN의 모델(%s) 대신 하위 호출의 모델과 비용을 목록에서 바로 보여준다', async (model) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, results: [{ ...listRoot, model, total_cost: 99 }] })))
    mount(`/ops/traces?${new URLSearchParams({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'list-2' })}`)
    const article = await screen.findByRole('article')
    expect(within(article).getByText('모델').nextElementSibling?.textContent).toBe('gpt-6-luna')
    expect(within(article).getByText('기록된 비용 합계 (USD)').nextElementSibling?.textContent).toBe('$0.0001952')
    expect(within(article).getByText('모델 호출 1건')).toBeTruthy()
    expect(within(article).queryByText('모델 호출 단계에서 확인')).toBeNull()
    expect(within(article).queryByText('$0')).toBeNull()
    expect(within(article).queryByText('$99')).toBeNull()
    expect(within(article).getByText('운영 (production)')).toBeTruthy()
    const link = within(article).getByRole('link', { name: '호출 상세 보기 →' })
    const destination = new URL(link.getAttribute('href')!, 'https://govbiz.test')
    expect(destination.pathname).toBe(`/ops/traces/${traceId}`)
    expect(Object.fromEntries(destination.searchParams)).toEqual({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'list-2' })
  })

  it('복수 모델과 8자리 소액 합계를 표시하고 비용 미기록 호출을 구분한다', async () => {
    const call_summary = { ...callSummary, models: ['gpt-6-luna', 'text-embedding-3-small'], call_count: 4, missing_model_count: 1, recorded_cost: 0.00000001, missing_cost_count: 2 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, results: [{ ...listRoot, call_summary }] })))
    mount()
    const article = await screen.findByRole('article')
    expect(within(article).getByText('gpt-6-luna')).toBeTruthy()
    expect(within(article).getByText('text-embedding-3-small')).toBeTruthy()
    expect(within(article).getByText('$0.00000001')).toBeTruthy()
    expect(within(article).getByText('모델 호출 4건 · 모델명 미기록 1건 · 비용 미기록 2건')).toBeTruthy()
    expect(within(article).getByText(/비용이 기록된 호출만 합산한 금액/)).toBeTruthy()
  })

  it('모델명과 비용이 전부 미기록인 호출을 미호출이나 0원으로 표시하지 않는다', async () => {
    const call_summary = { ...callSummary, models: [], call_count: 2, missing_model_count: 2, recorded_cost: null, missing_cost_count: 2 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, results: [{ ...listRoot, call_summary }] })))
    mount()
    const article = await screen.findByRole('article')
    expect(within(article).getByText('모델명 기록 없음')).toBeTruthy()
    expect(within(article).getByText('비용 기록 없음')).toBeTruthy()
    expect(within(article).getByText('모델 호출 2건 · 모델명 미기록 2건 · 비용 미기록 2건')).toBeTruthy()
    expect(within(article).queryByText('기록된 모델 호출 없음')).toBeNull()
    expect(within(article).queryByText('$0')).toBeNull()
  })

  it.each(['complete', 'partial'])('%s 집계의 호출 0건은 조회가 완전할 때만 기록된 호출 없음으로 안내한다', async (status) => {
    const call_summary = { models: [], call_count: 0, missing_model_count: 0, recorded_cost: null, missing_cost_count: 0, status }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, results: [{ ...listRoot, call_summary }] })))
    mount()
    const article = await screen.findByRole('article')
    expect(within(article).getByText(status === 'partial' ? '집계 미완료' : '기록된 모델 호출 없음')).toBeTruthy()
    expect(within(article).getByText('비용 기록 없음')).toBeTruthy()
    expect(within(article).queryByText('$0')).toBeNull()
    if (status === 'partial') {
      expect(within(article).getByText('현재 확인된 모델 호출 0건')).toBeTruthy()
      expect(within(article).getByText(/확인된 비용 기록이 없습니다/)).toBeTruthy()
      expect(within(article).queryByText('기록된 모델 호출 없음')).toBeNull()
    }
  })

  it.each(['complete', 'partial'])('%s 집계에서 실제 기록된 0원과 미기록을 구분한다', async (status) => {
    const call_summary = { ...callSummary, recorded_cost: 0, status }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, results: [{ ...listRoot, call_summary }] })))
    mount()
    const article = await screen.findByRole('article')
    expect(within(article).getByText('$0')).toBeTruthy()
    expect(within(article).queryByText('비용 기록 없음')).toBeNull()
    if (status === 'partial') expect(within(article).getByText(/표시된 비용은 현재 확인된 금액입니다/)).toBeTruthy()
    else expect(within(article).queryByText(/집계가 아직 완전하지 않습니다/)).toBeNull()
  })

  it.each([
    undefined,
    { ...callSummary, call_count: -1 },
    { ...callSummary, call_count: 1.5 },
    { ...callSummary, missing_model_count: 2 },
    { ...callSummary, missing_cost_count: 2 },
    { ...callSummary, recorded_cost: -1 },
    { ...callSummary, recorded_cost: null },
    { ...callSummary, missing_cost_count: 1 },
    { ...callSummary, models: [''] },
    { ...callSummary, models: ['gpt-6-luna', 'gpt-6-luna'], call_count: 2 },
    { ...callSummary, status: 'unknown' },
  ])('누락되거나 잘못된 호출 집계 계약 %#은 정상 비용처럼 표시하지 않는다', async (call_summary) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, results: [{ ...listRoot, call_summary }] })))
    mount()
    expect((await screen.findByRole('alert')).textContent).toContain('AI 실행 추적 응답을 확인할 수 없습니다.')
    expect(screen.queryByRole('article')).toBeNull()
  })

  it.each([
    ['GENERATION', null], ['GENERATION', 0], ['EMBEDDING', null], ['EMBEDDING', 0],
  ] as const)('%s 모델 호출은 펼쳐 표시하며 기록된 비용 %s와 토큰을 그대로 보여준다', async (type, totalCost) => {
    const name = type === 'EMBEDDING' ? 'evidence.embedding.request' : child.name
    const model = type === 'EMBEDDING' ? 'text-embedding-3-small' : child.model
    const observation = { ...child, type, name, model: totalCost === null ? '  ' : model, total_cost: totalCost, environment: 'development' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, observations: [detail.observations[0], observation] })))
    mount(`/ops/traces/${traceId}`)
    const stages = await screen.findByRole('region', { name: '실행 단계' })
    const modelStage = within(stages).getByText('모델 호출 단계').closest('details')!
    expect(modelStage.open).toBe(true)
    expect(modelStage.querySelector('summary')?.textContent).toContain(name)
    expect(within(modelStage).getByText('모델').nextElementSibling?.textContent).toBe(totalCost === null ? '기록 없음' : model)
    expect(within(modelStage).getByText('기록된 비용 (USD)').nextElementSibling?.textContent).toBe(totalCost === null ? '기록 없음' : '$0')
    expect(within(modelStage).queryByText('모델 호출 단계에서 확인')).toBeNull()
    expect(within(modelStage).getByText('개발 (development)')).toBeTruthy()
    expect(within(modelStage).getByText('토큰 사용량').nextElementSibling?.textContent).toBe(JSON.stringify(child.usage_details, null, 2))
  })

  it.each([null, '', '   ', 'staging'])('환경 값 %s는 누락 또는 원래 환경으로 표시한다', async (environment) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...page, results: [{ ...listRoot, environment }] })))
    mount()
    const article = await screen.findByRole('article')
    expect(within(article).getByText('환경').nextElementSibling?.textContent).toBe(environment === 'staging' ? 'staging' : '기록 없음')
  })

  it('의미 검색의 실제 단계 이름과 모델 호출의 양수 비용 정밀도를 유지한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, observations: [
      { ...detail.observations[0], name: 'search.semantic.request' },
      { ...child, total_cost: 0.0001952 },
    ] })))
    mount(`/ops/traces/${traceId}`)
    const stages = await screen.findByRole('region', { name: '실행 단계' })
    const searchStage = within(stages).getByText('공고 의미 검색 요청').closest('details')!
    expect(searchStage.querySelector('summary')?.textContent).toContain('search.semantic.request')
    const modelStage = within(stages).getByText('모델 호출 단계').closest('details')!
    expect(within(modelStage).getByText('모델').nextElementSibling?.textContent).toBe(child.model)
    expect(within(modelStage).getByText('기록된 비용 (USD)').nextElementSibling?.textContent).toBe('$0.0001952')
  })

  it.each(['/ops/traces', `/ops/traces/${traceId}`])('%s 조회 장애를 빈 결과로 숨기지 않고 재조회한다', async (url) => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ detail: 'upstream failure' }, 503)).mockResolvedValue(json(url.endsWith(traceId) ? detail : page))
    vi.stubGlobal('fetch', fetch)
    mount(url)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('AI 실행 추적 서버에 연결할 수 없습니다.')
    expect(screen.queryByText('이 기간에 기록된 실행이 없습니다.')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: '다시 조회' }))
    await screen.findByRole('region', { name: url.endsWith(traceId) ? '실행 단계' : 'AI 실행 목록' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([401, 403])('목록과 상세의 %s 응답은 기존 관리자 인증을 다시 확인한다', async (status) => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)))
    const list = mount('/ops/traces', expired)
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('region', { name: 'AI 실행 목록' })).toBeNull()
    list.unmount()
    mount(`/ops/traces/${traceId}`, expired)
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: '실행 단계' })).toBeNull()
  })

  it('다른 추적 ID의 상세 응답을 화면에 노출하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, trace_id: 'another-trace' })))
    mount(`/ops/traces/${traceId}`)
    expect((await screen.findByRole('alert')).textContent).toContain('AI 실행 추적 응답을 확인할 수 없습니다.')
    expect(screen.queryByText(child.output)).toBeNull()
  })
})
