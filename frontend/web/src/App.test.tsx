// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { completeSearchResult } from './data/fixtures/supportProgramSearchResult'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { conditionMatchedProgram, relocationReviewRequiredProgram, supportProgramDetails, supportPrograms, toSupportProgramDetailFixture } from './data/fixtures/supportPrograms'
import { emptyConversationContext, readyConversationProposal } from './data/fixtures/supportProgramConversation'
import type { SupportProgramSearchReadiness } from './domain/entities/SupportProgramSearchReadiness'
import { supportProgramEvidenceQuestionTimeoutMilliseconds } from './presentation/features/support-program-detail/viewmodel/useSupportProgramEvidenceQuestionViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const readinessHookMock = vi.hoisted(() => ({
  useSupportProgramSearchReadiness: vi.fn(),
}))

vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => (
  readinessHookMock
))

beforeEach(() => {
  // 로그인 검색 결과의 관심 상태 조회가 검색·상세의 순차 fetch 대역을 소비하지 않게 경계를 분리합니다.
  vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute').mockResolvedValue([])
  // 기존 검색·상세 회귀는 해석만 대역으로 두고 실제 확인 버튼을 눌러 검색합니다.
  vi.spyOn(appContainer.resolve('interpretSupportProgramConversationUseCase'), 'execute')
    .mockImplementation(async ({ message, context }) => readyConversationProposal({ ...context, query: message.trim() }))
  readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(
    createReadinessHook(),
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('App navigation', () => {
  it('초안을 수정해도 기존 검색 결과 카드의 상세 URL을 다시 만들지 않고 새 검색 결과는 표시한다', async () => {
    const searchPrograms = supportPrograms.slice(0, 5)
    const nextProgram = { ...supportPrograms[0], id: 'next-result', title: '다음 검색의 공고' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({ query: '서울 AI', programs: searchPrograms })))
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({ query: '다음 검색', programs: [nextProgram] })))
    vi.stubGlobal('fetch', fetchMock)
    renderApp(createAppStore())
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(input)
    await screen.findByRole('heading', { name: supportPrograms[0].title })

    // 각 카드의 렌더에서 생성하는 상세 URL 횟수로 기존 결과의 반복 작업을 관찰합니다.
    const detailUrlSerialization = vi.spyOn(URLSearchParams.prototype, 'toString')
    for (let index = 1; index <= 20; index += 1) {
      fireEvent.change(input, { target: { value: `다음 검색 ${index}` } })
    }
    expect(detailUrlSerialization).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('link', { name: '상세 조건 보기' })).toHaveLength(searchPrograms.length)

    fireEvent.change(input, { target: { value: '다음 검색' } })
    await submitConfirmedSearch(input)
    await screen.findByRole('heading', { name: nextProgram.title })
    expect(screen.getAllByRole('link', { name: '상세 조건 보기' })).toHaveLength(searchPrograms.length + 1)
    expect(detailUrlSerialization).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  // 파일의 첫 테스트라 모듈 변환·초기화 시간이 포함되므로 전체 실행 부하에서도 넉넉히 둡니다.
  }, 15_000)

  it.each(['/', '/app/chat', '/app/chat/'])('%s 검색에서 상세·질문을 왕복하면 원래 배치와 서버 결과 순서를 보존한다', async (path) => {
    const returnPath = path === '/' ? '/' : '/app/chat'
    const programs = [relocationReviewRequiredProgram, conditionMatchedProgram]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({ query: '서울 AI', programs })))
      .mockImplementation(async () => jsonResponse(toSupportProgramDetailFixture(programs[0])))
    vi.stubGlobal('fetch', fetchMock)
    const store = createAppStore()
    renderApp(store, path)
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(input)
    await screen.findByRole('heading', { name: programs[0].title })
    const messages = store.getState().chat.messages
    fireEvent.click(screen.getAllByRole('link', { name: '상세 조건 보기' })[0])
    await screen.findByText('자격 미평가 · 공고 상세 정보')
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe(returnPath)
    if (returnPath === '/') {
      // 원문 질문은 회원 기능이라 비로그인은 로그인 링크만 봅니다.
      expect(screen.getByRole('link', { name: '로그인하고 이 공고에 질문하기' }).getAttribute('href')).toMatch(/^\/login\?next=/)
    } else {
      fireEvent.click(screen.getByRole('link', { name: '이 공고에 질문하기' }))
      fireEvent.click(screen.getByRole('link', { name: '← 공고 상세로 돌아가기' }))
      await screen.findByText('자격 미평가 · 공고 상세 정보')
      expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe(returnPath)
    }
    fireEvent.click(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }))
    const cards = screen.getByRole('region', { name: '지원사업 검색 결과' }).querySelectorAll('article')
    expect(Array.from(cards).map(card => card.querySelector('h2')?.textContent)).toEqual(programs.map(p => p.title))
    expect(Boolean(screen.queryByRole('complementary', { name: '작업 사이드바' }))).toBe(returnPath === '/app/chat')
    expect(store.getState().chat.messages).toEqual(messages)
    // 작업 화면 상세는 관심 공고 저장 여부도 확인하므로 검색·상세 조회만 셉니다.
    const searchAndDetailCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('/me/saved-programs'))
    expect(searchAndDetailCalls).toHaveLength(returnPath === '/' ? 2 : 3)
  })

  it('준비 상태 재확인 중 오류 안내의 버튼을 비활성화한다', () => {
    const refetch = vi.fn()
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(createReadinessHook({
      isError: true, isRefreshing: true, canSearch: false, refetch,
    }))
    renderApp(createAppStore())
    const button = screen.getByRole('button', { name: '확인 중…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(refetch).not.toHaveBeenCalled()
  })

  it('공용 헤더 가운데에 현재 화면 이름을 표시한다', () => {
    renderApp(createAppStore())

    const header = screen.getByRole('banner', { name: '앱 헤더' })
    expect(within(header).getByText('AI 채팅')).toBeTruthy()

    expect(within(header).queryByRole('link', { name: '상태관리 비교 예제' })).toBeNull()
    fireEvent.click(within(header).getByRole('link', { name: '요금제' }))
    expect(within(screen.getByRole('banner', { name: '앱 헤더' })).getByText('요금제', { selector: 'p' })).toBeTruthy()
  })

  it('헤더의 로그인을 누르면 헤더 없는 로그인 화면으로 이동한다', () => {
    renderApp(createAppStore())
    expect(screen.getByRole('heading', { name: '우리 회사에 맞는 지원사업, AI와 함께 무료로 찾아보세요.' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: '로그인' }))

    expect(screen.getByRole('form', { name: '로그인' })).toBeTruthy()
    expect(screen.queryByRole('banner', { name: '앱 헤더' })).toBeNull()
    expect(screen.getByRole('link', { name: '회원가입' })).toBeTruthy()
  })

  it('로그인에 성공하면 사이드바가 있는 작업 채팅 화면으로 이동한다', async () => {
    vi.spyOn(appContainer.resolve('logInUseCase'), 'execute').mockResolvedValue({
      outcome: 'session',
      session: {
        expiresAt: '2026-10-06T12:00:00+09:00',
        account: { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null },
      },
    })
    renderApp(createAppStore(), '/login')

    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'member@govbiz.local' } })
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'govbiz-admin1' } })
    fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))

    await waitFor(() => expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy())
    expect(screen.queryByRole('banner', { name: '앱 헤더' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '우리 회사에 맞는 지원사업, AI와 함께 무료로 찾아보세요.' })).toBeNull()
    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '서울 AI 창업지원 사업 찾아줘' })).toBeTruthy()
  })

  it.each(['/', '/app/chat'])('%s 채팅 화면은 수동 조건 패널 없이 메시지 입력으로 시작한다', (path) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderApp(createAppStore(), path)

    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '검색 전송' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '기업 검색 조건' })).toBeNull()
    expect(screen.queryByText('기업 조건 입력·수정 (선택)')).toBeNull()
    for (const label of ['현재 소재지', '업종', '설립일', '지원 목적']) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }
    expect(screen.queryByRole('combobox', { name: '접수 상태' })).toBeNull()
    expect(screen.queryByRole('button', { name: '조건 적용' })).toBeNull()
    expect(screen.queryByRole('button', { name: '조건 전체 초기화' })).toBeNull()
    expect(screen.queryByRole('button', { name: /조건 해제$/ })).toBeNull()
    expect(screen.queryByText(/편집한 값은 ‘조건 적용’ 후/)).toBeNull()
    expect(screen.queryByText(/수동 폼을 수정하면/)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['/', 1550], ['/app/chat', 1550], ['/', 0], ['/app/chat', 0],
  ] as const)('%s에서 검색 가능 공고가 %i건이면 운영 상태 패널 없이 입력창을 표시한다', (path, programCount) => {
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(createReadinessHook({
      data: {
        searchState: 'SEARCHABLE', programCount, indexReady: true,
        lastSuccessfulSyncAt: '2026-09-07T19:18:00+09:00', lastFailedSyncAt: null,
      },
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderApp(createAppStore(), path)

    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    expect(document.getElementById('support-program-search-readiness')).toBeNull()
    expect(searchInput.getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByText('공고 검색이 가능합니다.')).toBeNull()
    expect(screen.queryByText('현재 저장된 공고를 바로 검색할 수 있습니다.')).toBeNull()
    expect(screen.queryByRole('button', { name: '상태 다시 확인' })).toBeNull()
    expectReadinessDetailsAbsent()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('고관련도 확인 필요 공고를 낮은 관련도 MATCH보다 앞에 표시하며 서버 순서와 상세 복귀 시 판정을 보존한다', async () => {
    const latest = { ...supportPrograms[3], recommendationScore: null }
    const programs = [relocationReviewRequiredProgram, conditionMatchedProgram, supportPrograms[1], latest]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({ query: '사업화', programs })))
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({ query: '사업화', programs: [] })))
      .mockResolvedValueOnce(jsonResponse(toSupportProgramDetailFixture(conditionMatchedProgram)))
    vi.stubGlobal('fetch', fetchMock)
    const seoulContext = { ...emptyConversationContext, query: '사업화', companyConditions: {
      region: '서울', industry: '소프트웨어 개발업', establishedOn: '2024-02-29', supportPurpose: null,
    } }
    vi.mocked(appContainer.resolve('interpretSupportProgramConversationUseCase').execute)
      .mockResolvedValueOnce(readyConversationProposal(seoulContext))
      .mockResolvedValueOnce(readyConversationProposal({ ...seoulContext,
        companyConditions: { ...seoulContext.companyConditions, region: '부산' },
      }))
    const store = createAppStore()
    renderApp(store)
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: '서울 소프트웨어 개발업 2024-02-29 설립 사업화' } })
    await submitConfirmedSearch(input)

    const resultSection = await screen.findByRole('region', { name: '지원사업 검색 결과' })
    expect(relocationReviewRequiredProgram.recommendationScore).toBeGreaterThan(conditionMatchedProgram.recommendationScore!)
    expect(within(resultSection).getAllByRole('article').map((card) => within(card).getByRole('heading', { level: 2 }).textContent))
      .toEqual(programs.map((program) => program.title))
    expect(within(getProgramCard(conditionMatchedProgram.title)).getByText('조건 확인 · API 본문 기준')).toBeTruthy()
    expect(within(getProgramCard(latest.title)).getByText('자격 미평가')).toBeTruthy()
    const relocationCard = getProgramCard(relocationReviewRequiredProgram.title)
    expect(within(relocationCard).getByText('지역 · 확인 필요')).toBeTruthy()
    expect(within(relocationCard).getByText('서울 소재지만 확인되었으며 경북 이전 의향은 확인되지 않았습니다.')).toBeTruthy()
    expect(relocationCard.querySelector('blockquote')?.textContent).toBe('소프트웨어 개발업 창업 7년 이내 중소기업')
    expect(Array.from(relocationCard.querySelectorAll('blockquote')).map((quote) => quote.textContent))
      .toContain('선정 후 경북으로 본사를 이전하는 창업기업을 지원합니다.')
    expect(within(relocationCard).getByText('관련도 99점')).toBeTruthy()
    expect(within(relocationCard).getByText('전국 사업')).toBeTruthy()
    expect(relocationCard.textContent).not.toContain('✓')
    expect(relocationCard.textContent).not.toContain('AI 추천')
    expect(within(relocationCard).getByText(/기업마당 등 공식 API 본문 기준 · 첨부파일 미검증/)).toBeTruthy()
    expect(within(getProgramCard(supportPrograms[1].title)).getByText('자격 판정 없음 · 확인 필요')).toBeTruthy()
    expect(screen.getByRole('status').textContent)
      .toBe('지원사업 검색 결과 4건: 조건 확인 공고 1건, 확인 필요 공고 2건, 최신 공고 1건(자격 미평가)을 표시했습니다.')
    expect(store.getState().chat.messages.at(-1)?.text).toContain('조건 확인 공고 1건, 확인 필요 공고 2건')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      query: '사업화', acceptingOnly: true,
      companyConditions: { region: '서울', industry: '소프트웨어 개발업', establishedOn: '2024-02-29' },
    })

    fireEvent.change(input, { target: { value: '현재 소재지를 부산으로 변경' } })
    await submitConfirmedSearch(input)
    expect(screen.getByText(/검색 당시 조건: 접수 중만 · 현재 소재지: 서울/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fireEvent.click(within(getProgramCard(conditionMatchedProgram.title)).getByRole('link', { name: '상세 조건 보기' }))
    await screen.findByText('자격 미평가 · 공고 상세 정보')
    expect(screen.getByText(/상세 조회는 검색 당시 기업 조건으로 자격을 다시 평가하지 않습니다/)).toBeTruthy()
    expect(screen.queryByText('조건 확인 · API 본문 기준')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }))
    expect(within(getProgramCard(conditionMatchedProgram.title)).getByText('조건 확인 · API 본문 기준')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '지원사업 검색 결과' })).getAllByRole('article')
      .map((card) => within(card).getByRole('heading', { level: 2 }).textContent)).toEqual(programs.map((program) => program.title))
    expect(screen.getByText(/검색 당시 조건: 접수 중만 · 현재 소재지: 서울/)).toBeTruthy()
    expect(store.getState().chat.searchOptions.companyConditions?.region).toBe('부산')
    expect(store.getState().chat.messages.find((message) => message.programs?.length === 4)?.programs?.[1]?.eligibilityReview)
      .toEqual(conditionMatchedProgram.eligibilityReview)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('근거가 없는 UNKNOWN을 표시하고 API 본문 인용의 HTML을 실행하지 않는다', async () => {
    const quote = '<img src=x onerror=alert(1)>'
    const program = {
      ...relocationReviewRequiredProgram,
      summary: quote,
      eligibilityReview: {
        ...relocationReviewRequiredProgram.eligibilityReview!,
        target: {
          ...relocationReviewRequiredProgram.eligibilityReview!.target,
          evidence: [{ field: 'SUMMARY', quote }],
        },
        region: { status: 'UNKNOWN', explanation: '현재 소재지에 적용할 지역 조건의 근거가 없습니다.', evidence: [] },
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completeSearchResult({ query: '사업화', programs: [program] }))))
    renderApp(createAppStore())
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: '사업화' } })
    await submitConfirmedSearch(input)
    await screen.findByRole('region', { name: '지원사업 검색 결과' })
    const card = getProgramCard(program.title)
    expect(card.querySelector('blockquote')?.textContent).toBe(quote)
    expect(card.querySelector('img')).toBeNull()
    expect(within(card).getByText('확인 가능한 본문 인용 없음')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '조건 확인 공고' })).toBeNull()
  })

  it('대화 제안 확인으로 기업 조건·접수 상태를 적용·수정·해제하고 새 대화에서 초기화한다', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(completeSearchResult({ query: '지원금', programs: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const seoulContext = { ...emptyConversationContext, query: '지원금', companyConditions: {
      region: '서울', industry: '소프트웨어 개발업', establishedOn: '2024-02-29', supportPurpose: '사업화',
    } }
    const busanContext = { ...seoulContext, query: '서울 지원금', acceptingOnly: false,
      companyConditions: { ...seoulContext.companyConditions, region: '부산', industry: null },
    }
    vi.mocked(appContainer.resolve('interpretSupportProgramConversationUseCase').execute)
      .mockResolvedValueOnce(readyConversationProposal(seoulContext))
      .mockResolvedValueOnce(readyConversationProposal(busanContext))
      .mockResolvedValueOnce(readyConversationProposal({ ...emptyConversationContext, query: '지원금' }))
      .mockResolvedValueOnce(readyConversationProposal({ ...seoulContext,
        companyConditions: { ...seoulContext.companyConditions, region: '제주' },
      }))
    const store = createAppStore()
    renderApp(store)
    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(searchInput, { target: { value: '서울 소프트웨어 개발업 2024-02-29 설립 사업화 지원금' } })
    await act(async () => fireEvent.submit(searchInput.closest('form')!))
    expect(screen.getByRole('region', { name: '조건 변경 제안' })).toBeTruthy()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(fetchMock).not.toHaveBeenCalled()
    await confirmLatestProposal()
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      query: '지원금', acceptingOnly: true,
      companyConditions: { region: '서울', industry: '소프트웨어 개발업', establishedOn: '2024-02-29', supportPurpose: '사업화' },
    })

    fireEvent.change(searchInput, { target: { value: '현재 소재지는 부산, 업종 조건을 빼고 마감 공고도 포함해서 서울 지원금 찾아줘' } })
    await submitConfirmedSearch(searchInput)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      query: '서울 지원금', acceptingOnly: false,
      companyConditions: { region: '부산', establishedOn: '2024-02-29', supportPurpose: '사업화' },
    })
    expect(screen.getByText(/검색 당시 조건: 접수 중만 · 현재 소재지: 서울/)).toBeTruthy()
    expect(screen.getByText(/검색 당시 조건: 접수 상태: 전체 · 현재 소재지: 부산/)).toBeTruthy()

    fireEvent.change(searchInput, { target: { value: '기업 조건 모두 지우고 접수 중인 지원금만 찾아줘' } })
    await act(async () => fireEvent.submit(searchInput.closest('form')!))
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: false,
      companyConditions: { region: '부산', establishedOn: '2024-02-29', supportPurpose: '사업화' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await confirmLatestProposal()
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)))
      .toEqual({ query: '지원금', acceptingOnly: true })
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(screen.getByText(/검색 당시 조건: 접수 상태: 전체 · 현재 소재지: 부산/)).toBeTruthy()

    fireEvent.change(searchInput, { target: { value: '제주 소프트웨어 개발업 2024-02-29 설립 사업화 지원금' } })
    await submitConfirmedSearch(searchInput)
    expect(store.getState().chat.searchOptions.companyConditions?.region).toBe('제주')
    fireEvent.click(screen.getByRole('button', { name: '새 AI 대화 검색' }))
    expect((searchInput as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByText(/검색 당시 조건:/)).toBeNull()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
  })

  it('준비 상태와 오류 안내가 있어도 검색·취소 버튼을 입력창 안에 배치한다', async () => {
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(createReadinessHook({
      data: {
        searchState: 'SEARCHABLE_WITH_SYNC_FAILURE', programCount: 12, indexReady: true,
        lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
        lastFailedSyncAt: '2026-09-05T10:00:00+09:00',
      },
    }))
    let rejectSearch!: (reason: Error) => void
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((_resolve, reject) => {
      rejectSearch = reject
    }))
    vi.stubGlobal('fetch', fetchMock)
    renderApp(createAppStore())

    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    const inputGroup = input.parentElement!
    const notice = document.getElementById('support-program-search-readiness')!
    expect(notice).toBeTruthy()
    expect(input.getAttribute('aria-describedby')).toBe(notice.id)
    expect(inputGroup.classList.contains('relative')).toBe(true)
    expect(inputGroup.contains(notice)).toBe(false)
    expect(screen.getByRole('button', { name: '검색 전송' }).parentElement).toBe(inputGroup)

    fireEvent.change(input, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(input)
    expect(screen.getByRole('button', { name: '취소' }).parentElement).toBe(inputGroup)

    await act(async () => rejectSearch(new Error('network failure')))
    const error = await screen.findByRole('alert')
    expect(inputGroup.contains(error)).toBe(false)
    expect(screen.getByRole('button', { name: '검색 전송' }).parentElement).toBe(inputGroup)
  })

  it('두 예제의 상태 수명과 Redux의 production DI·HTTP 흐름을 비교한다', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        item: { category: string | null; name: string; note: string | null }
      }

      return new Response(JSON.stringify({
        item: request.item,
        phase: 'READY_FOR_PROCESSING',
        processing: { status: 'NOT_STARTED' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const appStore = createAppStore()

    expect(Object.keys(appStore.getState())).toEqual(['auth', 'chat', 'receivedProposals', 'sampleItem'])

    const home = renderApp(appStore)

    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBeTruthy()
    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: '서울 AI 지원사업' } })

    // 일반 UI에는 예제 진입 메뉴를 노출하지 않지만 같은 Store로 직접 열어 학습 흐름을 유지한다.
    home.unmount()
    renderApp(appStore, '/examples/sample-item/hook')

    expect(screen.getByRole('heading', { name: '재사용 가능한 수직 슬라이스' })).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: '이름' }), {
      target: { value: 'Hook에서만 유지되는 입력' },
    })

    fireEvent.click(screen.getByRole('link', { name: 'Redux Toolkit 버전' }))
    expect(screen.getByRole('heading', { name: 'Redux 기반 수직 슬라이스' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '이름' }), {
      target: { value: 'Redux에 유지되는 입력' },
    })

    fireEvent.click(screen.getByRole('link', { name: 'React Hook 버전' }))
    expect(screen.getByRole('heading', { name: '재사용 가능한 수직 슬라이스' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '이름' }) as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('link', { name: 'Redux Toolkit 버전' }))
    expect((screen.getByRole('textbox', { name: '이름' }) as HTMLInputElement).value).toBe(
      'Redux에 유지되는 입력',
    )

    await waitFor(() => {
      expect((screen.getByRole('button', { name: '준비 상태 확인' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '준비 상태 확인' }))

    await screen.findByText('✓ Redux Store에 요청 성공 저장')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/sample-items\/prepare$/)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      item: {
        category: null,
        name: 'Redux에 유지되는 입력',
        note: null,
      },
    })

    fireEvent.click(screen.getByRole('link', { name: 'React Hook 버전' }))
    fireEvent.click(screen.getByRole('link', { name: 'Redux Toolkit 버전' }))
    expect(screen.getByText('✓ Redux Store에 요청 성공 저장')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Redux 상태 초기화' }))
    expect((screen.getByRole('textbox', { name: '이름' }) as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('✓ Redux Store에 요청 성공 저장')).toBeNull()
    expect((screen.getByRole('button', { name: '준비 상태 확인' }) as HTMLButtonElement).disabled)
      .toBe(true)

    fireEvent.click(screen.getByRole('link', { name: /지원사업 채팅으로 돌아가기/ }))

    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement)
        .value,
    ).toBe('서울 AI 지원사업') // 비로그인 초안도 탭 세션 동안 남아 돌아오면 이어 씁니다.
  })

  it.each([
    ['/examples/sample-item/hook', '재사용 가능한 수직 슬라이스'],
    ['/examples/sample-item/redux', 'Redux 기반 수직 슬라이스'],
  ])('%s URL로 직접 진입한다', (path, heading) => {
    renderApp(createAppStore(), path)

    expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
    const header = screen.getByRole('banner', { name: '앱 헤더' })
    expect(within(header).getByText('상태관리 비교 예제', { selector: 'p' })).toBeTruthy()
    expect(within(header).queryByRole('link', { name: '상태관리 비교 예제' })).toBeNull()
  })

  it('검색 결과의 상세 조건 보기는 URL 기반 API 조회 화면으로 연결한다', async () => {
    const detail = supportProgramDetails[0]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({
        query: '서울 AI',
        programs: [supportPrograms[0]],
      })))
      .mockResolvedValueOnce(jsonResponse(detail))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(chatInput)

    const detailLink = await screen.findByRole('link', { name: '상세 조건 보기' })
    fireEvent.click(detailLink)

    await screen.findByRole('heading', { name: supportPrograms[0].title })
    expect(screen.getByText('서울 소재 창업 7년 이내 중소기업')).toBeTruthy()
    expect(screen.getByText('접수 중')).toBeTruthy()
    expect(screen.queryByText('이 공고를 추천한 이유')).toBeNull()

    const detailRequestUrl = new URL(String(fetchMock.mock.calls[1]?.[0]))
    expect(detailRequestUrl.pathname).toBe('/api/v1/support-programs/detail')
    expect(detailRequestUrl.searchParams.get('sourceCode')).toBe(supportPrograms[0].sourceCode)
    expect(detailRequestUrl.searchParams.get('sourceProgramId')).toBe(supportPrograms[0].id)

    const sourceLink = screen.getByRole('link', { name: /GovBiz 샘플 데이터 원문 보기/ })
    expect(sourceLink.getAttribute('href')).toBe(supportPrograms[0].sourceUrl)
    expect(sourceLink.getAttribute('target')).toBe('_blank')
    expect(sourceLink.getAttribute('rel')).toBe('noreferrer')

    fireEvent.click(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }))
    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBeTruthy()
  })

  it('상세에서 별도 질문 페이지로 이동하고 질문 제출 후에만 원문 근거 답변과 링크를 표시한다', async () => {
    const detail = supportProgramDetails[0]
    const evidenceAnswer = {
      answer: '서울 소재 창업 7년 이내 중소기업이 신청 대상입니다.',
      answerStatus: 'ANSWERED',
      citations: [{
        excerpt: `${'공고 안내입니다. '.repeat(70)}\n지원 대상은 서울 소재 창업 7년 이내 중소기업입니다.`,
        sourceUrl: detail.sourceUrl,
        chunkOrder: 0,
      }],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(jsonResponse(evidenceAnswer))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(
      createAppStore(),
      `/support-programs/detail?sourceCode=${detail.sourceCode}&sourceProgramId=${detail.id}`,
    )

    await screen.findByRole('heading', { name: detail.title })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(screen.queryByRole('textbox', { name: '공고 원문에 질문하기' })).toBeNull()

    // 원문 질문은 회원 기능이라 비로그인 상세는 로그인 뒤 작업 화면의 질문으로 잇고, 공개 질문 화면은 주소로 엽니다.
    const loginLink = screen.getByRole('link', { name: '로그인하고 이 공고에 질문하기' })
    const nextUrl = new URL(new URLSearchParams(loginLink.getAttribute('href')!.split('?')[1]).get('next')!, 'http://localhost')
    expect(nextUrl.pathname).toBe('/app/support-programs/detail/question')
    expect(nextUrl.searchParams.get('sourceCode')).toBe(detail.sourceCode)
    expect(nextUrl.searchParams.get('sourceProgramId')).toBe(detail.id)
    cleanup()
    renderApp(createAppStore(), `/support-programs/detail/question?sourceCode=${detail.sourceCode}&sourceProgramId=${detail.id}`)

    expect(screen.getByRole('heading', { name: '이 공고에 질문하기', level: 1 })).toBeTruthy()
    expect(screen.getByRole('link', { name: '← 공고 상세로 돌아가기' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledOnce()

    const question = screen.getByRole('textbox', { name: '공고 원문에 질문하기' })
    expect(screen.getByRole('button', { name: '질문하고 근거 받기' })).toBeTruthy()
    fireEvent.change(question, { target: { value: '신청 대상은 누구인가요?' } })
    fireEvent.submit(question.closest('form')!)

    await screen.findByText(evidenceAnswer.answer)
    const requestUrl = new URL(String(fetchMock.mock.calls[1]?.[0]))
    expect(requestUrl.pathname).toBe('/api/v1/support-programs/detail/answers')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      sourceCode: detail.sourceCode,
      sourceProgramId: detail.id,
      question: '신청 대상은 누구인가요?',
    })

    const citationLink = screen.getByRole('link', { name: '근거 1 원문 보기 ↗' })
    expect(citationLink.getAttribute('href')).toBe(detail.sourceUrl)
    expect(citationLink.getAttribute('target')).toBe('_blank')
    expect(citationLink.getAttribute('rel')).toBe('noreferrer')
    expect(citationLink.closest('li')?.querySelector('blockquote')?.textContent)
      .toBe(evidenceAnswer.citations[0].excerpt)
  })

  it('K-Startup 상세에서는 원문 링크를 유지하고 질문 입력이나 근거 답변 HTTP 요청을 만들지 않는다', async () => {
    const detail = {
      ...supportProgramDetails[0], sourceCode: 'KSTARTUP', sourceName: 'K-Startup',
      sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do',
      evidenceQuestionSupported: false,
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail))
    vi.stubGlobal('fetch', fetchMock)
    renderApp(createAppStore(), `/support-programs/detail?sourceCode=KSTARTUP&sourceProgramId=${detail.id}`)

    await screen.findByRole('heading', { name: detail.title })
    expect(screen.getByText('이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.'))
      .toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '공고 원문에 질문하기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '질문하고 근거 받기' })).toBeNull()
    expect(screen.queryByRole('link', { name: '이 공고에 질문하기' })).toBeNull()
    expect(screen.getByRole('link', { name: 'K-Startup 원문 보기 ↗' }).getAttribute('href')).toBe(detail.sourceUrl)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe('/api/v1/support-programs/detail')
  })

  it('질문 URL로 직접 진입하면 자동 조회 없이 특수문자 식별자로 질문하고 같은 공고 상세로 돌아간다', async () => {
    const detail = {
      ...supportProgramDetails[0],
      id: 'fixture%20/공고?종류=AI&사업=창업+수출',
    }
    const answer = {
      answer: '지원 대상은 중소기업입니다.',
      answerStatus: 'ANSWERED',
      citations: [{ excerpt: '중소기업 지원사업', sourceUrl: detail.sourceUrl, chunkOrder: 0 }],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(answer))
      .mockResolvedValueOnce(jsonResponse(detail))
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      renderApp(
        createAppStore(),
        `/support-programs/detail/question?sourceCode=${encodeURIComponent(detail.sourceCode)}&sourceProgramId=${encodeURIComponent(detail.id)}`,
      )
    })

    expect(screen.getByRole('heading', { name: '이 공고에 질문하기', level: 1 })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    const backLink = screen.getByRole('link', { name: '← 공고 상세로 돌아가기' })
    const backUrl = new URL(backLink.getAttribute('href')!, 'http://localhost')
    expect(backUrl.pathname).toBe('/support-programs/detail')
    expect(backUrl.searchParams.get('sourceCode')).toBe(detail.sourceCode)
    expect(backUrl.searchParams.get('sourceProgramId')).toBe(detail.id)

    const question = screen.getByRole('textbox', { name: '공고 원문에 질문하기' })
    fireEvent.change(question, { target: { value: '지원 대상은 누구인가요?' } })
    fireEvent.submit(question.closest('form')!)

    await screen.findByText(answer.answer)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname)
      .toBe('/api/v1/support-programs/detail/answers')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sourceCode: detail.sourceCode,
      sourceProgramId: detail.id,
      question: '지원 대상은 누구인가요?',
    })

    fireEvent.click(backLink)
    await screen.findByRole('heading', { name: detail.title })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const detailRequestUrl = new URL(String(fetchMock.mock.calls[1]?.[0]))
    expect(detailRequestUrl.pathname).toBe('/api/v1/support-programs/detail')
    expect(detailRequestUrl.searchParams.get('sourceProgramId')).toBe(detail.id)
    expect(screen.queryByRole('textbox', { name: '공고 원문에 질문하기' })).toBeNull()
  })

  it.each([
    '/support-programs/detail/question',
    '/support-programs/detail/question?sourceCode=BIZINFO',
    '/support-programs/detail/question?sourceProgramId=missing-source-code',
    '/support-programs/detail/question?sourceCode=%20&sourceProgramId=blank-source-code',
    '/support-programs/detail/question?sourceCode=BIZINFO&sourceProgramId=%20',
  ])('질문 페이지 식별자가 누락되거나 공백인 URL(%s)은 폼과 API 요청 없이 안내한다', (path) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore(), path)

    expect(screen.getByRole('heading', { name: '공고 정보를 찾을 수 없습니다' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '공고 원문에 질문하기' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('K-Startup 질문 URL로 직접 진입하면 미지원 안내만 표시하고 API를 호출하지 않는다', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      renderApp(createAppStore(), '/support-programs/detail/question?sourceCode=KSTARTUP&sourceProgramId=kstartup-program')
    })

    expect(screen.getByText('이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.'))
      .toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '공고 원문에 질문하기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '질문하고 근거 받기' })).toBeNull()
    const backUrl = new URL(
      screen.getByRole('link', { name: '← 공고 상세로 돌아가기' }).getAttribute('href')!,
      'http://localhost',
    )
    expect(backUrl.searchParams.get('sourceCode')).toBe('KSTARTUP')
    expect(backUrl.searchParams.get('sourceProgramId')).toBe('kstartup-program')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('질문 요청 중 상세로 돌아가면 요청을 취소하고 재진입한 질문에 늦은 답변을 표시하지 않는다', async () => {
    const detail = supportProgramDetails[0]
    let resolveAnswer!: (response: Response) => void
    const fetchMock = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveAnswer = resolve }))
      .mockResolvedValueOnce(jsonResponse(detail))
    vi.stubGlobal('fetch', fetchMock)

    // 상세에서 질문으로 다시 들어가는 왕복은 회원 기능이라 로그인한 작업 화면에서 확인합니다.
    vi.spyOn(appContainer.resolve('checkSavedSupportProgramUseCase'), 'execute').mockResolvedValue(false)
    renderApp(
      createAppStore(),
      `/app/support-programs/detail/question?sourceCode=${detail.sourceCode}&sourceProgramId=${detail.id}`,
    )
    const question = screen.getByRole('textbox', { name: '공고 원문에 질문하기' })
    fireEvent.change(question, { target: { value: '이전 질문' } })
    fireEvent.submit(question.closest('form')!)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)
    expect(screen.getByRole('button', { name: '질문 취소' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: '← 공고 상세로 돌아가기' }))
    expect(signal.aborted).toBe(true)
    await screen.findByRole('heading', { name: detail.title })
    fireEvent.click(screen.getByRole('link', { name: '이 공고에 질문하기' }))
    const nextQuestion = screen.getByRole('textbox', { name: '공고 원문에 질문하기' })
    expect((nextQuestion as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(nextQuestion, { target: { value: '새 질문' } })

    await act(async () => resolveAnswer(jsonResponse({
      answer: '이전 질문의 늦은 답변입니다.',
      answerStatus: 'ANSWERED',
      citations: [{ excerpt: '이전 근거', sourceUrl: detail.sourceUrl, chunkOrder: 0 }],
    })))

    expect(screen.queryByText('이전 질문의 늦은 답변입니다.')).toBeNull()
    expect((nextQuestion as HTMLTextAreaElement).value).toBe('새 질문')
    expect((screen.getByRole('button', { name: '질문하고 근거 받기' }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('원문 질문이 응답하지 않으면 시간 초과를 알리고 같은 질문의 재전송을 허용한다', async () => {
    vi.useFakeTimers()
    const detail = supportProgramDetails[0]
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    renderApp(
      createAppStore(),
      `/support-programs/detail/question?sourceCode=${detail.sourceCode}&sourceProgramId=${detail.id}`,
    )
    const question = screen.getByRole('textbox', { name: '공고 원문에 질문하기' }) as HTMLTextAreaElement
    fireEvent.change(question, { target: { value: '신청 대상은 누구인가요?' } })
    fireEvent.submit(question.closest('form')!)
    expect(question.disabled).toBe(true)

    await act(async () => vi.advanceTimersByTimeAsync(supportProgramEvidenceQuestionTimeoutMilliseconds))
    expect(screen.getByRole('alert').textContent)
      .toBe('답변 시간이 초과되었습니다. 입력한 질문을 다시 전송해 주세요.')
    expect(question.disabled).toBe(false)
    expect(question.value).toBe('신청 대상은 누구인가요?')
    expect((screen.getByRole('button', { name: '질문하고 근거 받기' }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(true)
  })

  it.each([
    [{
      answer: '원문 근거가 부족합니다.',
      answerStatus: 'INSUFFICIENT_EVIDENCE',
      citations: [],
    }, '공고 원문에서 이 질문에 답할 만큼 충분한 근거를 찾지 못했습니다. 원문 공고를 확인해 주세요.'],
    [new Response('', { status: 422 }), '이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.'],
    [new Response('', { status: 503 }), '원문 근거 답변을 지금 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
    [requestRejectedResponse(429), '짧은 시간에 요청이 많아 잠시 제한되었습니다. 약 12초 후 직접 다시 시도해 주세요.'],
    [requestRejectedResponse(503), '현재 다른 요청을 처리하고 있어 새 요청을 시작할 수 없습니다. 약 12초 후 직접 다시 시도해 주세요.'],
  ])('원문 답변의 응답 상태에 안전한 안내를 표시한다', async (answerResponse, expectedMessage) => {
    const detail = supportProgramDetails[0]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answerResponse instanceof Response ? answerResponse : jsonResponse(answerResponse))
    vi.stubGlobal('fetch', fetchMock)

    // 질문 페이지 진입의 초기 effect까지 끝내고 사용자 입력을 시작합니다.
    await act(async () => {
      renderApp(
        createAppStore(),
        `/support-programs/detail/question?sourceCode=${detail.sourceCode}&sourceProgramId=${detail.id}`,
      )
    })

    const question = await screen.findByRole('textbox', { name: '공고 원문에 질문하기' })
    fireEvent.change(question, { target: { value: '신청 대상은 누구인가요?' } })
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '질문하고 근거 받기' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.submit(question.closest('form')!)

    expect(await screen.findByText(expectedMessage)).toBeTruthy()
    expect((question as HTMLTextAreaElement).value).toBe('신청 대상은 누구인가요?')
    expect((screen.getByRole('button', { name: '질문하고 근거 받기' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('private server detail')).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [429, '짧은 시간에 요청이 많아 잠시 제한되었습니다. 약 12초 후 직접 다시 시도해 주세요.'],
    [503, '현재 다른 요청을 처리하고 있어 새 요청을 시작할 수 없습니다. 약 12초 후 직접 다시 시도해 주세요.'],
  ])('검색 HTTP %s를 장애와 구별하여 안내하고 직접 다시 검색할 수 있다', async (status, message) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(requestRejectedResponse(status))
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({ query: '서울 AI', programs: [supportPrograms[0]] })))
    vi.stubGlobal('fetch', fetchMock)
    const store = createAppStore()
    renderApp(store)

    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(searchInput, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(searchInput)
    expect((await screen.findByText(message)).closest('[role="alert"]')).toBeTruthy()
    expect((searchInput as HTMLTextAreaElement).value).toBe('서울 AI')
    expect(screen.queryByText('private server detail')).toBeNull()
    const rejectedMessages = [...store.getState().chat.messages]
    expect(fetchMock).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '다시 검색' }))
    await screen.findByRole('link', { name: '상세 조건 보기' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.getState().chat.messages.slice(0, rejectedMessages.length)).toEqual(rejectedMessages)
  })

  it('제공처가 다른 동일 원본 ID 공고를 각각 표시하고 올바른 상세 식별자로 조회한다', async () => {
    const sharedProgramId = 'SHARED-PROGRAM-ID'
    const bizInfoProgram = {
      ...supportPrograms[0],
      id: sharedProgramId,
      title: '기업마당 동일 원본 ID 공고',
    }
    const otherProgram = {
      ...supportPrograms[1],
      sourceCode: 'OTHER',
      id: sharedProgramId,
      title: '기타 제공처 동일 원본 ID 공고',
      sourceName: '테스트 제공처',
      sourceUrl: 'https://support-programs.other.test/programs/shared',
    }
    // 아직 연동하지 않은 제공처는 HTTP allowlist에 추가하지 않고 Domain 경계에서 대역을 제공합니다.
    const repository = appContainer.resolve('supportProgramRepository')
    vi.spyOn(repository, 'search').mockResolvedValue(completeSearchResult({ query: '동일 ID', programs: [bizInfoProgram, otherProgram] }))
    const getDetail = vi.spyOn(repository, 'getDetail')
      .mockResolvedValueOnce(toSupportProgramDetailFixture(bizInfoProgram))
      .mockResolvedValueOnce(toSupportProgramDetailFixture(otherProgram))

    renderApp(createAppStore())

    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: '동일 ID' } })
    await submitConfirmedSearch(chatInput)

    await screen.findByRole('heading', { name: bizInfoProgram.title, level: 2 })
    await screen.findByRole('heading', { name: otherProgram.title, level: 2 })

    const bizInfoCard = getProgramCard(bizInfoProgram.title)
    const otherCard = getProgramCard(otherProgram.title)
    expect(within(bizInfoCard).getByRole('link', { name: '원문 보기 ↗' }).getAttribute('href'))
      .toBe(bizInfoProgram.sourceUrl)
    expect(within(otherCard).getByRole('link', { name: '원문 보기 ↗' }).getAttribute('href'))
      .toBe(otherProgram.sourceUrl)

    fireEvent.click(within(bizInfoCard).getByRole('link', { name: '상세 조건 보기' }))
    await screen.findByRole('heading', { name: bizInfoProgram.title, level: 1 })
    expect(getDetail).toHaveBeenNthCalledWith(1, {
      sourceCode: bizInfoProgram.sourceCode,
      sourceProgramId: sharedProgramId,
    }, expect.any(AbortSignal))

    fireEvent.click(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }))
    await screen.findByRole('heading', { name: otherProgram.title, level: 2 })

    fireEvent.click(within(getProgramCard(otherProgram.title)).getByRole('link', { name: '상세 조건 보기' }))
    await screen.findByRole('heading', { name: otherProgram.title, level: 1 })
    expect(getDetail).toHaveBeenNthCalledWith(2, {
      sourceCode: otherProgram.sourceCode,
      sourceProgramId: sharedProgramId,
    }, expect.any(AbortSignal))
    expect(screen.queryByRole('textbox', { name: '공고 원문에 질문하기' })).toBeNull()
    expect(screen.getByText('이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.'))
      .toBeTruthy()
  })

  it('한글 조합 중 Enter는 검색을 전송하지 않고 조합이 끝난 뒤 전송한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeSearchResult({
      query: '서울 AI',
      programs: [supportPrograms[0]],
    })))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: '서울 AI' } })
    fireEvent.compositionStart(chatInput)
    fireEvent.keyDown(chatInput, { isComposing: true, key: 'Enter' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect((chatInput as HTMLTextAreaElement).value).toBe('서울 AI')

    fireEvent.compositionEnd(chatInput)
    fireEvent.keyDown(chatInput, { key: 'Enter' })
    await confirmLatestProposal()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  })

  it('Safari가 한글 조합 완료 직후 보내는 Enter도 검색을 전송하지 않는다', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: '서울 AI' } })
    fireEvent.compositionStart(chatInput)
    fireEvent.compositionEnd(chatInput)
    fireEvent.keyDown(chatInput, { key: 'Enter', keyCode: 229 })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('500자를 넘는 검색어는 API를 호출하지 않고 이유를 안내한다', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const overlongQuery = '가'.repeat(501)
    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: overlongQuery } })
    await submitConfirmedSearch(chatInput)

    expect(fetchMock).not.toHaveBeenCalled()
    expect((chatInput as HTMLTextAreaElement).value).toBe(overlongQuery)
    expect(screen.getByRole('alert').textContent).toBe(
      '검색어는 500자 이하로 입력해 주세요. 현재 501자입니다.',
    )
  })

  it('검색 실패 시 검색어를 복구하고 다시 검색할 수 있다', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(jsonResponse(completeSearchResult({
        query: '서울 AI',
        programs: [supportPrograms[0]],
      })))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(chatInput)

    await screen.findByRole('alert')
    expect((chatInput as HTMLTextAreaElement).value).toBe('서울 AI')

    fireEvent.click(screen.getByRole('button', { name: '다시 검색' }))

    await screen.findByText('현재 접수 중인 공고에서 조건 확인 공고 0건, 확인 필요 공고 1건을 찾았습니다. 조건 확인은 공식 API 본문 기준이며 최종 신청 자격을 보장하지 않습니다. 확인 필요 공고는 원문 조건을 추가로 확인해 주세요.')
    expect(screen.getByRole('status').textContent).toBe('지원사업 검색 결과 1건: 조건 확인 공고 0건, 확인 필요 공고 1건을 표시했습니다.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('초기 공고 데이터 준비 중에는 해석을 허용하고 검색 확인은 막는다', async () => {
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(
      createReadinessHook({
        canSearch: false,
        data: {
          searchState: 'PREPARING',
          programCount: 0,
          indexReady: false,
          lastSuccessfulSyncAt: null,
          lastFailedSyncAt: null,
        },
      }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    expect(screen.getByText('공고를 준비하고 있습니다. 잠시만 기다려 주세요.')).toBeTruthy()
    expectReadinessDetailsAbsent()
    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    expect(searchInput.getAttribute('aria-describedby')).toBe('support-program-search-readiness')
    expect((searchInput as HTMLTextAreaElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '검색 전송' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getAllByRole('button', { name: '서울 AI 창업지원 사업 찾아줘' })[0] as HTMLButtonElement).disabled)
      .toBe(false)
    fireEvent.change(searchInput, { target: { value: '서울 AI' } })
    await act(async () => fireEvent.submit(searchInput.closest('form')!))
    expect((await screen.findByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement).disabled).toBe(true)
    expect(vi.mocked(appContainer.resolve('interpretSupportProgramConversationUseCase').execute)).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('공고 상태를 처음 확인하는 동안에는 준비 중과 구분된 안내를 표시한다', () => {
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(
      createReadinessHook({
        canSearch: false,
        data: undefined,
        isInitialLoading: true,
      }),
    )

    renderApp(createAppStore())

    expect(screen.getByText('공고 데이터 상태를 확인하고 있습니다.')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '지원사업 검색어' }).getAttribute('aria-describedby'))
      .toBe('support-program-search-readiness')
    expectReadinessDetailsAbsent()
    expect((screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement).disabled)
      .toBe(false)
  })

  it.each(['/', '/app/chat'])('%s에서 상태 조회 실패는 간단히 안내하고 재조회 성공 시 안내와 접근성 참조를 제거한다', async (path) => {
    const refetch = vi.fn()
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(createReadinessHook({
      data: undefined, canSearch: false, isError: true, refetch,
    }))
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeSearchResult({ query: '창업', programs: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const store = createAppStore()
    const view = renderApp(store, path)

    const notice = document.getElementById('support-program-search-readiness')!
    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    expect(within(notice).getByText('공고 데이터 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.')).toBeTruthy()
    expect(notice.getAttribute('role')).toBe('alert')
    expect(searchInput.getAttribute('aria-describedby')).toBe(notice.id)
    expectReadinessDetailsAbsent()
    fireEvent.change(searchInput, { target: { value: '창업' } })
    await act(async () => fireEvent.submit(searchInput.closest('form')!))
    expect((await screen.findByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '상태 다시 확인' }))
    expect(refetch).toHaveBeenCalledOnce()
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(createReadinessHook())
    view.rerender(
      <Provider store={store}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    expect(document.getElementById('support-program-search-readiness')).toBeNull()
    expect(searchInput.getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByRole('button', { name: '상태 다시 확인' })).toBeNull()
    expect((screen.getByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement).disabled).toBe(false)
    await confirmLatestProposal()
    await screen.findByText('현재 일치하는 공고를 찾지 못했습니다. 지역이나 분야를 바꿔 다시 검색해 보세요.')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each(['UNAVAILABLE', 'SEARCHABLE_WITH_PARTIAL_SOURCES'] as const)('%s 재확인 중에는 짧은 상태 안내의 중복 요청을 막는다', (searchState) => {
    const refetch = vi.fn()
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(createReadinessHook({
      data: {
        searchState, programCount: 12, indexReady: searchState !== 'UNAVAILABLE',
        lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
        lastFailedSyncAt: '2026-09-05T10:00:00+09:00',
      },
      canSearch: searchState !== 'UNAVAILABLE', isRefreshing: true, refetch,
    }))
    renderApp(createAppStore())

    const retry = screen.getByRole('button', { name: '확인 중…' }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    fireEvent.click(retry)
    expect(refetch).not.toHaveBeenCalled()
    expectReadinessDetailsAbsent()
  })

  it('최신 동기화가 실패해도 이전 공고 검색은 유지하고 짧은 주의만 표시한다', async () => {
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(
      createReadinessHook({
        data: {
          searchState: 'SEARCHABLE_WITH_SYNC_FAILURE',
          programCount: 12,
          indexReady: true,
          lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
          lastFailedSyncAt: '2026-09-05T10:00:00+09:00',
        },
      }),
    )
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeSearchResult({
      query: '서울 AI',
      programs: [supportPrograms[0]],
    })))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    expect(screen.getByText('최신 공고를 불러오지 못해 이전에 저장한 공고에서 검색합니다.')).toBeTruthy()
    expectReadinessDetailsAbsent()
    expect(screen.queryByText('12건')).toBeNull()

    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    expect((searchInput as HTMLTextAreaElement).disabled).toBe(false)
    fireEvent.change(searchInput, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(searchInput)
    await screen.findByRole('heading', { name: supportPrograms[0].title, level: 2 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('검색 불가 상태는 검색을 막고 짧은 안내에서 상태 확인을 다시 요청할 수 있다', async () => {
    const refetch = vi.fn()
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(
      createReadinessHook({
        canSearch: false,
        data: {
          searchState: 'UNAVAILABLE',
          programCount: 0,
          indexReady: false,
          lastSuccessfulSyncAt: null,
          lastFailedSyncAt: '2026-09-05T10:00:00+09:00',
        },
        refetch,
      }),
    )

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderApp(createAppStore())

    expect(screen.getByRole('alert').textContent).toContain('현재 공고 데이터를 검색할 수 없습니다.')
    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    expect(searchInput.disabled).toBe(false)
    expect(searchInput.getAttribute('aria-describedby')).toBe('support-program-search-readiness')
    expectReadinessDetailsAbsent()
    fireEvent.change(searchInput, { target: { value: '창업' } })
    await act(async () => fireEvent.submit(searchInput.closest('form')!))
    expect((await screen.findByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '상태 다시 확인' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('일부 제공처만 준비되어도 검색을 허용하고 상세 상태 없이 검색 범위 주의만 표시한다', async () => {
    readinessHookMock.useSupportProgramSearchReadiness.mockReturnValue(
      createReadinessHook({
        data: {
          searchState: 'SEARCHABLE_WITH_PARTIAL_SOURCES', programCount: 12, indexReady: true,
          lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
          lastFailedSyncAt: '2026-09-05T10:00:00+09:00',
          sources: [{
            sourceCode: 'BIZINFO', sourceName: '기업마당', searchState: 'SEARCHABLE_WITH_SYNC_FAILURE',
            programCount: 12, indexReady: true,
            lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
            lastFailedSyncAt: '2026-09-05T10:00:00+09:00',
          }, {
            sourceCode: 'KSTARTUP', sourceName: 'K-Startup', searchState: 'PREPARING',
            programCount: 7, indexReady: false, lastSuccessfulSyncAt: null, lastFailedSyncAt: null,
          }],
        },
      }),
    )
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeSearchResult({ query: '창업', programs: [supportPrograms[0]] })))
    vi.stubGlobal('fetch', fetchMock)
    renderApp(createAppStore())

    expect(screen.getByText('일부 제공처의 공고만 검색할 수 있습니다.')).toBeTruthy()
    expectReadinessDetailsAbsent()
    expect(screen.queryByText('기업마당')).toBeNull()
    expect(screen.queryByText('K-Startup')).toBeNull()
    expect(screen.queryByText('12건')).toBeNull()
    expect(screen.queryByText('7건')).toBeNull()

    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    expect((searchInput as HTMLTextAreaElement).disabled).toBe(false)
    fireEvent.change(searchInput, { target: { value: '창업' } })
    await submitConfirmedSearch(searchInput)
    await screen.findByRole('heading', { name: supportPrograms[0].title, level: 2 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('검색 실패 뒤 공고 상태가 검색 불가로 바뀌면 다시 검색 버튼을 숨긴다', async () => {
    let currentReadiness = createReadinessHook()
    readinessHookMock.useSupportProgramSearchReadiness.mockImplementation(
      () => currentReadiness,
    )
    const fetchMock = vi.fn(() => {
      currentReadiness = createReadinessHook({
        canSearch: false,
        data: {
          searchState: 'UNAVAILABLE',
          programCount: 0,
          indexReady: false,
          lastSuccessfulSyncAt: null,
          lastFailedSyncAt: '2026-09-05T10:00:00+09:00',
        },
      })
      return Promise.reject(new Error('temporary search failure'))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(searchInput, { target: { value: '서울 AI' } })
    await submitConfirmedSearch(searchInput)

    await screen.findByText('지원사업을 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    expect(screen.queryByRole('button', { name: '다시 검색' })).toBeNull()
    expect((screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement).disabled)
      .toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('검색 가능한 상태에서 빈 검색 결과는 공고 없음으로 안내한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeSearchResult({
      query: '존재하지 않는 조건',
      programs: [],
    })))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const searchInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(searchInput, { target: { value: '존재하지 않는 조건' } })
    await submitConfirmedSearch(searchInput)

    await screen.findByText('현재 일치하는 공고를 찾지 못했습니다. 지역이나 분야를 바꿔 다시 검색해 보세요.')
    expect(document.getElementById('support-program-search-readiness')).toBeNull()
    expect(searchInput.getAttribute('aria-describedby')).toBe('support-program-current-conditions')
  })

  it('진행 중인 검색은 취소할 수 있고 검색어를 유지한다', async () => {
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        requestSignal = init?.signal ?? undefined
        requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        })
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore())

    const chatInput = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(chatInput, { target: { value: '수출' } })
    await submitConfirmedSearch(chatInput)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: '취소' }))

    expect(requestSignal?.aborted).toBe(true)
    expect((chatInput as HTMLTextAreaElement).value).toBe('수출')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('새로고침 또는 공유 URL의 직접 진입도 Core API에서 상세 정보를 다시 조회한다', async () => {
    const detail = supportProgramDetails[0]
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(
      createAppStore(),
      `/support-programs/detail?sourceCode=${encodeURIComponent(detail.sourceCode)}&sourceProgramId=${encodeURIComponent(detail.id)}`,
    )

    expect(screen.getByRole('heading', { name: '공고 정보를 불러오는 중입니다' })).toBeTruthy()
    await screen.findByRole('heading', { name: detail.title })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('존재하지 않거나 비활성화된 공고는 404 안내를 보여 준다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))

    renderApp(createAppStore(), '/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=unknown-program')

    await screen.findByRole('heading', { name: '공고 정보를 찾을 수 없습니다' })
    expect(screen.getByText(/존재하지 않거나 더 이상 제공되지 않는 공고입니다/)).toBeTruthy()
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' })).toBeTruthy()
  })

  it.each([
    '/support-programs/detail',
    '/support-programs/detail?sourceCode=BIZINFO',
    '/support-programs/detail?sourceProgramId=missing-source-code',
    '/support-programs/detail?sourceCode=%20&sourceProgramId=blank-source-code',
    '/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=%20',
  ])('식별자가 누락되거나 공백인 URL(%s)은 API를 호출하지 않는다', (path) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderApp(createAppStore(), path)

    expect(screen.getByRole('heading', { name: '공고 정보를 찾을 수 없습니다' })).toBeTruthy()
    expect(screen.getByText('공고 주소가 올바르지 않습니다. 검색 결과에서 공고를 다시 선택해 주세요.'))
      .toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('상세 조회 API가 실패하면 안전한 오류 안내를 보여 준다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    renderApp(
      createAppStore(),
      '/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=temporarily-unavailable',
    )

    await screen.findByRole('heading', { name: '공고 정보를 불러오지 못했습니다' })
    expect(screen.getByText(/잠시 후 다시 시도해 주세요/)).toBeTruthy()
  })

  it('퍼센트와 슬래시가 포함된 원본 공고 ID도 URL 인코딩 후 상세 조회한다', async () => {
    const program = {
      ...supportProgramDetails[0],
      id: 'fixture%20/program?',
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(program))
    vi.stubGlobal('fetch', fetchMock)

    renderApp(
      createAppStore(),
      `/support-programs/detail?sourceCode=${encodeURIComponent(program.sourceCode)}&sourceProgramId=${encodeURIComponent(program.id)}`,
    )

    await screen.findByRole('heading', { name: program.title })
    const detailRequestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(detailRequestUrl.searchParams.get('sourceProgramId')).toBe(program.id)
  })
})

function renderApp(
  appStore: ReturnType<typeof createAppStore>,
  initialEntry = '/',
) {
  // 공개 화면은 비로그인, 작업 화면(/app)은 회원 세션으로 시작합니다. 세션 복원 요청은 보내지 않습니다.
  appStore.dispatch(sessionRestored(
    initialEntry.startsWith('/app/')
      ? { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }
      : null,
  ))
  return render(
    <Provider store={appStore}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestRejectedResponse(status: number) {
  return new Response(JSON.stringify({
    type: 'about:blank', title: 'Request rejected', status,
    detail: 'private server detail', instance: '/api/v1/support-programs/search',
    code: status === 429 ? 'SUPPORT_PROGRAM_RATE_LIMITED' : 'SUPPORT_PROGRAM_BUSY',
    retryAfterSeconds: 12,
  }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '12' },
  })
}

async function submitConfirmedSearch(input: HTMLElement) {
  const value = (input as HTMLTextAreaElement).value
  fireEvent.submit(input.closest('form')!)
  if (value.length > 500 || !value.trim()) return
  await confirmLatestProposal()
}

async function confirmLatestProposal() {
  const confirm = await screen.findByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement
  if (!confirm.disabled) await act(async () => fireEvent.click(confirm))
}

function getProgramCard(title: string): HTMLElement {
  const card = screen.getByRole('heading', { name: title, level: 2 }).closest('article')
  if (!card) throw new Error(`지원사업 카드가 없습니다: ${title}`)
  return card
}

function expectReadinessDetailsAbsent() {
  expect(screen.queryByRole('list', { name: '제공처별 공고 준비 상태' })).toBeNull()
  for (const label of [
    '검색 가능한 공고', '검색 인덱스', '마지막 성공 동기화', '마지막 실패 동기화',
    '저장된 공고', '검색 준비', '성공 동기화', '실패 동기화', '기록 없음',
  ]) {
    expect(screen.queryByText(label)).toBeNull()
  }
}

function createReadinessHook(overrides: {
  data?: Omit<SupportProgramSearchReadiness, 'sources'> & { sources?: SupportProgramSearchReadiness['sources'] }
  isError?: boolean
  isInitialLoading?: boolean
  isRefreshing?: boolean
  canSearch?: boolean
  refetch?: () => unknown
} = {}) {
  const data = 'data' in overrides ? overrides.data : {
    searchState: 'SEARCHABLE' as const,
    programCount: 12,
    indexReady: true,
    lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
    lastFailedSyncAt: null,
  }
  return {
    isError: false,
    isInitialLoading: false,
    isRefreshing: false,
    canSearch: true,
    refetch: vi.fn(),
    ...overrides,
    data: data ? {
      ...data,
      sources: data.sources ?? [{
        sourceCode: 'BIZINFO', sourceName: '기업마당',
        searchState: data.searchState === 'SEARCHABLE_WITH_PARTIAL_SOURCES' ? 'SEARCHABLE' : data.searchState,
        programCount: data.programCount, indexReady: data.indexReady,
        lastSuccessfulSyncAt: data.lastSuccessfulSyncAt, lastFailedSyncAt: data.lastFailedSyncAt,
      }],
    } : undefined,
  }
}
