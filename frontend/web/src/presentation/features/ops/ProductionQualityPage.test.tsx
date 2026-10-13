// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProductionQuality, getProductionSample } from '../../../data/ops/opsApi'
import { ProductionQualityPage } from './ProductionQualityPage'

const id = '10000000-0000-4000-8000-000000000001'
const candidateId = '20000000-0000-4000-8000-000000000002'
const row = { id, captured_at: '2026-10-14T01:00:00Z', source_document_id: 'bizinfo:NOTICE-1', sample_rate_bps: 1000, checks_status: 'checked', check_codes: [], review_version: 0, review: null, regression_candidate_id: null }
const summary = { stored: 2, checked: 1, pending: 1, reviewed: 0, issues: 0, unassessable: 0 }
const page = { scope: 'support-program-evidence-answer', enabled: false, retention_days: 14, daily_limit: 100, summary, days: [{ date: '2026-10-14', samples: 2, reviewed: 0, acceptable: 0, issues: 0, unassessable: 0 }], results: [row], count: 1, next: false, page: 1 }
const detail = { ...row, scope: page.scope, material_sha256: 'a'.repeat(64), redacted: true, release: null, trace_url: 'https://langfuse.example/trace/test', material: { question: '지원 자격은? <script>bad()</script>', answer: '소상공인이 대상입니다.', answer_status: 'ANSWERED', citation_chunk_ids: ['chunk-1'], chunks: [{ id: 'chunk-1', document_id: 'bizinfo:NOTICE-1', order: 1, text: '공고 원문: 소상공인 지원' }] } }
const reviewed = { ...detail, review_version: 1, review: { id: '30000000-0000-4000-8000-000000000003', verdict: 'acceptable', grounded: 'yes', relevant: 'yes', complete: 'yes', note: '원문에 명시됨', reference_answer: '소상공인', expected_status: 'ANSWERED', expected_citation_ids: ['chunk-1'], reviewer: 'core:99', created_at: '2026-10-14T02:00:00Z' } }
const session = { user: { id: 'core:99', username: 'admin' }, csrf_token: 'csrf-test', live_enabled: false, datasets: [] }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const base = '/api/v1/ops/production-quality'
const setup = (override?: (path: string, options?: RequestInit) => Response | Promise<Response> | undefined) => {
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const result = override?.(path, options)
    if (result) return result
    if (path === `${base}?page=1`) return json(page)
    if (path === `${base}/${id}`) return json(detail)
    if (path === '/api/v1/ops/session') return json(session)
    throw new Error(`Unexpected path ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const mount = (onExpired = vi.fn(), path = '/ops/production-quality') => render(<MemoryRouter initialEntries={[path]}><ProductionQualityPage owner="core:99" onExpired={onExpired} /></MemoryRouter>)
const select = async () => { fireEvent.click(await screen.findByRole('button', { name: 'bizinfo:NOTICE-1 표본 검토' })); await screen.findByText('개인정보·민감정보가 마스킹된 표본입니다. 문맥이 부족해 판단하기 어렵다면 ‘판단 불가’를 선택하세요.') }
const fillReview = () => {
  for (const label of ['근거 일치', '질문 관련성', '중요 조건 포함']) fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value: 'yes' } })
  fireEvent.change(screen.getByLabelText('검토 근거 · 필수'), { target: { value: '원문에 명시됨' } })
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('운영 표본 품질', () => {
  it('저장 표본과 미검토를 명시하고 조회만으로 모델 호출이나 쓰기를 하지 않는다', async () => {
    const fetch = setup(); mount()
    expect(await screen.findByRole('region', { name: '운영 표본 수집 범위' })).toHaveProperty('textContent', expect.stringContaining('Ops 표본 접수 비활성'))
    const days = screen.getByRole('region', { name: '일별 표본 검토' })
    expect(within(days).getAllByText('미검토')).toHaveLength(3)
    expect(days.textContent).not.toContain('0%')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`${base}?page=1`, expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }))
    expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false)
  })

  it('일별 적합·문제·보류를 검토 건수와 함께 표시한다', async () => {
    setup((path) => path.includes('?') ? json({ ...page, days: [{ date: '2026-10-14', samples: 20, reviewed: 4, acceptable: 2, issues: 1, unassessable: 1 }] }) : undefined)
    mount(); expect(await screen.findByText('2 / 4건 (50%)')).toBeTruthy()
    expect(screen.getAllByText('1 / 4건 (25%)')).toHaveLength(2)
  })

  it('질문과 원문 HTML은 텍스트로 표시하고 안전한 추적 링크만 제공한다', async () => {
    setup(); const view = mount(); await select()
    expect(screen.getByText(detail.material.question)).toBeTruthy()
    expect(view.container.querySelector('script')).toBeNull()
    expect(screen.getByText('공고 원문: 소상공인 지원')).toBeTruthy()
    const trace = screen.getByRole('link', { name: 'Langfuse 실행 추적 열기 ↗' })
    expect(trace.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByText(/수집 당시 설정 비율 10%/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '사람 검토 저장' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('최신 세션과 CSRF를 사용해 사람 검토와 참조 정답을 저장하고 회귀 후보를 명시적으로 만든다', async () => {
    const fetch = setup((path, options) => {
      if (path.endsWith('/review') && options?.method === 'POST') return json(reviewed)
      if (path.endsWith('/regression-candidate') && options?.method === 'POST') return json({ ...reviewed, regression_candidate_id: candidateId })
      return undefined
    })
    mount(); await select(); fillReview()
    fireEvent.click(screen.getByText('회귀 후보용 정답 작성 · 선택'))
    fireEvent.change(screen.getByLabelText('검토한 참조 답변'), { target: { value: '소상공인' } })
    fireEvent.change(screen.getByLabelText('기대 답변 상태'), { target: { value: 'ANSWERED' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'chunk-1' }))
    fireEvent.click(screen.getByRole('button', { name: '사람 검토 저장' }))
    await screen.findByText('사람 검토를 저장했습니다.')
    const save = fetch.mock.calls.find(([path]) => path.endsWith('/review'))!
    expect(save[1]).toMatchObject({ method: 'POST', headers: { 'X-CSRFToken': 'csrf-test' } })
    expect(JSON.parse(save[1]!.body as string)).toMatchObject({ version: 0, material_sha256: detail.material_sha256, grounded: 'yes', relevant: 'yes', complete: 'yes', note: '원문에 명시됨', reference_answer: '소상공인', expected_status: 'ANSWERED', expected_citation_ids: ['chunk-1'] })
    expect(fetch.mock.calls.filter(([path]) => path.endsWith('/regression-candidate'))).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '회귀 후보 저장' }))
    await screen.findByText('회귀 후보를 저장했습니다. 현재 고정 평가에 자동으로 편입되지 않습니다.')
    const candidate = fetch.mock.calls.find(([path]) => path.endsWith('/regression-candidate'))!
    expect(JSON.parse(candidate[1]!.body as string)).toMatchObject({ version: 1, material_sha256: detail.material_sha256 })
    expect((screen.getByRole('button', { name: '회귀 후보 JSON 다운로드' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '회귀 후보 저장' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('다운로드는 후보 JSON만 가져오며 새 모델 실행이나 자동 평가 편입을 요청하지 않는다', async () => {
    const fetch = setup((path) => path === `${base}/${id}` ? json({ ...reviewed, regression_candidate_id: candidateId })
      : path.endsWith('/regression-candidate') ? json({ schemaVersion: 'production-regression-candidate-v1', sample_id: id, fixture_registered: false, baseline_eligible: false }) : undefined)
    const create = vi.fn(() => 'blob:sample'), revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    mount(); await select(); fireEvent.click(screen.getByRole('button', { name: '회귀 후보 JSON 다운로드' }))
    await screen.findByText(/회귀 후보 JSON을 내려받았습니다/)
    expect(create).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:sample'); expect(click).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })

  it('검토 충돌 뒤 재저장을 차단하고 새로고침한 버전으로만 다시 입력한다', async () => {
    const fetch = setup((path) => path.endsWith('/review') ? json({}, 409) : undefined)
    mount(); await select(); fillReview(); fireEvent.click(screen.getByRole('button', { name: '사람 검토 저장' }))
    await screen.findByText('검토 기록이 변경되었습니다. 상세 새로고침 후 다시 검토하세요.')
    expect((screen.getByRole('button', { name: '회귀 후보 저장' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '사람 검토 저장' }))
    expect(fetch.mock.calls.filter(([path]) => path.endsWith('/review'))).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '입력 초기화하고 상세 새로고침' }))
    await waitFor(() => expect((screen.getByLabelText('검토 근거 · 필수') as HTMLTextAreaElement).value).toBe(''))
    expect(screen.queryByText('검토 기록이 변경되었습니다. 상세 새로고침 후 다시 검토하세요.')).toBeNull()
  })

  it('불확실한 저장 응답의 동일 입력 재시도는 같은 요청 ID를 사용한다', async () => {
    let attempts = 0
    const fetch = setup((path) => path.endsWith('/review') ? (++attempts === 1 ? json({}, 503) : json(reviewed)) : undefined)
    mount(); await select(); fillReview(); fireEvent.click(screen.getByRole('button', { name: '사람 검토 저장' }))
    await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: '사람 검토 저장' }))
    await screen.findByText('사람 검토를 저장했습니다.')
    const calls = fetch.mock.calls.filter(([path]) => path.endsWith('/review'))
    expect(JSON.parse(calls[0][1]!.body as string).request_id).toBe(JSON.parse(calls[1][1]!.body as string).request_id)
  })

  it.each(['pending', 'error'])('구조 검사 %s 상태에는 사람 검토 저장을 차단한다', async (checks_status) => {
    setup((path) => path === `${base}/${id}` ? json({ ...detail, checks_status }) : undefined)
    mount(); await select(); expect(screen.getByText('구조 검사가 완료된 뒤 사람 검토를 저장할 수 있습니다.')).toBeTruthy()
    expect((screen.getByRole('group', { name: '사람 검토' }) as HTMLFieldSetElement).disabled).toBe(true)
  })

  it.each([401, 403])('상세 인증 오류 %s는 상위 세션을 재확인한다', async (status) => {
    setup((path) => path === `${base}/${id}` ? json({}, status) : undefined)
    const expired = vi.fn(); mount(expired, `/ops/production-quality?sample=${id}`)
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('저장 전 계정이 바뀌면 다른 계정으로 검토를 기록하지 않는다', async () => {
    const fetch = setup((path) => path === '/api/v1/ops/session' ? json({ ...session, user: { id: 'core:100', username: 'other' } }) : undefined)
    const expired = vi.fn(); mount(expired); await select(); fillReview(); fireEvent.click(screen.getByRole('button', { name: '사람 검토 저장' }))
    await waitFor(() => expect(expired).toHaveBeenCalledOnce())
    expect(fetch.mock.calls.some(([path]) => path.endsWith('/review'))).toBe(false)
    expect(screen.queryByText(detail.material.question)).toBeNull()
  })

  it('목록 장애를 빈 표본으로 숨기지 않는다', async () => {
    setup((path) => path.includes('?') ? json({}, 503) : undefined)
    mount(); await screen.findByRole('alert')
    expect(screen.queryByText('아직 저장된 운영 표본이 없습니다.')).toBeNull()
  })

  it('다음 페이지는 해당 페이지 번호로 읽고 이전 표본 선택을 지운다', async () => {
    const fetch = setup((path) => path === `${base}?page=1` ? json({ ...page, next: true }) : path === `${base}?page=2` ? json({ ...page, page: 2, results: [] }) : undefined)
    mount(); await select(); fireEvent.click(screen.getByRole('button', { name: '다음' }))
    await screen.findByText('2페이지')
    expect(screen.queryByRole('region', { name: '운영 표본 상세 검토' })).toBeNull()
    expect(fetch).toHaveBeenCalledWith(`${base}?page=2`, expect.anything())
  })

  it('판단 보류인 사람 검토는 참조 답변이 있어도 회귀 후보로 저장하지 못한다', async () => {
    setup((path) => path === `${base}/${id}` ? json({ ...reviewed, review: { ...reviewed.review, grounded: 'unknown', verdict: 'unassessable' } }) : undefined)
    mount(); await select()
    expect(screen.getByText(/최근 사람 검토: 판단 보류/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '회귀 후보 저장' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('이미 검토한 표본도 편집 중이면 이전 검토로 후보를 만드는 버튼을 잠근다', async () => {
    setup((path) => path === `${base}/${id}` ? json(reviewed) : undefined)
    mount(); await select()
    expect((screen.getByRole('button', { name: '회귀 후보 저장' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('검토 근거 · 필수'), { target: { value: '수정 중인 판단' } })
    expect((screen.getByRole('button', { name: '회귀 후보 저장' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('변경한 검토 입력을 먼저 저장해야 회귀 후보를 만들 수 있습니다.')).toBeTruthy()
  })

  it('검토 이력은 각 작성자와 근거를 텍스트로 보존해 표시한다', async () => {
    setup((path) => path === `${base}/${id}` ? json({ ...reviewed, review_history: [{ ...reviewed.review, note: '<script>검토 근거</script>' }] }) : undefined)
    const view = mount(); await select(); fireEvent.click(screen.getByText('사람 검토 이력 · 1건'))
    expect(screen.getByText('<script>검토 근거</script>')).toBeTruthy()
    expect(screen.getByText('근거 일치: 예 · 질문 관련성: 예 · 중요 조건 포함: 예')).toBeTruthy()
    expect(view.container.querySelector('script')).toBeNull()
  })

  it('다른 표본·페이지·위험 URL 응답은 거절한다', async () => {
    setup((path) => path.includes('?') ? json({ ...page, page: 2 }) : json({ ...detail, id: candidateId }))
    await expect(getProductionQuality(1)).rejects.toThrow()
    await expect(getProductionSample(id)).rejects.toThrow()
    setup(() => json({ ...detail, trace_url: 'javascript:alert(1)' }))
    await expect(getProductionSample(id)).rejects.toThrow()
    setup(() => json({ ...page, days: [{ date: '2026-10-14', samples: 1, reviewed: 0, acceptable: 1, issues: 0, unassessable: 0 }] }))
    await expect(getProductionQuality(1)).rejects.toThrow()
    setup(() => json({ ...reviewed, review: { ...reviewed.review, grounded: 'unknown' } }))
    await expect(getProductionSample(id)).rejects.toThrow()
  })

  it('떠난 화면에 늦게 도착한 인증 오류를 반영하지 않는다', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    setup((path) => path === `${base}/${id}` ? pending : undefined)
    const expired = vi.fn(); const view = mount(expired, `/ops/production-quality?sample=${id}`); view.unmount()
    await act(async () => { resolve(json({}, 401)); await pending })
    expect(expired).not.toHaveBeenCalled()
  })
})
