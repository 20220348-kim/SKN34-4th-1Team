// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatasetManagementPage } from './DatasetManagementPage'
import type { ManagedDataset, ManagedDatasetContent } from '../../../data/ops/opsApi'

const id = '10000000-0000-4000-8000-000000000001'
const at = '2026-10-15T09:00:00+09:00'
const content: ManagedDatasetContent = { title: '신청 조건 확인', description: '지원 대상 확인', documents: [{ id: 'doc-1', title: '공식 공고', source_url: 'https://example.org/notice', chunks: ['창업 3년 이내 기업을 지원합니다.', '지원 한도는 천만 원입니다.'] }], cases: [{ id: 'Q01', document_id: 'doc-1', question: '지원 대상은 누구인가요?', expected_status: 'ANSWERED', expected_citation_orders: [0], reference_facts: ['창업 3년 이내 기업'], forbidden_claims: ['모든 기업이 신청 가능'], answer: null }] }
const saved: ManagedDataset = { id, version: 1, archived: false, content, created_at: at, updated_at: at, revisions: [] }
const session = { user: { id: 'core:81', username: '관리자' }, csrf_token: 'csrf-test', live_enabled: false, rag_live_enabled: false }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const setup = (initial: ManagedDataset[] = [], handler?: (url: string, data: Record<string, unknown>) => Response | Promise<Response>) => {
  let current = structuredClone(initial)
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
    const url = String(input)
    if (url === '/api/v1/ops/session') return json(session)
    if (url === '/api/v1/ops/datasets' && (!options?.method || options.method === 'GET')) return json({ datasets: current, builtin_count: 10 })
    if (options?.method && ['POST', 'PUT'].includes(options.method)) {
      const data = JSON.parse(options.body as string)
      if (handler) return handler(url, data)
      const old = current[0] ?? saved
      const result = { ...old, version: old.version + 1, content: data.content ?? old.content,
        ...(url.endsWith('/archive') ? { archived: data.archived } : {}),
        ...(url.endsWith('/publish') ? { revisions: [{ id: 'managed-example-v1', number: 1, created_at: at, label: '신청 조건 확인 v1' }] } : {}),
      }
      current = [result]; return json(result)
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const writes = (fetch: ReturnType<typeof setup>) => fetch.mock.calls.filter(([, options]) => ['POST', 'PUT'].includes(options?.method ?? ''))
const open = (onExpired = vi.fn()) => render(<MemoryRouter><DatasetManagementPage owner="core:81" onExpired={onExpired} /></MemoryRouter>)
const selectSaved = async () => fireEvent.click(await screen.findByRole('button', { name: '신청 조건 확인' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('관리자 평가 자료 등록', () => {
  it('조회와 입력만으로 실행하거나 저장하지 않고 답변 없는 초안을 저장한다', async () => {
    const fetch = setup(); open()
    await screen.findByText('아직 직접 등록한 자료가 없습니다. 아래에서 첫 자료의 초안을 작성하세요.')
    expect(screen.getByText(/저장·게시·보관은 모델을 호출하지/)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '자료 이름' }), { target: { value: content.title } })
    fireEvent.change(screen.getByRole('textbox', { name: '공고 1 제목' }), { target: { value: '공식 공고' } })
    fireEvent.change(screen.getByRole('textbox', { name: '공고 1 근거 1' }), { target: { value: '원문 내용' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Q01 질문' }), { target: { value: '지원 대상은?' } })
    expect(writes(fetch)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '초안 저장' }))
    await screen.findByText(/초안을 저장했습니다/)
    expect(writes(fetch)).toHaveLength(1)
    const [url, options] = writes(fetch)[0]
    expect(url).toBe('/api/v1/ops/datasets')
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json', 'X-CSRFToken': 'csrf-test' })
    expect(JSON.parse(options!.body as string)).toMatchObject({ expected_version: 0, request_id: expect.any(String), content: { title: content.title, cases: [{ answer: null }] } })
    expect(screen.getByRole('button', { name: '게시 내용 확인' }).hasAttribute('disabled')).toBe(true)
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('/api/v1/ops/datasets') || url === '/api/v1/ops/session')).toBe(true)
  })

  it('저장 답변을 입력한 뒤 초안 저장과 명시적 게시를 분리한다', async () => {
    const fetch = setup([saved]); open(); await selectSaved()
    fireEvent.click(screen.getByText('Q01 저장 답변 입력 · 초안에서는 선택'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Q01 저장 답변' }), { target: { value: '창업 3년 이내 기업이 대상입니다.' } })
    expect(screen.getByRole('button', { name: '게시 내용 확인' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '초안 저장' }))
    await screen.findByText(/초안을 저장했습니다/)
    expect(writes(fetch)[0][1]?.method).toBe('PUT')
    fireEvent.click(screen.getByRole('button', { name: '게시 내용 확인' }))
    expect(writes(fetch)).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: '게시 최종 확인' })).getByText(/실제 모델 호출·검토 승인·품질 합격은 아닙니다/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '확인한 버전 게시' }))
    await screen.findByText(/새 평가에서 선택할 자료 버전을 게시했습니다/)
    expect(writes(fetch)[1][0]).toBe(`/api/v1/ops/datasets/${id}/publish`)
    expect(JSON.parse(writes(fetch)[1][1]!.body as string)).toMatchObject({ expected_version: 2 })
  })

  it('근거 인용이 있으면 삭제를 막고 문서 변경 시 인용을 비운다', async () => {
    setup([{ ...saved, content: { ...content, cases: [{ ...content.cases[0], expected_citation_orders: [1], answer: { text: '답변', status: 'ANSWERED', citation_orders: [1] } }] } }]); open(); await selectSaved()
    expect(screen.getByRole('button', { name: '마지막 근거 삭제' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '공고 추가' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Q01 제공할 공고' }), { target: { value: 'doc-2' } })
    expect(within(screen.getByRole('group', { name: 'Q01 답변에 인용해야 할 근거' })).getByRole('checkbox')).toHaveProperty('checked', false)
    expect(screen.getAllByRole('button', { name: '마지막 근거 삭제' })[0].hasAttribute('disabled')).toBe(false)
    fireEvent.change(screen.getByRole('combobox', { name: 'Q01 예상 답변 상태' }), { target: { value: 'INSUFFICIENT_EVIDENCE' } })
    expect(screen.getByRole('group', { name: 'Q01 답변에 인용해야 할 근거' }).hasAttribute('disabled')).toBe(true)
  })

  it('수정 도중 자료를 바꾸면 명시적으로 입력 폐기를 확인한다', async () => {
    const fetch = setup([saved]); open(); await selectSaved()
    fireEvent.change(screen.getByRole('textbox', { name: '자료 이름' }), { target: { value: '수정 중' } })
    fireEvent.click(screen.getByRole('button', { name: '새 자료 작성' }))
    expect(screen.getByRole('region', { name: '작성 내용 이동 확인' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '계속 작성' }))
    expect(screen.getByRole('textbox', { name: '자료 이름' })).toHaveProperty('value', '수정 중')
    expect(writes(fetch)).toHaveLength(0)
  })

  it('저장 응답 유실은 같은 UUID와 본문으로 재확인한다', async () => {
    let attempts = 0
    const fetch = setup([saved], async (_url, data) => { if (++attempts === 1) throw new TypeError('network'); return json({ ...saved, version: 2, content: data.content }) })
    open(); await selectSaved()
    fireEvent.change(screen.getByRole('textbox', { name: '자료 이름' }), { target: { value: '수정한 자료' } })
    fireEvent.click(screen.getByRole('button', { name: '초안 저장' }))
    await screen.findByRole('button', { name: '같은 저장 요청으로 재확인' })
    fireEvent.click(screen.getByRole('button', { name: '같은 저장 요청으로 재확인' }))
    await screen.findByText(/초안을 저장했습니다/)
    expect(writes(fetch)).toHaveLength(2)
    expect(writes(fetch)[0][1]?.body).toBe(writes(fetch)[1][1]?.body)
  })

  it('버전 충돌 시 입력을 보존하고 게시와 재저장을 막는다', async () => {
    setup([saved], () => json({ code: 'DATASET_CONFLICT', detail: '자료가 변경되었습니다.' }, 409)); open(); await selectSaved()
    fireEvent.change(screen.getByRole('textbox', { name: '자료 이름' }), { target: { value: '내 입력 보존' } })
    fireEvent.click(screen.getByRole('button', { name: '초안 저장' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox', { name: '자료 이름' })).toHaveProperty('value', '내 입력 보존')
    expect(screen.getByRole('button', { name: '게시 내용 확인' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: '같은 저장 요청으로 재확인' })).toBeNull()
  })

  it('보관과 복원은 기존 자료에만 적용하고 평가를 접수하지 않는다', async () => {
    const fetch = setup([saved]); open(); await selectSaved()
    fireEvent.click(screen.getByRole('button', { name: '자료 보관' }))
    await screen.findByText(/자료를 보관했습니다/)
    expect(screen.getByRole('button', { name: '게시 내용 확인' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '자료 복원' }))
    await screen.findByText(/자료를 복원했습니다/)
    expect(writes(fetch).map(([, options]) => JSON.parse(options!.body as string).archived)).toEqual([true, false])
    expect(writes(fetch).every(([url]) => String(url).endsWith('/archive'))).toBe(true)
  })

  it('쓰기 전 계정이 달라지면 자료 저장을 전송하지 않는다', async () => {
    const fetch = setup([saved]); const original = fetch.getMockImplementation()!
    fetch.mockImplementation((url, options) => url === '/api/v1/ops/session' ? Promise.resolve(json({ ...session, user: { id: 'core:other', username: '다른 관리자' } })) : original(url, options))
    const expired = vi.fn(); open(expired); await selectSaved()
    fireEvent.change(screen.getByRole('textbox', { name: '자료 이름' }), { target: { value: '새 이름' } })
    fireEvent.click(screen.getByRole('button', { name: '초안 저장' }))
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
    expect(writes(fetch)).toHaveLength(0)
  })
  it('다른 관리자 도구에서 만든 문서 없는 초안을 열어도 새 공고를 추가할 수 있다', async () => {
    setup([{ ...saved, content: { ...content, documents: [], cases: [] } }]); open(); await selectSaved()
    expect(screen.getByRole('button', { name: '질문 추가' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '공고 추가' }))
    expect(screen.getByRole('textbox', { name: '공고 1 제목' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '질문 추가' }))
    expect(screen.getByRole('textbox', { name: 'Q01 질문' })).toBeTruthy()
  })

  it('신규 저장 응답이 불확실할 때 목록 재조회는 입력을 버리고 자동 재접수하지 않는다', async () => {
    const fetch = setup([], async () => { throw new TypeError('network') }); open()
    await screen.findByText('아직 직접 등록한 자료가 없습니다. 아래에서 첫 자료의 초안을 작성하세요.')
    fireEvent.change(screen.getByRole('textbox', { name: '자료 이름' }), { target: { value: '접수 확인 중 자료' } })
    fireEvent.click(screen.getByRole('button', { name: '초안 저장' }))
    await screen.findByRole('button', { name: '같은 저장 요청으로 재확인' })
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }))
    fireEvent.click(screen.getByRole('button', { name: '입력 버리고 이동' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '목록 새로고침' }).hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('textbox', { name: '자료 이름' })).toHaveProperty('value', '')
    expect(writes(fetch)).toHaveLength(1)
  })

})
