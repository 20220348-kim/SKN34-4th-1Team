// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { partnerRecruitmentPage } from '../../../../data/fixtures/partnerRecruitments'
import { defaultPartnerRecruitmentQuery } from '../../../../domain/entities/PartnerRecruitmentQuery'
import { chooseOption } from '../../../../test/selectField'
import { sessionRestored } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { PartnerRecruitmentListPage } from './PartnerRecruitmentListPage'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  vi.spyOn(appContainer.resolve('browsePartnerRecruitmentsUseCase'), 'execute').mockResolvedValue(partnerRecruitmentPage)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderPage() {
  const store = createAppStore()
  store.dispatch(sessionRestored({
    email: 'member@govbiz.local', role: 'USER', tier: 'COMPANY', emailVerified: true,
    hasPassword: true, accountType: 'BUSINESS', onboarded: true,
    company: { companyName: '테스트 기업', businessNumber: '1234567890', businessStatusCode: '01' },
  }))
  return render(<Provider store={store}><MemoryRouter><PartnerRecruitmentListPage /></MemoryRouter></Provider>)
}

describe('파트너 모집글 목록', () => {
  it('로딩·상세 링크를 표시하고 기본 조건으로 조회한다', async () => {
    renderPage()
    expect(screen.getByRole('heading', { name: '검색 결과 —건' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('모집글을 불러오는 중입니다.')

    const cards = await screen.findAllByRole('article')
    expect(cards).toHaveLength(partnerRecruitmentPage.recruitments.length)
    for (const recruitment of partnerRecruitmentPage.recruitments) {
      const card = screen.getByRole('article', { name: recruitment.title })
      expect(within(card).getByRole('link').getAttribute('href'))
        .toBe(`/app/partners/detail?recruitmentId=${recruitment.id}`)
    }
    expect(screen.getByRole('heading', { name: '검색 결과 4건' })).toBeTruthy()
    expect(appContainer.resolve('browsePartnerRecruitmentsUseCase').execute)
      .toHaveBeenCalledWith(defaultPartnerRecruitmentQuery, expect.any(AbortSignal))
  })

  it('검색어·역할·지역은 조회할 때 적용하고 페이지 이동과 정렬에도 같은 조건을 유지한다', async () => {
    const browse = vi.mocked(appContainer.resolve('browsePartnerRecruitmentsUseCase').execute)
    browse.mockResolvedValue({ ...partnerRecruitmentPage, total: 24, totalPages: 2 })
    renderPage()
    await screen.findAllByRole('article')

    const filters = screen.getByRole('form', { name: '모집글 검색과 필터' })
    fireEvent.change(within(filters).getByRole('searchbox', { name: '모집글 검색' }), { target: { value: ' 스마트 ' } })
    fireEvent.click(within(filters).getByRole('checkbox', { name: '주관기관' }))
    fireEvent.click(within(filters).getByRole('checkbox', { name: '서울' }))
    fireEvent.click(within(filters).getByRole('checkbox', { name: '부산' }))
    expect(browse).toHaveBeenCalledTimes(1)

    fireEvent.click(within(filters).getByRole('button', { name: '조회' }))
    const query = { ...defaultPartnerRecruitmentQuery, keyword: '스마트', seekingRoles: ['LEAD'], regions: ['서울', '부산'] }
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(query, expect.any(AbortSignal)))
    await screen.findByRole('heading', { name: '검색 결과 24건' })

    const pagination = screen.getByRole('navigation', { name: '모집글 페이지' })
    expect(within(pagination).getByRole('button', { name: '이전' })).toHaveProperty('disabled', true)
    fireEvent.click(within(pagination).getByRole('button', { name: '다음' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith({ ...query, page: 2 }, expect.any(AbortSignal)))
    expect(within(pagination).getByRole('button', { name: '다음' })).toHaveProperty('disabled', true)

    fireEvent.click(within(pagination).getByRole('button', { name: '이전' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(query, expect.any(AbortSignal)))
    fireEvent.click(within(pagination).getByRole('button', { name: '다음' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith({ ...query, page: 2 }, expect.any(AbortSignal)))

    chooseOption(screen.getByRole('combobox', { name: '모집글 정렬' }), 'RECENT')
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith({ ...query, sort: 'RECENT', page: 1 }, expect.any(AbortSignal)))
    expect(within(pagination).getByRole('button', { name: '이전' })).toHaveProperty('disabled', true)
  })

  it('조회 실패를 빈 결과로 숨기지 않고 같은 조건으로 다시 시도한다', async () => {
    const browse = vi.mocked(appContainer.resolve('browsePartnerRecruitmentsUseCase').execute)
    browse.mockRejectedValueOnce(new Error('unavailable'))
    renderPage()

    const failure = await screen.findByRole('region', { name: '모집글 불러오기 실패' })
    expect(screen.queryByRole('heading', { name: '아직 모집 중인 글이 없어요' })).toBeNull()
    fireEvent.click(within(failure).getByRole('button', { name: '다시 시도' }))
    await screen.findAllByRole('article')
    expect(browse).toHaveBeenCalledTimes(2)
    expect(browse).toHaveBeenLastCalledWith(defaultPartnerRecruitmentQuery, expect.any(AbortSignal))
    expect(screen.queryByRole('region', { name: '모집글 불러오기 실패' })).toBeNull()
  })

  it('전체 빈 결과에는 첫 모집글 작성을 안내하고 필터로 빈 결과는 초기화할 수 있다', async () => {
    const browse = vi.mocked(appContainer.resolve('browsePartnerRecruitmentsUseCase').execute)
    const empty = { ...partnerRecruitmentPage, recruitments: [], total: 0, totalPages: 0 }
    browse.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
    renderPage()

    const noRecruitments = await screen.findByRole('region', { name: '아직 모집 중인 글이 없어요' })
    expect(within(noRecruitments).getByRole('link', { name: '모집글 작성하기' }).getAttribute('href')).toBe(appPaths.partnerNew)
    fireEvent.change(screen.getByRole('searchbox', { name: '모집글 검색' }), { target: { value: '없는 글' } })
    fireEvent.click(screen.getByRole('button', { name: '조회' }))

    const noMatches = await screen.findByRole('region', { name: '조건에 맞는 모집글이 없어요' })
    fireEvent.click(within(noMatches).getByRole('button', { name: '검색·필터 초기화' }))
    await screen.findAllByRole('article')
    expect(browse).toHaveBeenLastCalledWith(defaultPartnerRecruitmentQuery, expect.any(AbortSignal))
    expect(screen.getByRole('searchbox', { name: '모집글 검색' })).toHaveProperty('value', '')
  })
})
