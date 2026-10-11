// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { supportProgramDetails, supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'
import { emptyConversationContext } from '../../../../data/fixtures/supportProgramConversation'
import type { ApplicationForm, ApplicationFormAvailability, ApplicationFormDiscoveryJob, ApplicationPreparation, ApplicationPreparationSummary } from '../../../../domain/entities/ApplicationPreparation'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { conversationHistoryOpened, conversationReset, createChatConversationSnapshot, govApplicationPrepared, govMessageSucceeded, govProgramSelected, interpretationStarted, searchStarted, searchSucceeded } from '../state/chatSlice'
import { ChatPage } from './ChatPage'

vi.mock('../hooks/useSupportProgramSearchReadiness', () => ({ useSupportProgramSearchReadiness: () => ({
  canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(), data: { searchState: 'SEARCHABLE' },
}) }))
vi.mock('../viewmodel/useSearchResultInterests', async (importOriginal) => ({
  ...await importOriginal<typeof import('../viewmodel/useSearchResultInterests')>(), useSearchResultInterests: () => null,
}))
vi.mock('../../../shared/plan-usage/usePlanUsage', () => {
  const usage = { usage: null, reload: vi.fn() }
  return { usePlanUsage: () => usage }
})

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const account = { email: 'admin@govbiz.local', role: 'ADMIN' as const, tier: 'ADMIN' as const,
  emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const program = { sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id, title: supportPrograms[0].title }
const form: ApplicationForm = {
  ...program, programTitle: program.title, formVersionId: 'stored-form-v1', formTitle: '사업계획서',
  sourceUrl: supportPrograms[0].sourceUrl, attachmentFileName: '사업계획서.hwpx', attachmentSha256: 'a'.repeat(64),
  verificationStatus: 'SOURCE_DOCUMENT_EXTRACTED', institutionReviewed: false,
  supportedServiceFields: ['GENERAL'], sections: [],
}
const created: ApplicationPreparation = { id: 12, inputRevision: 0, progressStage: 'PREPARING', progressRevision: 0,
  progressStageUpdatedAt: '2026-10-10T01:00:00+09:00', serviceField: 'GENERAL',
  createdAt: '2026-10-10T01:00:00+09:00', updatedAt: '2026-10-10T01:00:00+09:00', form, contents: [] }
const newPath = `/app/application-preparations/new?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`

function availability(items: ApplicationForm[]): ApplicationFormAvailability {
  return { state: { ...program, status: items.length ? 'AVAILABLE' : 'PENDING',
    reasonCode: items.length ? 'FORM_FOUND' : 'NOT_ANALYZED', nextRetryAt: null, attemptCount: 0, warnings: [] }, forms: { items } }
}

function job(status: ApplicationFormDiscoveryJob['status']): ApplicationFormDiscoveryJob {
  return { id: 17, ...program, programTitle: program.title, programSourceUrl: form.sourceUrl, status,
    createdAt: new Date().toISOString(), failureCode: null,
    result: status === 'SUCCEEDED' ? { items: [form], warnings: [], cached: false } : null }
}

function mockPreparation(items: ApplicationForm[] = [form]) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const detail = vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0])
  const lookup = vi.spyOn(useCase, 'availability').mockResolvedValue(availability(items))
  const jobs = vi.spyOn(useCase, 'discoveryJobs').mockResolvedValue([])
  const poll = vi.spyOn(useCase, 'discoveryJob').mockResolvedValue(job('SUCCEEDED'))
  const discover = vi.spyOn(useCase, 'discover').mockResolvedValue(job('SUCCEEDED'))
  const create = vi.spyOn(useCase, 'create').mockResolvedValue(created)
  const get = vi.spyOn(useCase, 'get').mockResolvedValue(created)
  const list = vi.spyOn(useCase, 'list').mockResolvedValue({ items: [], nextBeforeId: null })
  const submit = vi.spyOn(useCase, 'submitDocumentJob')
  vi.spyOn(useCase, 'markDocumentJobsSeen').mockResolvedValue(undefined)
  vi.spyOn(useCase, 'markDiscoveryJobsSeen').mockResolvedValue(undefined)
  return { useCase, detail, lookup, jobs, poll, discover, create, get, list, submit }
}

function addApplication(store: ReturnType<typeof createAppStore>) {
  const started = interpretationStarted({ message: '신청 준비해줘', context: emptyConversationContext })
  store.dispatch(started)
  store.dispatch(govMessageSucceeded({ requestId: started.payload.requestId, message: '양식을 확인하고 신청 준비를 시작해 주세요.',
    application: { program, message: '양식을 확인하고 신청 준비를 시작해 주세요.' } }))
  return `${started.payload.requestId}-answer`
}

function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output> }

/** 대화 안에서는 입력칸 분석까지만 하므로, 분석을 보는 테스트는 카드 버튼으로 분석 화면을 대화 안에 먼저 펼칩니다. */
async function mount(restored = false, preparationId?: number, open = true, withCard = true) {
  const store = createAppStore()
  store.dispatch(signedIn(account))
  const search = searchStarted('사업')
  store.dispatch(search)
  store.dispatch(searchSucceeded({ ...completeSearchResult({ query: '사업', programs: [supportPrograms[0]] }), requestId: search.payload.requestId }))
  store.dispatch(govProgramSelected(program))
  const tree = <Provider store={store}><MemoryRouter initialEntries={['/app/chat']}><Location /><Routes>
    <Route path="/app/chat" element={<ChatPage layout="workspace" />} />
    <Route path="/app/application-preparations/new" element={<p>새 신청 문서 화면</p>} />
    <Route path="/app/application-preparations/:id" element={<p>신청 문서 편집기</p>} />
  </Routes></MemoryRouter></Provider>
  if (!withCard) {
    await act(async () => { render(tree) })
    return store
  }
  const messageId = addApplication(store)
  if (preparationId !== undefined) store.dispatch(govApplicationPrepared({ accountEmail: account.email, messageId, preparationId }))
  if (restored) {
    const snapshot = createChatConversationSnapshot(store.getState().chat)
    store.dispatch(conversationReset())
    store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot }))
  }
  await act(async () => { render(tree) })
  // 시작 전 카드의 버튼은 분석 중이면 [진행 보기], 아니면 [입력칸 분석하기]입니다(카드가 조회 API로 상태를 읽은 뒤).
  if (open) await act(async () => fireEvent.click(screen.getByRole('button', { name: /^(입력칸 분석하기|진행 보기)$/ })))
  return store
}

it('starts input analysis right away when the 신청서 쓰기 chip opens a program without a stored form, and the card follows it', async () => {
  vi.useFakeTimers()
  const api = mockPreparation([])
  api.discover.mockResolvedValue(job('QUEUED'))
  api.poll.mockResolvedValue(job('RUNNING'))
  await mount(false, undefined, false, false)
  await act(async () => fireEvent.click(within(screen.getByRole('group', { name: '이 공고로 작업하기' })).getByRole('button', { name: '신청서 쓰기' })))
  expect(screen.getByText('저장된 신청 양식을 확인하고, 없으면 입력칸 분석을 바로 시작할게요. 분석은 보통 1~2분 걸려요.')).toBeTruthy()
  const panel = screen.getByRole('region', { name: '신청 문서' })
  expect(api.discover).toHaveBeenCalledOnce()
  expect(within(panel).getByRole('status', { name: '양식 분석 진행' })).toBeTruthy()
  // 접어도 분석은 이어지고, 카드는 조회 API로 분석 중임을 보여 줍니다.
  api.jobs.mockResolvedValue([job('RUNNING')])
  await act(async () => fireEvent.click(within(panel).getByRole('button', { name: '접기' })))
  const card = screen.getByRole('region', { name: `신청 문서 · ${program.title}` })
  expect(card.textContent).toContain('입력칸 분석 중')
  await act(async () => fireEvent.click(within(card).getByRole('button', { name: '진행 보기' })))
  expect(screen.getByRole('status', { name: '양식 분석 진행' })).toBeTruthy()
  // 다시 열어도 새 분석을 걸지 않고 진행 중인 작업을 이어 봅니다.
  expect(api.discover).toHaveBeenCalledOnce()
})

it('does not analyze from the chip when the program already has a stored form and hands writing to the application page', async () => {
  const api = mockPreparation([form])
  await mount(false, undefined, false, false)
  await act(async () => fireEvent.click(within(screen.getByRole('group', { name: '이 공고로 작업하기' })).getByRole('button', { name: '신청서 쓰기' })))
  const panel = screen.getByRole('region', { name: '신청 문서' })
  const result = within(panel).getByRole('status', { name: '입력칸 분석 결과' })
  expect(within(result).getByRole('heading', { name: '양식 1개를 찾았어요' })).toBeTruthy()
  expect(result.textContent).toContain('사업계획서')
  // 양식 고르기 · 작성 시작은 대화에서 하지 않고 신청 문서 화면으로 넘깁니다.
  expect(within(panel).queryByRole('button', { name: '작성 시작' })).toBeNull()
  expect(within(panel).queryByRole('radio')).toBeNull()
  await act(async () => fireEvent.click(within(result).getByRole('link', { name: '신청 문서 화면에서 작성하기 →' })))
  expect(screen.getByTestId('location').textContent).toBe(newPath)
  expect(api.discover).not.toHaveBeenCalled()
  expect(api.create).not.toHaveBeenCalled()
})

it('routes a card whose forms are ready to the application page without expanding it in the chat', async () => {
  const api = mockPreparation([form])
  await mount(false, undefined, false)
  const card = screen.getByRole('region', { name: `신청 문서 · ${program.title}` })
  // 아직 쓰기 전 카드는 저장된 양식 조회 결과를 보여 줍니다(AI 호출 없음).
  expect(card.textContent).toContain('양식 1개')
  expect(api.lookup).toHaveBeenCalledOnce()
  expect(api.discover).not.toHaveBeenCalled()
  const link = within(card).getByRole('link', { name: '신청 문서 화면에서 작성하기' })
  expect(link.getAttribute('href')).toBe(newPath)
  await act(async () => fireEvent.click(link))
  expect(screen.getByText('새 신청 문서 화면')).toBeTruthy()
  expect(api.create).not.toHaveBeenCalled()
})

it('routes a started preparation to its editor page instead of opening the editor in the chat', async () => {
  const api = mockPreparation()
  const summary: ApplicationPreparationSummary = { id: 12, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 0,
    progressStageUpdatedAt: created.updatedAt, sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId,
    serviceField: 'GENERAL', programTitle: program.title, formTitle: form.formTitle, updatedAt: created.updatedAt,
    answeredRequired: 1, requiredTotal: 3, hasCurrentDocument: false }
  api.list.mockResolvedValue({ items: [summary], nextBeforeId: null })
  await mount(true, 12, false)
  const card = screen.getByRole('region', { name: `신청 문서 · ${program.title}` })
  expect(card.textContent).toContain('필수 답변 1/3')
  const link = within(card).getByRole('link', { name: '이어서 쓰기' })
  expect(link.getAttribute('href')).toBe('/app/application-preparations/12')
  expect(api.get).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(link))
  expect(screen.getByText('신청 문서 편집기')).toBeTruthy()
  expect(api.create).not.toHaveBeenCalled()
  expect(api.submit).not.toHaveBeenCalled()
})

it('expands the analysis in place of the card, collapses back, and expands a new card added to the conversation', async () => {
  const api = mockPreparation([])
  const store = await mount(false, undefined, false)
  const card = screen.getByRole('region', { name: `신청 문서 · ${program.title}` })
  expect(card.textContent).toContain('분석 전')
  const message = card.closest('article')!
  await act(async () => fireEvent.click(within(card).getByRole('button', { name: '입력칸 분석하기' })))
  // 옆 패널이 아니라 대화 안 그 메시지 자리에서 카드 대신 펼칩니다. 유료 분석은 버튼을 눌러야 시작합니다.
  const expanded = screen.getByRole('region', { name: '신청 문서' })
  expect(expanded.closest('article')).toBe(message)
  expect(screen.queryByRole('complementary')).toBeNull()
  expect(document.activeElement).toBe(within(expanded).getByRole('button', { name: '접기' }))
  expect(within(expanded).getByRole('button', { name: '입력칸별로 분석' })).toBeTruthy()
  expect(api.discover).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(within(expanded).getByRole('button', { name: '접기' })))
  expect(screen.queryByRole('region', { name: '신청 문서' })).toBeNull()
  expect(screen.getByRole('region', { name: `신청 문서 · ${program.title}` })).toBeTruthy()
  // 새 작업 카드가 생기면 그 카드가 바로 펼쳐지고, 지난 카드는 신청 준비 화면 링크만 남습니다.
  await act(async () => addApplication(store))
  expect(screen.getByRole('region', { name: '신청 문서' })).toBeTruthy()
  expect(within(screen.getByRole('region', { name: `신청 문서 · ${program.title}` })).getByRole('link', { name: '신청 준비 화면에서 이어서 보기' })
    .getAttribute('href')).toBe(newPath)
})

it('keeps the card collapsed when a saved conversation is opened and expands a new card added to that conversation', async () => {
  mockPreparation([])
  const store = await mount(false, undefined, false)
  const snapshot = createChatConversationSnapshot(store.getState().chat)
  await act(async () => { store.dispatch(conversationReset()); store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot })) })
  expect(screen.getByRole('button', { name: '입력칸 분석하기' })).toBeTruthy()
  expect(screen.queryByRole('region', { name: '신청 문서' })).toBeNull()
  await act(async () => addApplication(store))
  expect(screen.getByRole('region', { name: '신청 문서' })).toBeTruthy()
})

it('retries stored-form lookup and starts paid analysis only on a click, then hands the found forms to the application page', async () => {
  vi.useFakeTimers()
  const api = mockPreparation([])
  await mount(false, undefined, false)
  // 카드가 상태를 읽은 뒤 펼친 분석 화면의 조회만 실패하게 합니다.
  api.lookup.mockRejectedValueOnce(new Error('양식 조회 실패'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '입력칸 분석하기' })))
  expect(screen.getByText('양식 조회 실패')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '다시 시도' })))
  expect(api.discover).not.toHaveBeenCalled()
  api.discover.mockRejectedValueOnce(new Error('분석 요청 실패')).mockResolvedValue(job('QUEUED'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '입력칸별로 분석' })))
  expect(screen.getByText('분석 요청 실패')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '입력칸별로 분석' })))
  expect(screen.getByRole('status', { name: '양식 분석 진행' })).toBeTruthy()
  expect(api.discover).toHaveBeenLastCalledWith(program.sourceCode, program.sourceProgramId, expect.any(AbortSignal), expect.any(String))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(api.poll).toHaveBeenCalledOnce()
  // 분석이 끝나면 대화에서 양식을 고르지 않고 신청 문서 화면으로 넘깁니다.
  expect(screen.getByRole('heading', { name: '양식 1개를 찾았어요' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '신청 문서 화면에서 작성하기 →' }).getAttribute('href')).toBe(newPath)
  expect(screen.queryByRole('heading', { name: '작성할 양식' })).toBeNull()
  expect(api.create).not.toHaveBeenCalled()
})

it.each(['selection', 'reset', 'account'] as const)('keeps one live analysis card and aborts late polling on %s change', async (change) => {
  vi.useFakeTimers()
  const api = mockPreparation([])
  api.jobs.mockResolvedValue([job('RUNNING')])
  let finish!: (value: ApplicationFormDiscoveryJob) => void
  api.poll.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  const store = await mount()
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  const oldSignal = api.poll.mock.calls[0][1]!
  await act(async () => addApplication(store))
  expect(oldSignal.aborted).toBe(true)
  expect(screen.getAllByRole('status', { name: '양식 분석 진행' })).toHaveLength(1)
  expect(screen.getAllByRole('link', { name: '신청 준비 화면에서 이어서 보기' })).toHaveLength(1)
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(api.poll).toHaveBeenCalledTimes(2)
  const signal = api.poll.mock.calls[1][1]!
  act(() => {
    if (change === 'selection') store.dispatch(govProgramSelected(null))
    else if (change === 'reset') store.dispatch(conversationReset())
    else store.dispatch(signedIn({ ...account, email: 'other@govbiz.local' }))
  })
  expect(signal.aborted).toBe(true)
  await act(async () => { finish(job('SUCCEEDED')); await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.queryByRole('status', { name: '양식 분석 진행' })).toBeNull()
  expect(screen.queryByRole('heading', { name: '양식 1개를 찾았어요' })).toBeNull()
  expect(api.poll).toHaveBeenCalledTimes(2)
  expect(api.discover).not.toHaveBeenCalled()
})

it('keeps the Google Form pathway and its retry without offering paid attachment analysis', async () => {
  const api = mockPreparation([])
  const formUrl = 'https://docs.google.com/forms/d/e/example/viewform'
  api.detail.mockResolvedValue({ ...supportProgramDetails[0], applicationRoute: { type: 'GOOGLE_FORMS', method: '온라인 신청', url: formUrl } })
  vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
  const google = vi.spyOn(api.useCase, 'googleForm').mockRejectedValue(new Error('설문을 불러오지 못했어요.'))
  await mount()
  expect(screen.getByRole('heading', { name: '구글 설문으로 신청하는 공고예요' })).toBeTruthy()
  expect(screen.getByRole('link', { name: /구글 설문 열기/ }).getAttribute('href')).toBe(formUrl)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '문항 다시 불러오기' })))
  expect(google).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: '입력칸별로 분석' })).toBeNull()
  expect(api.discover).not.toHaveBeenCalled()
  expect(api.create).not.toHaveBeenCalled()
})
