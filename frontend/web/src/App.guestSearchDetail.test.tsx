// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { createAppStore } from './app/store'
import { supportPrograms } from './data/fixtures/supportPrograms'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const program = { ...supportPrograms[0]!, title: '서울 수출 바우처', categories: ['수출'], regions: ['서울'], recommendationScore: null, matchedReasons: [], eligibilityReview: null }
const catalog = { programs: [program], total: 1, page: 1, pageSize: 12, totalPages: 1, regions: ['서울', '전국'], categories: ['수출'], startupStages: [], applicantTypes: [], founderAges: [] }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function Location() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function start(path: string) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    const request = new URL(url)
    if (request.pathname.endsWith('/catalog')) return Response.json(catalog)
    if (request.pathname.endsWith('/detail')) return Response.json(program)
    return new Promise<Response>(() => {})
  }))
  const store = createAppStore()
  store.dispatch(sessionRestored(null))
  render(<Provider store={store}><MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter></Provider>)
}

describe('비로그인 검색 흐름의 공고 상세', () => {
  it('필터 검색에서 상세로 가도 헤더와 검색 탭이 그대로이고 상세는 그 아래에 뜬다', async () => {
    start('/?mode=filter')
    fireEvent.click(await screen.findByRole('link', { name: program.title }))
    await screen.findByRole('heading', { name: program.title })

    // 공개 헤더는 검색 화면과 같은 마케팅 헤더이고 "지원사업 찾기"가 현재 화면입니다.
    const header = screen.getByRole('banner', { name: '앱 헤더' })
    expect(within(header).getByRole('link', { name: '지원사업 찾기' }).getAttribute('aria-current')).toBe('page')
    expect(within(header).queryByText('공고 상세')).toBeNull()
    // 검색 탭은 들어온 필터 검색이 선택된 채 남아 있고, 검색 결과 패널 대신 상세가 아래에 있습니다.
    const tabs = screen.getByRole('tablist', { name: '지원사업 검색 방식' })
    expect(within(tabs).getByRole('tab', { name: '필터 검색' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('combobox', { name: '출처' })).toBeNull()
    expect(screen.getByRole('link', { name: '로그인하고 관심 공고 저장' })).toBeTruthy()

    // 같은 탭을 누르면 필터가 복원된 검색 화면으로, 다른 탭을 누르면 그 검색의 처음 화면으로 돌아갑니다.
    fireEvent.click(within(tabs).getByRole('tab', { name: '필터 검색' }))
    await screen.findByRole('link', { name: program.title })
    expect(screen.getByTestId('location').textContent).toContain('/?mode=filter')
    expect((screen.getByRole('combobox', { name: '출처' }) as HTMLSelectElement).value).toBe('')

    fireEvent.click(screen.getByRole('link', { name: program.title }))
    await screen.findByRole('heading', { name: program.title })
    fireEvent.click(within(screen.getByRole('tablist', { name: '지원사업 검색 방식' })).getByRole('tab', { name: 'AI 대화 검색' }))
    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(screen.getByRole('tab', { name: 'AI 대화 검색' }).getAttribute('aria-selected')).toBe('true')
  })

  it('비로그인 상세의 질문하기는 로그인 뒤 작업 화면의 질문으로 이어지고, 직접 연 원문 질문 화면도 같은 헤더·검색 탭 아래에 뜬다', async () => {
    start('/?mode=filter')
    fireEvent.click(await screen.findByRole('link', { name: program.title }))
    await screen.findByRole('heading', { name: program.title })
    const identity = new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.id })
    expect(screen.queryByRole('link', { name: '이 공고에 질문하기' })).toBeNull()
    expect(screen.getByRole('link', { name: '로그인하고 이 공고에 질문하기' }).getAttribute('href'))
      .toBe(`/login?next=${encodeURIComponent(`/app/support-programs/detail/question?${identity}`)}`)
    cleanup()

    start(`/support-programs/detail/question?${identity}`)
    expect(screen.getByRole('heading', { name: '이 공고에 질문하기', level: 1 })).toBeTruthy()
    expect(within(screen.getByRole('tablist', { name: '지원사업 검색 방식' })).getByRole('tab', { name: 'AI 대화 검색' }).getAttribute('aria-selected')).toBe('true')
    expect(within(screen.getByRole('banner', { name: '앱 헤더' })).queryByText('원문 질문')).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: '← 공고 상세로 돌아가기' }))
    await screen.findByRole('heading', { name: program.title })
    expect(screen.getByRole('tablist', { name: '지원사업 검색 방식' })).toBeTruthy()
  })

  it('직접 들어온 상세는 AI 대화 검색 탭을 선택 상태로 두고 탭을 누르면 검색 화면으로 간다', async () => {
    start(`/support-programs/detail?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.id })}`)
    await screen.findByRole('heading', { name: program.title })
    const tabs = screen.getByRole('tablist', { name: '지원사업 검색 방식' })
    expect(within(tabs).getByRole('tab', { name: 'AI 대화 검색' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(within(tabs).getByRole('tab', { name: '필터 검색' }))
    expect(screen.getByTestId('location').textContent).toBe('/?mode=filter')
    expect(await screen.findByRole('combobox', { name: '출처' })).toBeTruthy()
  })
})
