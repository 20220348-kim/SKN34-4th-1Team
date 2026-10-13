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
import type { ApplicationDocumentGenerationJob, ApplicationForm, ApplicationFormAvailability, ApplicationFormDiscoveryJob, ApplicationPreparation, ApplicationPreparationSummary } from '../../../../domain/entities/ApplicationPreparation'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { conversationHistoryOpened, conversationReset, createChatConversationSnapshot, govMessageSucceeded, govProgramSelected, interpretationStarted, searchStarted, searchSucceeded } from '../state/chatSlice'
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

function addApplication(store: ReturnType<typeof createAppStore>, preparationId?: number) {
  const started = interpretationStarted({ message: '신청 준비해줘', context: emptyConversationContext })
  store.dispatch(started)
  store.dispatch(govMessageSucceeded({ requestId: started.payload.requestId, message: '양식을 확인하고 신청 준비를 시작해 주세요.',
    application: { program, message: '양식을 확인하고 신청 준비를 시작해 주세요.', ...(preparationId === undefined ? {} : { preparationId }) } }))
  return `${started.payload.requestId}-answer`
}

function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output> }

/** 대화에는 작업 카드만 두고 일은 화면(시트)으로 옮기므로, 여기서는 대화와 옮겨 갈 화면 자리만 둡니다. */
async function mount(restored = false, preparationId?: number, withCard = true) {
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
    <Route path="/app/application-preparations/:id/documents" element={<p>신청 문서 초안</p>} />
  </Routes></MemoryRouter></Provider>
  if (withCard) addApplication(store, preparationId)
  if (restored) {
    const snapshot = createChatConversationSnapshot(store.getState().chat)
    store.dispatch(conversationReset())
    store.dispatch(conversationHistoryOpened({ accountEmail: account.email, snapshot }))
  }
  await act(async () => { render(tree) })
  return store
}

const card = () => screen.getAllByRole('region', { name: `신청 문서 · ${program.title}` }).at(-1)!
/** 카드 단계 띠에서 지금 단계(aria-current)의 이름입니다. */
const currentStep = (region: HTMLElement) => within(region).getByRole('list', { name: '신청 문서 단계' }).querySelector('[aria-current="step"]')?.textContent

function summary(overrides: Partial<ApplicationPreparationSummary> = {}): ApplicationPreparationSummary {
  return { id: 12, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 0, progressStageUpdatedAt: created.updatedAt,
    sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId, serviceField: 'GENERAL', programTitle: program.title,
    formTitle: form.formTitle, updatedAt: created.updatedAt, answeredRequired: 1, requiredTotal: 3, hasCurrentDocument: false, ...overrides }
}

function documentJob(status: ApplicationDocumentGenerationJob['status'], stage: ApplicationDocumentGenerationJob['stage'] = null): ApplicationDocumentGenerationJob {
  return { id: 41, preparationId: 12, expectedRevision: 1, status, stage, fileIds: [], failureCode: null, failureMessage: null,
    mappingMigration: null, createdAt: created.updatedAt, finishedAt: null }
}

it('the 신청 문서 쓰기 chip adds the card and opens the application page, which starts input analysis when no form is stored', async () => {
  const api = mockPreparation([])
  const store = await mount(false, undefined, false)
  await act(async () => fireEvent.click(within(screen.getByRole('group', { name: '이 공고로 작업하기' })).getByRole('button', { name: '신청 문서 쓰기' })))
  // 직접 누른 칩이라 신청 문서 화면을 바로 엽니다(대화에서는 시트로 뜸). 자동 분석 판단은 그 화면이 한 번 합니다.
  expect(screen.getByTestId('location').textContent).toBe(`${newPath}&analyze=1`)
  expect(store.getState().chat.messages.at(-1)?.govApplication?.program).toEqual(program)
  expect(api.discover).not.toHaveBeenCalled()
})

it('shows step 1 for a program without a stored form and opens the application page to analyze it', async () => {
  const api = mockPreparation([])
  await mount()
  expect(card().textContent).toContain('분석 전')
  expect(currentStep(card())).toContain('양식 확인')
  expect(within(card()).getByRole('link', { name: '입력칸 분석하기' }).getAttribute('href')).toBe(newPath)
  // 유료 분석은 대화가 아니라 화면에서 설명을 보고 시작합니다.
  expect(api.discover).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: '신청 문서' })).toBeNull()
})

it('moves a card whose forms are ready to step 2 and opens the application page to write answers', async () => {
  const api = mockPreparation([form])
  await mount()
  expect(card().textContent).toContain('양식 1개')
  expect(currentStep(card())).toContain('답변 작성')
  const link = within(card()).getByRole('link', { name: '답변 쓰기 시작' })
  expect(link.getAttribute('href')).toBe(newPath)
  await act(async () => fireEvent.click(link))
  expect(screen.getByText('새 신청 문서 화면')).toBeTruthy()
  expect(api.create).not.toHaveBeenCalled()
})

it('follows a running input analysis on the card until the forms are found, then stops checking', async () => {
  vi.useFakeTimers()
  const api = mockPreparation([])
  api.jobs.mockResolvedValue([job('RUNNING')])
  await mount()
  expect(card().textContent).toContain('입력칸 분석 중')
  // 맞지 않을 수 있는 예상 시간 대신 지난 시간을 보여 줍니다.
  expect(card().textContent).toMatch(/\d+초 지남 · 나가도 계속돼요/)
  expect(card().textContent).not.toContain('보통')
  expect(currentStep(card())).toContain('진행 중')
  expect(within(card()).getByRole('link', { name: '진행 보기' }).getAttribute('href')).toBe(newPath)
  api.jobs.mockResolvedValue([])
  api.lookup.mockResolvedValue(availability([form]))
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(card().textContent).toContain('양식 1개')
  expect(currentStep(card())).toContain('답변 작성')
  const calls = api.lookup.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(15000))
  expect(api.lookup).toHaveBeenCalledTimes(calls)
  expect(api.discover).not.toHaveBeenCalled()
})

it('routes a started preparation to its editor page from the card and the chip', async () => {
  const api = mockPreparation()
  api.list.mockResolvedValue({ items: [summary()], nextBeforeId: null })
  await mount(true, 12)
  expect(card().textContent).toContain('필수 답변 1/3')
  expect(currentStep(card())).toContain('답변 작성')
  // 이 공고로 쓰는 신청 문서가 있으면 [신청 문서 쓰기] 칩 대신 그 화면을 여는 [이어서 쓰기 · n/m]을 둡니다.
  expect(within(screen.getByRole('group', { name: '이 공고로 작업하기' })).getByRole('link', { name: '이어서 쓰기 · 1/3' })
    .getAttribute('href')).toBe('/app/application-preparations/12')
  const link = within(card()).getByRole('link', { name: '이어서 쓰기' })
  expect(link.getAttribute('href')).toBe('/app/application-preparations/12')
  await act(async () => fireEvent.click(link))
  expect(screen.getByText('신청 문서 편집기')).toBeTruthy()
  expect(api.create).not.toHaveBeenCalled()
  expect(api.submit).not.toHaveBeenCalled()
})

it('shows a draft being generated as step 3 in progress and turns the card done when the draft is ready', async () => {
  vi.useFakeTimers()
  const api = mockPreparation()
  api.list.mockResolvedValue({ items: [summary()], nextBeforeId: null })
  const jobs = vi.spyOn(api.useCase, 'documentJobs').mockResolvedValue([documentJob('RUNNING', 'WRITING')])
  await mount()
  expect(card().textContent).toContain('초안 만드는 중')
  expect(card().textContent).toContain('답변을 쓰는 중')
  expect(currentStep(card())).toContain('초안')
  expect(within(card()).getByRole('link', { name: '진행 보기' }).getAttribute('href')).toBe('/app/application-preparations/12/documents')
  jobs.mockResolvedValue([{ ...documentJob('SUCCEEDED'), finishedAt: created.updatedAt }])
  api.list.mockResolvedValue({ items: [summary({ answeredRequired: 3, hasCurrentDocument: true })], nextBeforeId: null })
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(card().textContent).toContain('초안 완료')
  expect(within(card()).getByRole('list', { name: '신청 문서 단계' }).querySelector('[aria-current="step"]')).toBeNull()
  expect(within(card()).getByRole('button', { name: '초안 받기' })).toBeTruthy()
})

it('shows a draft finished on the application page as done on every card and downloads it from the latest card', async () => {
  const api = mockPreparation([form])
  const summary: ApplicationPreparationSummary = { id: 12, inputRevision: 2, progressStage: 'PREPARING', progressRevision: 0,
    progressStageUpdatedAt: created.updatedAt, sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId,
    serviceField: 'GENERAL', programTitle: program.title, formTitle: form.formTitle, updatedAt: created.updatedAt,
    answeredRequired: 3, requiredTotal: 3, hasCurrentDocument: true }
  // 대화 카드는 신청 준비 번호를 모릅니다(신청 문서 화면에서 만듦). 공고로 내 신청 준비를 찾습니다.
  api.list.mockResolvedValue({ items: [summary], nextBeforeId: null })
  const draft = { id: 31, inputRevision: 2, fileName: '사업계획서_초안.hwpx', mediaType: 'application/hwp+zip', size: 10,
    filledAnswerCount: 3, unfilledAnswerCount: 0, unfilledAnswers: [] }
  const documents = vi.spyOn(api.useCase, 'documents').mockResolvedValue([{ ...draft, id: 30, inputRevision: 1 }, draft])
  const blob = new Blob(['draft'])
  const download = vi.spyOn(api.useCase, 'downloadDocument').mockResolvedValue(blob)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:draft'), revokeObjectURL: vi.fn() }))
  const store = await mount()
  const card = screen.getByRole('region', { name: `신청 문서 · ${program.title}` })
  expect(card.textContent).toContain('초안 완료')
  expect(card.textContent).toContain('사업계획서 · 필수 답변 3/3')
  expect(within(card).getByRole('link', { name: '초안 보기' }).getAttribute('href')).toBe('/app/application-preparations/12/documents')
  expect(within(screen.getByRole('group', { name: '이 공고로 작업하기' })).getByRole('link', { name: '초안 보기' })
    .getAttribute('href')).toBe('/app/application-preparations/12/documents')
  // 끝난 일에는 입력칸 분석 상태를 읽지 않습니다.
  expect(api.lookup).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(within(card).getByRole('button', { name: '초안 받기' })))
  expect(documents).toHaveBeenCalledWith(12, expect.any(AbortSignal))
  expect(download).toHaveBeenCalledWith(12, 31, expect.any(AbortSignal))
  expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
  // 새 카드가 생겨도 지난 카드는 '시작 전'이 아니라 끝난 상태와 링크를 보여 주고, 끝난 일은 대화 안에 분석을 펼치지 않습니다.
  await act(async () => addApplication(store))
  const cards = screen.getAllByRole('region', { name: `신청 문서 · ${program.title}` })
  expect(cards).toHaveLength(2)
  expect(cards.every((item) => item.textContent?.includes('초안 완료'))).toBe(true)
  expect(screen.getAllByRole('button', { name: '초안 받기' })).toHaveLength(1)
  expect(screen.queryByRole('region', { name: '신청 문서' })).toBeNull()
  expect(api.discover).not.toHaveBeenCalled()
})
