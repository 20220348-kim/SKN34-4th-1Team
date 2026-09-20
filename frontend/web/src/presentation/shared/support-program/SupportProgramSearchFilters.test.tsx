// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore } from '../../../app/store'
import { supportPrograms } from '../../../data/fixtures/supportPrograms'
import { signedIn } from '../auth/state/authSlice'
import { ApplicationPreparationEditorPage } from '../../features/application-preparation/view/ApplicationPreparationPages'
import { CombinationReviewEditorPage } from '../../features/combination-review/view/CombinationReviewPages'
import { chooseOption, selectedValue } from '../../../test/selectField'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe.each([
  { title: '신청 문서', path: '/app/application-preparations/new', next: '다음', selected: '선택한 공고' },
  { title: '중복 지원 검토', path: '/app/combination-reviews/new', next: '다음 공고', selected: '현재 선택한 공고' },
])('$title 공고 필터 검색', ({ path, next, selected }) => {
  function mount() {
    const store = createAppStore()
    store.dispatch(signedIn({ email: 'filters@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, company: null }))
    render(<Provider store={store}><MemoryRouter initialEntries={[path]}><Routes>
      <Route path="/app/application-preparations/new" element={<ApplicationPreparationEditorPage create />} />
      <Route path="/app/combination-reviews/new" element={<CombinationReviewEditorPage create />} />
    </Routes></MemoryRouter></Provider>)
  }

  function response(page = 1, empty = false) {
    return Response.json({
      programs: empty ? [] : Array.from({ length: 10 }, (_, index) => ({ ...supportPrograms[0], id: `PBLN_${page}0${index}`,
        title: index === 0 ? `검색 공고 ${page}` : `검색 공고 ${page}-${index}`, status: 'CLOSED',
        recommendationScore: null, eligibilityReview: null, matchedReasons: [] })),
      total: empty ? 0 : 20, page, pageSize: 10, totalPages: empty ? 0 : 2,
      regions: ['서울', '부산'], categories: ['기술', '새 분야'], startupStages: [], applicantTypes: [], founderAges: [],
    })
  }

  it('sends filters through the HTTP adapter and preserves applied conditions and selected programs when paging', async () => {
    const fetcher = vi.fn(async (url: string) => response(Number(new URL(url).searchParams.get('page'))))
    vi.stubGlobal('fetch', fetcher)
    mount()
    const filters = within(screen.getByRole('group', { name: '공고 검색 필터' }))
    const keyword = filters.getByRole('searchbox', { name: '공고명·기관명' })
    fireEvent.change(keyword, { target: { value: '  혁신  ' } })
    chooseOption(filters.getByRole('combobox', { name: '지역' }), '서울')
    chooseOption(filters.getByRole('combobox', { name: '지원 분야' }), '기술')
    chooseOption(filters.getByRole('combobox', { name: '출처' }), 'BIZINFO')
    chooseOption(filters.getByRole('combobox', { name: '접수 상태' }), 'CLOSED')
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.keyDown(keyword, { key: 'Enter' })
    fireEvent.click((await screen.findAllByRole('button', { name: '선택' }))[0])
    const firstQuery = new URL(fetcher.mock.calls[0][0]).searchParams
    expect(Object.fromEntries(firstQuery)).toMatchObject({ keyword: '혁신', region: '서울', category: '기술', sourceCode: 'BIZINFO', status: 'CLOSED', page: '1' })
    expect(screen.getByLabelText(selected).textContent).toContain('검색 공고 1')
    expect(filters.getByRole('button', { name: '지역 · 서울 조건 해제' })).toBeTruthy()

    chooseOption(filters.getByRole('combobox', { name: '지역' }), '부산')
    fireEvent.click(screen.getByRole('button', { name: next }))
    await screen.findByText('검색 공고 2')
    expect(Object.fromEntries(new URL(fetcher.mock.calls[1][0]).searchParams)).toMatchObject({ keyword: '혁신', region: '서울', category: '기술', sourceCode: 'BIZINFO', status: 'CLOSED', page: '2' })
    expect(screen.getByLabelText(selected).textContent).toContain('검색 공고 1')

    fireEvent.click(filters.getByRole('button', { name: '공고 검색' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
    await screen.findByRole('button', { name: next })
    expect(Object.fromEntries(new URL(fetcher.mock.calls[2][0]).searchParams)).toMatchObject({ region: '부산', page: '1' })
    expect(fetcher.mock.calls.every(([url]) => new URL(url).pathname.endsWith('/catalog'))).toBe(true)
  })

  it('removes conditions, resets filters, and shows empty or failed results while retaining the selection', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(1, true))
      .mockResolvedValueOnce(Response.json({ status: 503 }, { status: 503 }))
      .mockResolvedValueOnce(response())
    vi.stubGlobal('fetch', fetcher)
    mount()
    const filters = within(screen.getByRole('group', { name: '공고 검색 필터' }))
    chooseOption(filters.getByRole('combobox', { name: '지역' }), '서울')
    chooseOption(filters.getByRole('combobox', { name: '지원 분야' }), '기술')
    fireEvent.click(filters.getByRole('button', { name: '공고 검색' }))
    fireEvent.click((await screen.findAllByRole('button', { name: '선택' }))[0])
    fireEvent.click(filters.getByRole('button', { name: '지역 · 서울 조건 해제' }))
    await screen.findByText('검색 결과가 없습니다. 검색어나 필터를 바꿔 다시 검색해 주세요.')
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('region') ?? '').toBe('')
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('category')).toBe('기술')
    expect(screen.getByLabelText(selected).textContent).toContain('검색 공고 1')

    fireEvent.click(filters.getByRole('button', { name: '전체 초기화' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('검색 결과가 없습니다. 검색어나 필터를 바꿔 다시 검색해 주세요.')).toBeNull()
    expect(selectedValue(filters.getByRole('combobox', { name: '지역' }))).toBe('')
    expect(selectedValue(filters.getByRole('combobox', { name: '지원 분야' }))).toBe('')
    expect(selectedValue(filters.getByRole('combobox', { name: '접수 상태' }))).toBe('ALL')
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('status')).toBe('ALL')
    expect(screen.getByLabelText(selected).textContent).toContain('검색 공고 1')
    fireEvent.click(filters.getByRole('button', { name: '공고 검색' }))
    await screen.findByRole('button', { name: next })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})
