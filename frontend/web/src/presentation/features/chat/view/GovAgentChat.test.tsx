// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppStore } from '../../../../app/store'
import { appContainer } from '../../../../app/appContainer'
import { supportProgramClient } from '../../../../data/api/supportProgramClient'
import { emptyConversationContext, readyConversationProposal } from '../../../../data/fixtures/supportProgramConversation'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'
import { partnerRecruitmentSummaries } from '../../../../data/fixtures/partnerRecruitments'
import type { PartnerRecruitmentRecommendations } from '@govbiz/shared/domain/entities/PartnerRecruitmentRecommendation'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { conversationHistoryOpened, createChatConversationSnapshot } from '../state/chatSlice'
import { RouteDocumentTitle } from '../../../shared/routes/RouteDocumentTitle'
import { SupportProgramSearchPage } from '../../support-program-catalog/view/SupportProgramSearchPage'
import { answerRunFixture } from '../../combination-review/testing/reviewFixtures'

vi.mock('../hooks/useSupportProgramSearchReadiness', () => ({ useSupportProgramSearchReadiness: () => ({
  canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(), data: { searchState: 'SEARCHABLE' },
}) }))
vi.mock('../viewmodel/useSearchResultInterests', async (importOriginal) => ({
  ...await importOriginal<typeof import('../viewmodel/useSearchResultInterests')>(), useSearchResultInterests: () => null,
}))
// 이용량은 테스트마다 바꿀 수 있게 둡니다. 기본은 한도 없음(줄을 그리지 않음)입니다.
const planUsageState = vi.hoisted(() => ({ usage: null as unknown }))
vi.mock('../../../shared/plan-usage/usePlanUsage', () => ({ usePlanUsage: () => ({ usage: planUsageState.usage, reload: vi.fn() }) }))
vi.mock('../../combination-review/view/CombinationReviewPages', () => ({
  CombinationReviewPanel: ({ id, onCreated }: { id: number | null; onCreated: (id: number) => void }) => (
    <section aria-label="대화 중복 검토"><p>{id === null ? '새 검토' : `저장된 검토 ${id}`}</p>
      <button onClick={() => onCreated(12)}>검토 저장</button></section>
  ),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); planUsageState.usage = null })

/** 맞춤 추천 응답 대역입니다. 첫 글은 관심 공고·역량, 둘째 글은 역할만 맞고 희망 지역이 다릅니다. */
function recommendations(): PartnerRecruitmentRecommendations {
  const [first, second, third] = partnerRecruitmentSummaries
  return {
    items: [
      { recruitment: first!, cautions: [], reasons: [
        { type: 'MY_PROGRAM', values: [first!.program.title], programSource: 'SAVED' },
        { type: 'CAPABILITY', values: ['데이터 구축', '라벨링'], programSource: null },
      ] },
      { recruitment: second!, reasons: [{ type: 'ROLE', values: ['PARTICIPANT'], programSource: null }], cautions: [{ type: 'OTHER_REGION', value: '부산' }] },
      { recruitment: third!, reasons: [], cautions: [] },
    ],
    total: 4,
    basis: { hasCompany: true, profileSet: true, roles: ['PARTICIPANT'], capabilityCount: 2, myProgramCount: 1, region: '서울' },
    relax: [],
    suggestedProgram: { sourceCode: 'BIZINFO', sourceProgramId: 'FREE-1', title: '빈 공고' },
  }
}

function setup(role: 'ADMIN' | 'USER') {
  const store = createAppStore()
  store.dispatch(signedIn({ email: 'test@govbiz.local', role, tier: role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
    emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }))
  render(<Provider store={store}><MemoryRouter initialEntries={['/app/chat']}>
    <RouteDocumentTitle /><SupportProgramSearchPage layout="workspace" />
  </MemoryRouter></Provider>)
  return store
}

it('관리자는 검색 확인 후 같은 입력창에서 선택 공고의 근거를 읽는다', async () => {
  const gov = vi.spyOn(supportProgramClient, 'sendGovAgentMessage').mockResolvedValue({ outcome: 'SEARCH',
    interpretation: readyConversationProposal({ ...emptyConversationContext, query: 'AI 창업' }) })
  const search = vi.spyOn(appContainer.resolve('searchSupportProgramsUseCase'), 'execute')
    .mockResolvedValue(completeSearchResult({ query: 'AI 창업', programs: [supportPrograms[0]] }))
  setup('ADMIN')
  expect(screen.getByRole('tab', { name: 'Gov 에이전트' })).toBeTruthy()
  expect(document.title).toBe('Gov 에이전트 · GovBiz')
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  fireEvent.change(input, { target: { value: 'AI 창업지원 찾아줘' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  expect(search).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
  fireEvent.click(screen.getByRole('button', { name: '이 공고 선택' }))
  expect(screen.getByText('선택한 공고:')).toBeTruthy()
  const program = supportPrograms[0]
  gov.mockResolvedValue({ outcome: 'EVIDENCE', program: { sourceCode: program.sourceCode, sourceProgramId: program.id },
    evidence: { answer: '누리집에서 신청하세요.', answerStatus: 'ANSWERED', citations: [{ excerpt: '누리집 온라인 신청',
      sourceUrl: program.sourceUrl, sourceLabel: '기업마당 상세 본문', chunkOrder: 0 }] } })
  fireEvent.change(input, { target: { value: '신청 방법은?' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  expect(screen.getByText('누리집에서 신청하세요.')).toBeTruthy()
  expect(screen.getByRole('link', { name: '기업마당 상세 본문 ↗' }).getAttribute('href')).toBe(program.sourceUrl)
  expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBe(input)
  expect(search).toHaveBeenCalledOnce()
})

it('관리자는 공고를 고르면 원문 질문 기본 질문을 눌러 바로 묻고, 근거 원문은 접혀 있다', async () => {
  planUsageState.usage = { plan: 'FREE', items: [{ feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 5, used: 2, resetsAt: '2026-10-13T00:00:00+09:00' }] }
  const gov = vi.spyOn(supportProgramClient, 'sendGovAgentMessage').mockResolvedValue({ outcome: 'SEARCH',
    interpretation: readyConversationProposal({ ...emptyConversationContext, query: 'AI 창업' }) })
  vi.spyOn(appContainer.resolve('searchSupportProgramsUseCase'), 'execute')
    .mockResolvedValue(completeSearchResult({ query: 'AI 창업', programs: [supportPrograms[0]] }))
  setup('ADMIN')
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  fireEvent.change(input, { target: { value: 'AI 창업지원 찾아줘' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
  // 공고를 고르기 전에는 기본 질문 칩이 없습니다.
  expect(screen.queryByRole('group', { name: '이 공고에 바로 묻기' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '이 공고 선택' }))
  // 고르면 마지막 메시지 아래에 기본 질문 넷이 칩으로 나옵니다(이어 묻기 칩, 막대에는 두지 않음).
  const quick = screen.getByRole('group', { name: '이 공고에 바로 묻기' })
  expect(Array.from(quick.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['지원 대상', '신청 방법', '신청 기간', '문의처'])
  // 두 줄 막대: 첫 줄은 제목(마우스를 올리면 전체) · 원문 질문 남은 횟수 · 해제(✕), 둘째 줄은 작업 칩뿐입니다.
  const bar = screen.getByRole('region', { name: '선택한 공고' })
  expect(within(bar).queryByRole('button', { name: '신청 기간' })).toBeNull()
  expect(bar.querySelector('strong')?.getAttribute('title')).toBe(supportPrograms[0].title)
  const clear = within(bar).getByRole('button', { name: '선택 해제' })
  const usageLine = within(bar).getByText('공고 원문 질문').closest('p')!
  expect(usageLine.textContent).toContain('오늘 3회 남음')
  expect(usageLine.parentElement).toBe(clear.parentElement)
  expect(usageLine.nextElementSibling).toBe(clear)

  const program = supportPrograms[0]
  const evidenceAnswer: Parameters<typeof gov.mockResolvedValue>[0] = { outcome: 'EVIDENCE', program: { sourceCode: program.sourceCode, sourceProgramId: program.id },
    evidence: { answer: '10월 31일 18시까지 신청할 수 있습니다.', answerStatus: 'ANSWERED', citations: [{
      excerpt: `공고명: ${program.title}\n\n공식 원문: ${program.sourceUrl}\n\n신청기간\n\n2026.10.01 ~ 2026.10.31 18:00`,
      sourceUrl: program.sourceUrl, sourceLabel: '기업마당 상세 본문', chunkOrder: 0 }] } }
  let answer!: (value: typeof evidenceAnswer) => void
  gov.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
  await act(async () => fireEvent.click(within(quick).getByRole('button', { name: '신청 기간' })))
  // 보낸 뒤에는 칩이 사용자 말 아래로 따라오지 않고 사라집니다. 막대의 작업 칩은 그대로 두고 누를 수 없게만 해 높이가 바뀌지 않습니다.
  expect(screen.queryByRole('group', { name: '이 공고에 바로 묻기' })).toBeNull()
  const tools = () => Array.from(screen.getByRole('group', { name: '이 공고로 작업하기' }).querySelectorAll('button'))
  expect(tools().every((button) => button.disabled)).toBe(true)
  await act(async () => answer(evidenceAnswer))
  expect(tools().every((button) => !button.disabled)).toBe(true)
  // 답 뒤에는 아직 묻지 않은 기본 질문만 이어 묻기 칩으로 남고, 앞선 칩은 다시 나오지 않습니다.
  const followUp = screen.getByRole('group', { name: '이어서 묻기' })
  expect(Array.from(followUp.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['지원 대상', '신청 방법', '문의처'])
  expect(screen.queryByRole('group', { name: '이 공고에 바로 묻기' })).toBeNull()
  // 직접 쓴 질문과 같은 Gov 경로로, 고른 공고와 함께 보냅니다.
  expect(gov).toHaveBeenLastCalledWith(expect.objectContaining({
    conversation: expect.objectContaining({ message: '신청 기간은 언제까지인가요?' }),
    selectedProgram: { sourceCode: program.sourceCode, sourceProgramId: program.id },
  }), expect.any(AbortSignal))
  expect(screen.getByText('신청 기간은 언제까지인가요?')).toBeTruthy()
  expect(screen.getByText('10월 31일 18시까지 신청할 수 있습니다.')).toBeTruthy()
  // 근거 원문은 접혀 있다가 펼치면 Core가 붙인 공고명·원문 주소 머리와 빈 줄 없이 보입니다.
  const toggle = screen.getByRole('button', { name: '근거 원문 1건 보기' })
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.hidden).toBe(true)
  fireEvent.click(toggle)
  const list = document.getElementById(toggle.getAttribute('aria-controls')!)
  expect(list?.hidden).toBe(false)
  expect(list?.querySelector('blockquote')?.textContent).toBe('신청기간\n2026.10.01 ~ 2026.10.31 18:00')
  expect(screen.queryByRole('button', { name: '전체 보기' })).toBeNull()
  // 해제하면 막대와 이어 묻기 칩이 사라지고 공고 선택 안내로 돌아갑니다.
  fireEvent.click(screen.getByRole('button', { name: '선택 해제' }))
  expect(screen.queryByRole('group', { name: '이어서 묻기' })).toBeNull()
  expect(screen.getByText(/‘이 공고 선택’을 누르면/)).toBeTruthy()
})

it('관리자는 선택 공고 막대의 작업 칩으로 신청 문서·중복 검토를 경로 선택 없이 바로 시작한다', async () => {
  const gov = vi.spyOn(supportProgramClient, 'sendGovAgentMessage').mockResolvedValue({ outcome: 'SEARCH',
    interpretation: readyConversationProposal({ ...emptyConversationContext, query: 'AI 창업' }) })
  vi.spyOn(appContainer.resolve('searchSupportProgramsUseCase'), 'execute')
    .mockResolvedValue(completeSearchResult({ query: 'AI 창업', programs: [supportPrograms[0]] }))
  setup('ADMIN')
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  fireEvent.change(input, { target: { value: 'AI 창업지원 찾아줘' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
  expect(screen.queryByRole('group', { name: '이 공고로 작업하기' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '이 공고 선택' }))
  const tools = screen.getByRole('group', { name: '이 공고로 작업하기' })
  expect(Array.from(tools.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['신청서 쓰기', '중복 검토'])
  // 입력칸에 글을 쓰는 동안에는 두지 않습니다.
  fireEvent.change(input, { target: { value: '메모' } })
  expect(screen.queryByRole('group', { name: '이 공고로 작업하기' })).toBeNull()
  fireEvent.change(input, { target: { value: '' } })
  const calls = gov.mock.calls.length
  await act(async () => fireEvent.click(within(screen.getByRole('group', { name: '이 공고로 작업하기' })).getByRole('button', { name: '중복 검토' })))
  // Core 경로 선택을 부르지 않고 말풍선과 중복 검토 카드를 바로 만듭니다.
  expect(gov.mock.calls.length).toBe(calls)
  expect(screen.getByText('이 공고 중복 검토')).toBeTruthy()
  expect(screen.getByRole('region', { name: '대화 중복 검토' })).toBeTruthy()
  // 작업 카드가 생기면 공고를 고를 때 둔 기본 질문 칩은 사라집니다.
  expect(screen.queryByRole('group', { name: '이 공고에 바로 묻기' })).toBeNull()
})

it('오늘 원문 질문을 다 쓴 관리자에게는 기본 질문 칩을 두지 않고 작업 칩만 둔다', async () => {
  planUsageState.usage = { plan: 'FREE', items: [{ feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 5, used: 5, resetsAt: '2026-10-13T00:00:00+09:00' }] }
  vi.spyOn(supportProgramClient, 'sendGovAgentMessage').mockResolvedValue({ outcome: 'SEARCH',
    interpretation: readyConversationProposal({ ...emptyConversationContext, query: 'AI 창업' }) })
  vi.spyOn(appContainer.resolve('searchSupportProgramsUseCase'), 'execute')
    .mockResolvedValue(completeSearchResult({ query: 'AI 창업', programs: [supportPrograms[0]] }))
  setup('ADMIN')
  fireEvent.change(screen.getByRole('textbox', { name: '지원사업 검색어' }), { target: { value: 'AI 창업지원 찾아줘' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
  fireEvent.click(screen.getByRole('button', { name: '이 공고 선택' }))
  expect(screen.queryByRole('group', { name: '이 공고에 바로 묻기' })).toBeNull()
  expect(screen.getByRole('group', { name: '이 공고로 작업하기' })).toBeTruthy()
})

it('일반 회원은 AI 대화 검색 이름을 유지한다', () => {
  setup('USER')
  expect(screen.getByRole('tab', { name: 'AI 대화 검색' })).toBeTruthy()
  expect(screen.queryByRole('tab', { name: 'Gov 에이전트' })).toBeNull()
  expect(screen.queryByText(/선택한 공고:/)).toBeNull()
  expect(document.title).toBe('AI 대화 검색 · GovBiz')
})

it('관리자는 대화에서 검토 건을 저장·복원하고 파트너 조회로 전환하면 이전 검토를 링크로 남긴다', async () => {
  const recommend = vi.spyOn(appContainer.resolve('recommendPartnerRecruitmentsUseCase'), 'execute').mockResolvedValue(recommendations())
  const gov = vi.spyOn(supportProgramClient, 'sendGovAgentMessage').mockResolvedValue({
    outcome: 'COMBINATION_REVIEW', program: null, message: '비교할 공고를 선택하세요.',
  })
  const store = setup('ADMIN')
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  fireEvent.change(input, { target: { value: '중복 지원 검토해줘' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  expect(screen.getByRole('region', { name: '대화 중복 검토' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '검토 저장' }))
  expect(screen.getByText('저장된 검토 12')).toBeTruthy()
  const snapshot = createChatConversationSnapshot(store.getState().chat)
  act(() => store.dispatch(conversationHistoryOpened({ accountEmail: 'test@govbiz.local', snapshot })))
  expect(screen.getByText('저장된 검토 12')).toBeTruthy()
  expect(gov).toHaveBeenCalledOnce()
  gov.mockResolvedValue({ outcome: 'PARTNERS', message: '말씀하신 조건으로 모집글을 찾아봤어요.',
    partnerConditions: { seekingRoles: ['PARTICIPANT'], regions: ['서울'], keywords: ['AI'], program: null } })
  fireEvent.change(input, { target: { value: '파트너 모집글 찾아줘' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  expect(screen.queryByRole('region', { name: '대화 중복 검토' })).toBeNull()
  expect(screen.getByRole('link', { name: '중복 검토 화면에서 이어서 보기' }).getAttribute('href')).toBe('/app/combination-reviews/12')
  // 파트너 조회는 대화에서 읽은 조건과 회사 정보로 고른 모집글 세 개를 이유와 함께 보여 주고, 더 보기는 같은 조건으로 파트너 관리에 넘깁니다.
  const conditions = { seekingRoles: ['PARTICIPANT'], regions: ['서울'], keywords: ['AI'], program: null }
  expect(recommend).toHaveBeenCalledWith(conditions, 3, expect.any(AbortSignal))
  const partners = screen.getByRole('region', { name: '파트너 모집글 · 우리 회사에 맞는 순' })
  // 대화 검색 결과처럼 메시지 폭을 다 쓰고, 모집글은 파트너 관리 목록과 같은 카드로 보여 줍니다.
  expect(within(partners).getByRole('heading', { name: '파트너 모집글 맞춤 4건' })).toBeTruthy()
  expect(within(partners).getAllByRole('article')).toHaveLength(3)
  expect(within(partners).getByText(/기준: 역할 참여기관 · 역량 2개 · 관심 공고 1건/)).toBeTruthy()
  const chips = within(partners).getByRole('group', { name: '대화에서 읽은 조건' })
  expect(within(chips).getByText('참여기관')).toBeTruthy()
  expect(within(chips).getByText('서울·전국')).toBeTruthy()
  expect(within(chips).getByText('AI (순서만)')).toBeTruthy()
  const items = within(partners).getAllByRole('listitem')
  expect(items).toHaveLength(3)
  expect(within(items[0]!).getByText('관심 공고 「서울 AI 스타트업 실증 지원…」')).toBeTruthy()
  expect(within(items[0]!).getByText('필요 역량 2개 일치')).toBeTruthy()
  expect(within(items[1]!).getByText('희망 지역 부산 · 우리 서울')).toBeTruthy()
  expect(within(items[0]!).getByRole('link').getAttribute('href')).toBe(`/app/partners/detail?recruitmentId=${partnerRecruitmentSummaries[0]!.id}`)
  expect(within(partners).getByRole('link', { name: '같은 조건으로 파트너 관리에서 보기' }).getAttribute('href'))
    .toBe(`/app/partners?${new URLSearchParams([['seekingRole', 'PARTICIPANT'], ['region', '서울'], ['keyword', 'AI']])}`)
  expect(within(partners).getByRole('link', { name: '이 공고로 모집글 쓰기' }).getAttribute('href'))
    .toBe(`/app/partners/new?${new URLSearchParams({ sourceCode: 'BIZINFO', sourceProgramId: 'FREE-1' })}`)
  // 칩을 빼면 AI 없이 다시 조회합니다.
  await act(async () => fireEvent.click(within(chips).getByRole('button', { name: '서울·전국 조건 빼기' })))
  expect(recommend).toHaveBeenLastCalledWith({ ...conditions, regions: [] }, 3, expect.any(AbortSignal))
  expect(gov).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBe(input)
})

it('관리자의 파트너 카드는 맞는 글이 없으면 조건 하나를 뺐을 때의 건수를 보여 주고, 설정을 채우라고 알린다', async () => {
  const empty = { ...recommendations(), items: [], total: 0, relax: [{ type: 'ROLE' as const, count: 0 }, { type: 'REGION' as const, count: 1 }], suggestedProgram: null,
    basis: { hasCompany: true, profileSet: false, roles: [], capabilityCount: 0, myProgramCount: 0, region: '서울' } }
  const recommend = vi.spyOn(appContainer.resolve('recommendPartnerRecruitmentsUseCase'), 'execute')
    .mockResolvedValueOnce(empty).mockResolvedValue(recommendations())
  vi.spyOn(supportProgramClient, 'sendGovAgentMessage').mockResolvedValue({ outcome: 'PARTNERS', message: '말씀하신 조건으로 모집글을 찾아봤어요.',
    partnerConditions: { seekingRoles: ['DEMAND'], regions: ['부산'], keywords: [], program: null } })
  setup('ADMIN')
  fireEvent.change(screen.getByRole('textbox', { name: '지원사업 검색어' }), { target: { value: '부산 수요처 찾는 모집글' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '검색 전송' })))
  const partners = screen.getByRole('region', { name: '파트너 모집글 · 우리 회사에 맞는 순' })
  expect(within(partners).getByText('조건에 맞는 열린 모집글이 없어요.')).toBeTruthy()
  expect(within(partners).getByRole('link', { name: '협업·파트너 설정' }).getAttribute('href')).toBe('/app/profile')
  // 빼도 0건인 조건(찾는 역할)은 버튼을 두지 않습니다.
  expect(within(partners).queryByRole('button', { name: /찾는 역할 빼고 보기/ })).toBeNull()
  await act(async () => fireEvent.click(within(partners).getByRole('button', { name: '지역 빼고 보기 (1건)' })))
  expect(recommend).toHaveBeenLastCalledWith({ seekingRoles: ['DEMAND'], regions: [], keywords: [], program: null }, 3, expect.any(AbortSignal))
  expect(within(partners).getAllByRole('listitem')).toHaveLength(3)
})

it('일반 회원에게 저장된 Gov 카드가 있어도 실행 패널을 열지 않는다', () => {
  const gov = vi.spyOn(supportProgramClient, 'sendGovAgentMessage')
  const store = setup('USER')
  const snapshot = createChatConversationSnapshot(store.getState().chat)
  snapshot.messages = [...snapshot.messages,
    { id: 'review', role: 'assistant', text: '중복 검토', govReview: { program: null, message: '중복 검토', reviewId: 12 } },
    { id: 'partners', role: 'assistant', text: '파트너 조회', govPartners: { message: '모집글' } },
  ]
  act(() => store.dispatch(conversationHistoryOpened({ accountEmail: 'test@govbiz.local', snapshot })))
  expect(screen.queryByRole('region', { name: '대화 중복 검토' })).toBeNull()
  expect(screen.queryByRole('region', { name: '파트너 모집글 · 우리 회사에 맞는 순' })).toBeNull()
  expect(gov).not.toHaveBeenCalled()
})

it('관리자의 중복 검토 카드는 끝난 실행의 질문별 판정과 결론 한 줄을 대화에 바로 보여 주고, 결과는 검토 결과 화면으로 연다', async () => {
  const useCase = appContainer.resolve('combinationReviewUseCase')
  vi.spyOn(useCase, 'runs').mockResolvedValue({ items: [{ id: answerRunFixture.id, inputRevision: answerRunFixture.inputRevision,
    status: 'SUCCEEDED', failureCode: null, startedAt: answerRunFixture.startedAt, finishedAt: answerRunFixture.finishedAt }], nextBeforeId: null })
  const run = vi.spyOn(useCase, 'run').mockResolvedValue(answerRunFixture)
  const store = setup('ADMIN')
  const snapshot = createChatConversationSnapshot(store.getState().chat)
  // 다른 대화를 연 것처럼 첫 메시지(환영 인사) ID를 바꿉니다.
  snapshot.messages = [{ ...snapshot.messages[0]!, id: 'saved-welcome' }, ...snapshot.messages.slice(1),
    { id: 'review', role: 'assistant', text: '중복 검토', govReview: { program: null, message: '중복 검토', reviewId: 12 } }]
  await act(async () => store.dispatch(conversationHistoryOpened({ accountEmail: 'test@govbiz.local', snapshot })))
  const card = screen.getByRole('region', { name: '중복 검토 · 공고 두 개 고르기' })
  expect(within(card).getByText('결과')).toBeTruthy()
  expect(within(card).getByText('같은 과제·비용으로 두 번 받을 수 없어요')).toBeTruthy()
  expect(run).toHaveBeenCalledWith(12, answerRunFixture.id, expect.any(AbortSignal))
  // 지난 기록에서 연 카드는 저절로 펼치지 않습니다. 실행이 있는 검토는 대화에 펼치지 않고 검토 결과 화면으로 옮깁니다.
  expect(screen.queryByRole('region', { name: '대화 중복 검토' })).toBeNull()
  expect(within(card).queryByRole('button', { name: '결과 보기' })).toBeNull()
  expect(within(card).getByRole('link', { name: '결과 보기' }).getAttribute('href')).toBe(`/app/combination-reviews/12/runs/${answerRunFixture.id}`)
})
