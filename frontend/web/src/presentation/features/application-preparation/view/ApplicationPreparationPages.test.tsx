// @vitest-environment jsdom
import { asValue } from 'awilix/browser'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { ApplicationForm, ApplicationPreparation, ApplicationPreparationPage } from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { ApplicationPreparationUseCase } from '../../../../domain/usecases/ApplicationPreparationUseCase'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { ApplicationPreparationEditorPage, ApplicationPreparationListPage } from './ApplicationPreparationPages'
import { ApplicationDocumentPage } from './ApplicationDocumentPage'
import { chooseOption, optionValues, selectedValue } from '../../../../test/selectField'

const original = appContainer.resolve('applicationPreparationUseCase')
const originalCatalog = appContainer.resolve('browseSupportProgramsUseCase')
const originalSavedPrograms = appContainer.resolve('browseSavedSupportProgramsUseCase')
const originalProgramDetail = appContainer.resolve('getSupportProgramDetailUseCase')
const browsePrograms = vi.fn()
const browseSavedPrograms = vi.fn()
const getProgramDetail = vi.fn()
const firstForm: ApplicationForm = {
  formVersionId: 'verified-form-v1',
  sourceCode: 'BIZINFO',
  sourceProgramId: 'PBLN_1',
  programTitle: '혁신바우처 지원사업',
  formTitle: '혁신바우처 사업계획서',
  sourceUrl: 'https://www.bizinfo.go.kr/form',
  attachmentFileName: '혁신바우처 사업계획서.hwpx',
  attachmentSha256: 'a'.repeat(64),
  verificationStatus: 'SOURCE_HASH_AND_LOCATORS_VERIFIED',
  institutionReviewed: false,
  supportedServiceFields: ['CONSULTING', 'TECHNICAL_SUPPORT', 'MARKETING'],
  sections: [
    {
      key: 'company-overview', title: '기업 개요', locator: 'HWPX 문단 1', description: '기업을 설명합니다.', status: 'NOT_STARTED',
      fields: [{ key: 'company-name', label: '업체명', guidance: '공식 업체명을 입력합니다.', required: true }], facts: [],
    },
    {
      key: 'voucher-plan', title: '바우처 활용 계획', locator: 'HWPX 문단 2', description: '계획을 설명합니다.', status: 'NOT_STARTED',
      fields: [{ key: 'project-title', label: '과제명', guidance: '과제명을 입력합니다.', required: true }], facts: [],
    },
  ],
}
const secondForm: ApplicationForm = {
  ...firstForm,
  formVersionId: 'marketing-form-v2',
  sourceProgramId: 'PBLN_2',
  programTitle: '수출 마케팅 지원사업',
  formTitle: '수출 실행계획서',
  sourceUrl: 'https://www.bizinfo.go.kr/marketing-form',
  supportedServiceFields: ['MARKETING'],
}
const detail = {
  contents: [] as ApplicationPreparation['contents'],
  id: 12,
  inputRevision: 3,
  progressStage: 'PREPARING' as const,
  progressRevision: 1,
  progressStageUpdatedAt: '2026-09-11T01:00:00+09:00',
  serviceField: 'TECHNICAL_SUPPORT' as const,
  createdAt: '2026-09-11T00:00:00+09:00',
  updatedAt: '2026-09-11T01:00:00+09:00',
  form: structuredClone(firstForm),
}
const repository = { documents: vi.fn(), generateDocuments: vi.fn(), downloadDocument: vi.fn(), generateDraft: vi.fn(), saveContent: vi.fn(), confirmContent: vi.fn(), discoveryJobs: vi.fn(), discoveryJob: vi.fn(), availability: vi.fn(), forms: vi.fn(), discover: vi.fn(), list: vi.fn(), delete: vi.fn(), get: vi.fn(), create: vi.fn(), interpret: vi.fn(), replaceInputs: vi.fn(), updateProgress: vi.fn() }

function completedDiscovery(result: { items: ApplicationForm[]; warnings: string[]; cached: boolean }) {
  return { id: 77, sourceCode: result.items[0].sourceCode, sourceProgramId: result.items[0].sourceProgramId,
    programTitle: result.items[0].programTitle, programSourceUrl: result.items[0].sourceUrl,
    status: 'SUCCEEDED' as const, result, failureCode: null, createdAt: detail.createdAt }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const documentFile = { id: 81, inputRevision: 3, fileName: '신청서_초안_v3.hwpx', mediaType: 'application/hwp+zip', size: 400,
  filledAnswerCount: 2, unfilledAnswerCount: 0, unfilledAnswers: [] }

it.each(['APPLICATION_PREPARATION_RUN_CONFLICT'])('waits for the existing document after %s without repeating generation', async (code) => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([documentFile])
  repository.generateDocuments.mockRejectedValueOnce(new ApplicationPreparationError(409, code))
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(screen.getByRole('button', { name: '신청문서 1 다운로드' })).toBeTruthy()
  expect(repository.generateDocuments).toHaveBeenCalledTimes(1)
  expect(repository.documents).toHaveBeenCalledTimes(3)
})

it.each(['REQUEST_TIMEOUT', 'REQUEST_FAILED', 'AI_SERVICE_INVALID_RESPONSE'])('shows %s immediately without polling a potentially failed generation', async (code) => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.generateDocuments.mockRejectedValueOnce(new ApplicationPreparationError(502, code))
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  expect(screen.getByRole('alert')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
  expect(repository.documents).toHaveBeenCalledTimes(1)
  expect(repository.generateDocuments).toHaveBeenCalledTimes(1)
})

it('recovers an existing document after the old two-minute polling limit without another paid request', async () => {
  vi.useFakeTimers()
  const started = Date.now()
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockImplementation(async () => Date.now() - started >= 300_000 ? [documentFile] : [])
  repository.generateDocuments.mockRejectedValueOnce(new ApplicationPreparationError(409, 'APPLICATION_PREPARATION_RUN_CONFLICT'))
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  await act(async () => { await vi.advanceTimersByTimeAsync(123_000) })
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(177_000) })
  expect(screen.getByRole('button', { name: '신청문서 1 다운로드' })).toBeTruthy()
  expect(repository.generateDocuments).toHaveBeenCalledTimes(1)
})

it('bounds polling when an existing document never finishes without automatically posting again', async () => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([])
  repository.generateDocuments.mockRejectedValueOnce(new ApplicationPreparationError(409, 'APPLICATION_PREPARATION_RUN_CONFLICT'))
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  await act(async () => { await vi.advanceTimersByTimeAsync(660_000) })
  expect(screen.getByRole('alert').textContent).toContain('기존 문서 생성 결과를 아직 확인하지 못했습니다')
  const reads = repository.documents.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(repository.documents).toHaveBeenCalledTimes(reads)
  expect(repository.generateDocuments).toHaveBeenCalledTimes(1)
})

it('stops waiting for an existing generation when the results page is closed', async () => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.generateDocuments.mockRejectedValueOnce(new ApplicationPreparationError(409, 'APPLICATION_PREPARATION_RUN_CONFLICT'))
  let rendered!: ReturnType<typeof mount>
  await act(async () => { rendered = mount('/app/application-preparations/12/documents?generate=3') })
  rendered.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
  expect(repository.documents).toHaveBeenCalledTimes(1)
  expect(repository.generateDocuments).toHaveBeenCalledTimes(1)
})

it('moves to a separate results page, generates a native file and returns to saved answers', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  mount('/app/application-preparations/12')
  const button = await screen.findByRole('button', { name: '초안 생성하기' })
  const next = screen.getByRole('button', { name: '다음 항목' })
  expect(next.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(repository.generateDocuments).not.toHaveBeenCalled()
  fireEvent.click(button)
  const downloadButton = await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  const downloadHint = screen.getByText(/문서를 다운로드해 내용을 확인하세요/)
  const breadcrumbs = screen.getByRole('navigation', { name: '상위 화면' })
  expect(within(breadcrumbs).getByRole('link', { name: '신청 문서 작성 도우미' })).toBeTruthy()
  expect(within(breadcrumbs).getByRole('link', { name: '신청 문서 / 답변 입력' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '신청 문서 초안' })).toBeTruthy()
  expect(downloadButton.compareDocumentPosition(downloadHint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByLabelText('답변 입력')).toBeNull()
  expect(screen.queryByLabelText('작성본 내용')).toBeNull()
  expect(repository.generateDocuments).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('link', { name: '이전으로 · 답변 수정' }))
  expect((await screen.findByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새봄테크')
})

it('blocks generation for missing answers or unsaved answers in any section', async () => {
  repository.get.mockResolvedValueOnce(readyPreparation())
  mount('/app/application-preparations/12')
  await screen.findByLabelText('답변 입력')
  fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '변경한 업체명' } })
  fireEvent.click(screen.getByRole('button', { name: '다음 항목' }))
  expect((screen.getByRole('button', { name: '초안 생성하기' }) as HTMLButtonElement).disabled).toBe(true)
  expect(repository.generateDocuments).not.toHaveBeenCalled()
})

it('reuses a stored native document on refresh without another generation call', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([documentFile])
  mount('/app/application-preparations/12/documents?generate=3')
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  expect(repository.generateDocuments).not.toHaveBeenCalled()
})

it('shows the immutable partial-draft answer summary beside the download', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([{ ...documentFile, filledAnswerCount: 1, unfilledAnswerCount: 1, unfilledAnswers: [{
    fieldId: 'company-overview:consent', fieldLabel: '기업 개요 / 개인정보 동의', value: '동의함', reason: 'INPUT_LOCATION_NOT_FOUND',
  }] }])
  mount('/app/application-preparations/12/documents')
  expect(await screen.findByRole('heading', { name: '일부 항목 미기입 초안' })).toBeTruthy()
  expect(screen.getByText('1개 기입 / 1개 미기입')).toBeTruthy()
  expect(screen.getByLabelText('자동 기입하지 못한 답변').textContent).toContain('기업 개요 / 개인정보 동의: 동의함 — 입력 위치 확인 불가')
  expect(screen.getByRole('button', { name: '신청문서 1 다운로드' })).toBeTruthy()
})

it('regenerates the document with the revised answers after returning to the input page', async () => {
  const ready = readyPreparation()
  repository.get.mockResolvedValue(ready)
  repository.documents.mockResolvedValueOnce([documentFile]).mockResolvedValue([])
  const revised = structuredClone(ready)
  revised.inputRevision = 4
  revised.form.sections[0].facts[0].value = '변경한 업체명'
  repository.replaceInputs.mockImplementation(async () => { repository.get.mockResolvedValue(revised); return revised })
  repository.generateDocuments.mockResolvedValue([{ ...documentFile, id: 82, inputRevision: 4, fileName: '신청서_초안_v4.hwpx' }])
  mount('/app/application-preparations/12/documents')
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  fireEvent.click(screen.getByRole('link', { name: '이전으로 · 답변 수정' }))
  fireEvent.change(await screen.findByLabelText('답변 입력'), { target: { value: '변경한 업체명' } })
  fireEvent.click(screen.getByRole('button', { name: '문서 답변 저장' }))
  await screen.findByText('변경한 업체명')
  fireEvent.click(screen.getByRole('button', { name: '초안 생성하기' }))
  await screen.findByText('신청서_초안_v4.hwpx')
  expect(repository.generateDocuments).toHaveBeenCalledWith(12, 4, expect.any(AbortSignal))
})

it('does not expose a download for a failed generation and retries the same revision', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.generateDocuments.mockRejectedValueOnce(new ApplicationPreparationError(422, 'APPLICATION_DOCUMENT_MAPPING_FAILED'))
  mount('/app/application-preparations/12/documents?generate=3')
  expect((await screen.findByRole('alert')).textContent).toContain('입력 위치')
  expect(screen.queryByRole('button', { name: /다운로드/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  expect(repository.generateDocuments.mock.calls.map((call) => call[1])).toEqual([3, 3])
})

it('prevents generating with a stale revision and aborts requests after leaving', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  const { unmount } = mount('/app/application-preparations/12/documents?generate=2')
  expect((await screen.findByRole('alert')).textContent).toContain('답변이 변경')
  expect(repository.generateDocuments).not.toHaveBeenCalled()
  const signal = repository.get.mock.calls[0][1] as AbortSignal
  unmount()
  expect(signal.aborted).toBe(true)
})

it('downloads binary data using the original extension and reports download errors', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([documentFile])
  repository.downloadDocument.mockResolvedValueOnce(new Blob(['zip'], { type: documentFile.mediaType }))
    .mockRejectedValueOnce(new ApplicationPreparationError(404, 'APPLICATION_PREPARATION_NOT_FOUND'))
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe(documentFile.fileName)
  })
  mount('/app/application-preparations/12/documents')
  fireEvent.click(await screen.findByRole('button', { name: '신청문서 1 다운로드' }))
  await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: '신청문서 1 다운로드' }))
  await screen.findByRole('alert')
  expect(repository.downloadDocument).toHaveBeenCalledWith(12, 81, expect.any(AbortSignal))
  clicked.mockRestore()
  vi.unstubAllGlobals()
})

function readyPreparation(): ApplicationPreparation {
  const ready: ApplicationPreparation = structuredClone(detail)
  ready.form.sections.forEach((section) => {
    section.status = 'INPUT_CONFIRMED'
    section.facts = section.fields.map((field, index) => ({ id: index + 1, fieldKey: field.key, status: 'PROVIDED',
      value: '새봄테크', sourceText: '새봄테크', inputRevision: 3, updatedAt: detail.updatedAt }))
  })
  return ready
}

it('lists unknown and unanswered fields separately from the downloadable document', async () => {
  const ready = readyPreparation()
  ready.form.sections[1].facts[0].status = 'UNKNOWN'
  ready.form.sections[1].facts[0].value = null
  repository.get.mockResolvedValue(ready)
  repository.documents.mockResolvedValue([documentFile])
  mount('/app/application-preparations/12/documents')
  const report = await screen.findByRole('region', { name: '답변이 없어 기입하지 않은 항목' })
  expect(within(report).getByText('바우처 활용 계획 · 과제명')).toBeTruthy()
  expect(within(report).queryByText('기업 개요 · 업체명')).toBeNull()
})

it('shows a partial answer count even when the server confirms all required fields', async () => {
  const ready = readyPreparation()
  ready.form.sections[0].fields.push({ key: 'position', label: '직위', guidance: '직위만 입력', required: false })
  repository.get.mockResolvedValue(ready)
  mount('/app/application-preparations/12')
  await screen.findByRole('heading', { name: '공식 작성 항목' })
  expect(screen.getAllByText('1/2개 입력 확인').length).toBeGreaterThan(0)
  expect(screen.queryByText('사실 확인됨')).toBeNull()
})

it('starts reanalysis only on an explicit click and preserves existing preparations', async () => {
  mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
  const button = await screen.findByRole('button', { name: '입력칸별 양식 다시 분석' })
  expect(repository.discover).not.toHaveBeenCalled()
  fireEvent.click(button)
  await screen.findByText(/입력칸별로 분석한 양식입니다/)
  expect(repository.discover).toHaveBeenCalledTimes(1)
  expect(repository.create).not.toHaveBeenCalled()
  expect(repository.delete).not.toHaveBeenCalled()
  expect(repository.replaceInputs).not.toHaveBeenCalled()
})

it('marks a manual-only field without accepting an auto-fill answer', async () => {
  const ready = readyPreparation()
  ready.form.sections[0].fields[0].documentWritable = false
  ready.form.sections[0].facts = []
  repository.get.mockResolvedValue(ready)
  mount('/app/application-preparations/12')
  const input = await screen.findByLabelText('답변 입력')
  expect((input as HTMLTextAreaElement).disabled).toBe(true)
  expect(screen.getByText(/이 항목은 자동 기입할 수 없습니다/)).toBeTruthy()
})

beforeEach(() => {
  vi.resetAllMocks()
  repository.documents.mockResolvedValue([])
  repository.generateDocuments.mockResolvedValue([documentFile])
  repository.discoveryJobs.mockResolvedValue([])
  repository.availability.mockResolvedValue({ state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status: 'AVAILABLE',
    reasonCode: 'FORM_FOUND', nextRetryAt: null, attemptCount: 1 }, forms: { items: [structuredClone(firstForm)] } })
  repository.forms.mockResolvedValue([structuredClone(firstForm)])
  repository.discover.mockResolvedValue(completedDiscovery({ items: [structuredClone(firstForm)], warnings: ['원문 대조 필요'], cached: false }))
  repository.list.mockResolvedValue({ items: [], nextBeforeId: null })
  repository.delete.mockResolvedValue(undefined)
  repository.get.mockResolvedValue(structuredClone(detail))
  repository.create.mockResolvedValue(structuredClone(detail))
  repository.interpret.mockResolvedValue({
    runId: 31,
    inputRevision: 3,
    sectionKey: 'company-overview',
    suggestions: [{ fieldKey: 'company-name', status: 'PROVIDED', value: '새봄테크', evidenceQuote: '업체명은 새봄테크' }],
    missingFields: [],
    nextQuestion: null,
  })
  repository.replaceInputs.mockResolvedValue({
    ...structuredClone(detail),
    inputRevision: 4,
    form: {
      ...structuredClone(firstForm),
      sections: firstForm.sections.map((section) => section.key === 'company-overview' ? {
        ...section,
        status: 'INPUT_CONFIRMED' as const,
        facts: [{ id: 9, fieldKey: 'company-name', status: 'PROVIDED' as const, value: '새봄테크 연구소', sourceText: '업체명: 업체명은 새봄테크입니다.', inputRevision: 4, updatedAt: detail.updatedAt }],
      } : section),
    },
  })
  browsePrograms.mockResolvedValue({
    programs: [structuredClone(supportPrograms[0])], total: 1, page: 1, pageSize: 10, totalPages: 1,
    regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [],
  })
  browseSavedPrograms.mockResolvedValue([])
  getProgramDetail.mockImplementation(async (identity: { sourceCode: string; sourceProgramId: string }) => ({
    ...structuredClone(supportPrograms[0]),
    sourceCode: identity.sourceCode,
    id: identity.sourceProgramId,
  }))
  appContainer.register({
    applicationPreparationUseCase: asValue(new ApplicationPreparationUseCase(repository)),
    browseSupportProgramsUseCase: asValue({ execute: browsePrograms }),
    browseSavedSupportProgramsUseCase: asValue({ execute: browseSavedPrograms }),
    getSupportProgramDetailUseCase: asValue({ execute: getProgramDetail }),
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  appContainer.register({
    applicationPreparationUseCase: asValue(original),
    browseSupportProgramsUseCase: asValue(originalCatalog),
    browseSavedSupportProgramsUseCase: asValue(originalSavedPrograms),
    getSupportProgramDetailUseCase: asValue(originalProgramDetail),
  })
})

function mount(path: string) {
  const store = createAppStore()
  store.dispatch(signedIn({ email: 'owner@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, company: null }))
  const rendered = render(<Provider store={store}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/app/application-preparations" element={<ApplicationPreparationListPage />} />
    <Route path="/app/application-preparations/:preparationId/documents" element={<ApplicationDocumentPage />} />
    <Route path="/app/application-preparations/new" element={<ApplicationPreparationEditorPage create />} />
    <Route path="/app/application-preparations/:preparationId" element={<ApplicationPreparationEditorPage />} />
  </Routes></MemoryRouter></Provider>)
  return { store, ...rendered }
}

describe('application preparation list', () => {
  it('announces initial loading and then shows the empty state', async () => {
    const request = deferred<ApplicationPreparationPage>()
    repository.list.mockReturnValueOnce(request.promise)
    mount('/app/application-preparations')

    expect(screen.getByRole('status').textContent).toContain('목록을 불러오는 중')
    await act(async () => request.resolve({ items: [], nextBeforeId: null }))

    expect(screen.getByRole('heading', { name: '아직 시작한 신청 문서가 없습니다.' })).toBeTruthy()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('shows a focused error and retries the failed request', async () => {
    repository.list
      .mockRejectedValueOnce(new Error('목록을 잠시 불러올 수 없습니다.'))
      .mockResolvedValueOnce({ items: [], nextBeforeId: null })
    mount('/app/application-preparations')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('목록을 잠시 불러올 수 없습니다.')
    expect(document.activeElement).toBe(alert)
    fireEvent.click(within(alert).getByRole('button', { name: '목록 다시 불러오기' }))

    await screen.findByRole('heading', { name: '아직 시작한 신청 문서가 없습니다.' })
    expect(repository.list).toHaveBeenCalledTimes(2)
  })

  it('explains that a collection 404 requires a backend image refresh instead of showing an empty list', async () => {
    repository.list.mockRejectedValueOnce(new ApplicationPreparationError(404, 'APPLICATION_PREPARATION_API_UNAVAILABLE'))
    mount('/app/application-preparations')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Core·AI Service 이미지를 갱신')
    expect(screen.queryByRole('heading', { name: '아직 시작한 신청 문서가 없습니다.' })).toBeNull()
  })

  it('appends a cursor page and announces the more-loading state', async () => {
    const nextPage = deferred<ApplicationPreparationPage>()
    repository.list
      .mockResolvedValueOnce({
        items: [{ id: 12, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
          sourceCode: firstForm.sourceCode, sourceProgramId: firstForm.sourceProgramId,
          serviceField: 'TECHNICAL_SUPPORT', programTitle: firstForm.programTitle, formTitle: firstForm.formTitle, updatedAt: detail.updatedAt }],
        nextBeforeId: 12,
      })
      .mockReturnValueOnce(nextPage.promise)
    mount('/app/application-preparations')

    fireEvent.click(await screen.findByRole('button', { name: '이전 작업 더 보기' }))
    expect(screen.getByRole('status').textContent).toContain('이전 신청 준비')
    expect((screen.getByRole('button', { name: '이전 작업 불러오는 중…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => nextPage.resolve({
      items: [{ id: 11, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
        sourceCode: secondForm.sourceCode, sourceProgramId: secondForm.sourceProgramId,
        serviceField: 'MARKETING', programTitle: secondForm.programTitle, formTitle: secondForm.formTitle, updatedAt: detail.updatedAt }],
      nextBeforeId: null,
    }))

    expect(await screen.findByText(secondForm.programTitle)).toBeTruthy()
    expect(repository.list.mock.calls[1]?.[0]).toBe(12)
  })

  it('aborts the previous account request and ignores its late response', async () => {
    const firstRequest = deferred<ApplicationPreparationPage>()
    const secondRequest = deferred<ApplicationPreparationPage>()
    repository.list.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(secondRequest.promise)
    const { store } = mount('/app/application-preparations')
    const firstSignal = repository.list.mock.calls[0]?.[1] as AbortSignal

    act(() => {
      store.dispatch(signedIn({ email: 'next@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, company: null }))
    })
    expect(firstSignal.aborted).toBe(true)
    await act(async () => secondRequest.resolve({
      items: [{ id: 21, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
        sourceCode: secondForm.sourceCode, sourceProgramId: secondForm.sourceProgramId,
        serviceField: 'MARKETING', programTitle: '최신 사용자 신청', formTitle: secondForm.formTitle, updatedAt: detail.updatedAt }],
      nextBeforeId: null,
    }))
    expect(await screen.findByText('최신 사용자 신청')).toBeTruthy()

    await act(async () => firstRequest.resolve({
      items: [{ id: 20, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
        sourceCode: firstForm.sourceCode, sourceProgramId: firstForm.sourceProgramId,
        serviceField: 'CONSULTING', programTitle: '이전 사용자 신청', formTitle: firstForm.formTitle, updatedAt: detail.updatedAt }],
      nextBeforeId: null,
    }))
    expect(screen.queryByText('이전 사용자 신청')).toBeNull()
  })

  it('requires confirmation and removes only the selected saved preparation after deletion succeeds', async () => {
    repository.list.mockResolvedValueOnce({
      items: [{ id: 12, inputRevision: 3, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
        sourceCode: firstForm.sourceCode, sourceProgramId: firstForm.sourceProgramId,
        serviceField: 'TECHNICAL_SUPPORT', programTitle: firstForm.programTitle, formTitle: firstForm.formTitle, updatedAt: detail.updatedAt }],
      nextBeforeId: null,
    })
    mount('/app/application-preparations')
    await screen.findByText(firstForm.programTitle)

    fireEvent.click(screen.getByRole('button', { name: '삭제' }))
    const confirmation = screen.getByRole('group', { name: `${firstForm.programTitle} 삭제 확인` })
    expect(confirmation.textContent).toContain('작성 내용과 AI 실행 기록')
    expect(repository.delete).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '정말 삭제' }))

    expect(repository.delete).toHaveBeenCalledWith(12, expect.any(AbortSignal))
    expect(await screen.findByRole('heading', { name: '아직 시작한 신청 문서가 없습니다.' })).toBeTruthy()
    expect(screen.queryByText(firstForm.programTitle)).toBeNull()
  })
})

describe('application preparation creation and detail', () => {
  it('waits for the button before loading snapshots for a notice selected from its detail page', async () => {
    mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
    const checkButton = within(await screen.findByRole('region', { name: '선택한 공고' })).getByRole('button', { name: '저장된 신청 양식 확인' })
    expect(repository.availability).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: '신청 문서를 찾았습니다' })).toBeNull()
    fireEvent.click(checkButton)
    await screen.findByRole('heading', { name: '신청 문서를 찾았습니다' })
    expect(repository.availability).toHaveBeenCalledTimes(1)
    expect(repository.availability).toHaveBeenCalledWith('BIZINFO', 'PBLN_1', expect.any(AbortSignal))
    expect(repository.discover).not.toHaveBeenCalled()
    expect(repository.discoveryJobs).not.toHaveBeenCalled()
    expect(repository.discoveryJob).not.toHaveBeenCalled()
  })

  it.each([
    ['PENDING', 'NOT_ANALYZED', '이 공고의 신청 양식이 아직 분석되지 않았습니다.'],
    ['STALE', 'SOURCE_CHANGED', '공고나 공식 첨부가 변경되어 다시 확인해야 합니다.'],
    ['NO_FORM', 'NO_FORM', '분석한 공식 첨부에서 작성할 신청 양식을 찾지 못했습니다.'],
    ['DOCUMENT_UNAVAILABLE', 'SOURCE_NOT_FOUND', '공식 공고 또는 첨부가 없어졌거나 변경되었습니다.'],
    ['DOCUMENT_UNAVAILABLE', 'SOURCE_INVALID', '공식 첨부의 형식이나 출처를 검증하지 못했습니다.'],
    ['TOO_LARGE', 'SOURCE_TOO_LARGE', '첨부 파일의 크기나 문서 분량이 분석 제한을 초과했습니다.'],
    ['RETRY_WAITING', 'SOURCE_UNAVAILABLE', '공식 사이트에서 공고나 첨부 파일을 불러오지 못했습니다.'],
    ['RETRY_WAITING', 'AI_UNAVAILABLE', 'AI 분석 서비스에 연결하지 못했습니다.'],
    ['REVIEW_REQUIRED', 'AI_INVALID_RESPONSE', 'AI 분석 응답이 올바르지 않거나 추출한 문항의 근거를 검증하지 못했습니다.'],
    ['REVIEW_REQUIRED', 'DISCOVERY_CONFIGURATION_INVALID', '신청 양식 분석 설정이 올바르지 않아 분석을 시작하지 못했습니다.'],
    ['REVIEW_REQUIRED', 'RETRY_EXHAUSTED:AI_UNAVAILABLE', 'AI 분석 서비스에 연결하지 못했습니다. 자동 재시도 한도에 도달하여 관리자 확인이 필요합니다.'],
    ['REVIEW_REQUIRED', 'WORKER_RETRY_EXHAUSTED', '분석 작업이 완료되지 않은 채 재시도 한도에 도달했습니다. 관리자 확인이 필요합니다.'],
  ])('shows the reason for %s / %s only after clicking the button', async (status, reasonCode, message) => {
    repository.availability.mockResolvedValue({ state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status,
      reasonCode, nextRetryAt: null, attemptCount: 1 }, forms: { items: [] } })
    mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
    const checkButton = within(await screen.findByRole('region', { name: '선택한 공고' })).getByRole('button', { name: '저장된 신청 양식 확인' })
    expect(repository.availability).not.toHaveBeenCalled()
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByText('검색에서 공고를 찾지 못했나요?')).toBeNull()
    fireEvent.click(checkButton)
    const result = await screen.findByRole('status', { name: '신청 양식 확인 결과' })
    expect(within(result).getByText(message)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '신청 문서를 찾았습니다' })).toBeNull()
    expect(repository.create).not.toHaveBeenCalled()
    expect(repository.discover).not.toHaveBeenCalled()
  })

  it('offers multiple stored forms for one notice', async () => {
    repository.availability.mockResolvedValue({ state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status: 'AVAILABLE',
      reasonCode: 'FORM_FOUND', nextRetryAt: null, attemptCount: 1 }, forms: { items: [firstForm, { ...secondForm, sourceProgramId: 'PBLN_1' }] } })
    mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
    fireEvent.click(within(await screen.findByRole('region', { name: '선택한 공고' })).getByRole('button', { name: '저장된 신청 양식 확인' }))
    const formSelect = await screen.findByLabelText('작성할 공식 첨부')
    expect(optionValues(formSelect)).toEqual([firstForm.formVersionId, secondForm.formVersionId])
    chooseOption(formSelect, secondForm.formVersionId)
    expect(selectedValue(formSelect)).toBe(secondForm.formVersionId)
    expect(repository.discover).not.toHaveBeenCalled()
  })

  it('aborts active snapshot lookup when leaving the page', async () => {
    repository.availability.mockReturnValue(new Promise(() => {}))
    const page = mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
    fireEvent.click(within(await screen.findByRole('region', { name: '선택한 공고' })).getByRole('button', { name: '저장된 신청 양식 확인' }))
    await waitFor(() => expect(repository.availability).toHaveBeenCalled())
    const signal = repository.availability.mock.calls[0][2] as AbortSignal
    page.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('waits for confirmation after selecting a search result or returning to program selection', async () => {
    mount('/app/application-preparations/new')
    fireEvent.click(screen.getByRole('button', { name: '공고 검색' }))
    fireEvent.click(await screen.findByRole('button', { name: '선택' }))
    expect(repository.availability).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '저장된 신청 양식 확인' }))
    await screen.findByRole('heading', { name: '신청 문서를 찾았습니다' })
    fireEvent.click(screen.getByRole('button', { name: '공고 다시 선택' }))
    expect(screen.getByRole('button', { name: '저장된 신청 양식 확인' })).toBeTruthy()
    expect(repository.availability).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '저장된 신청 양식 확인' }))
    await screen.findByRole('heading', { name: '신청 문서를 찾았습니다' })
    expect(repository.availability).toHaveBeenCalledTimes(2)
  })

  it('waits for the button after choosing a saved program', async () => {
    browseSavedPrograms.mockResolvedValue([{ savedAt: detail.createdAt, program: structuredClone(supportPrograms[0]) }])
    mount('/app/application-preparations/new')
    fireEvent.click(screen.getByRole('button', { name: '관심 공고함에서 선택' }))
    fireEvent.click(await screen.findByRole('button', { name: `${supportPrograms[0].title} 관심 공고 선택` }))
    fireEvent.click(screen.getByRole('button', { name: '선택 완료' }))
    expect(repository.availability).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '저장된 신청 양식 확인' }))
    await screen.findByRole('heading', { name: '신청 문서를 찾았습니다' })
    expect(repository.availability).toHaveBeenCalledWith(supportPrograms[0].sourceCode, supportPrograms[0].id, expect.any(AbortSignal))
  })

  it('clears stale results on retry, displays request errors, and resets them when clearing the selection', async () => {
    repository.availability.mockResolvedValueOnce({ state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status: 'NO_FORM',
      reasonCode: 'NO_FORM', nextRetryAt: null, attemptCount: 1 }, forms: { items: [] } })
    const request = deferred<never>()
    repository.availability.mockReturnValueOnce(request.promise)
    mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
    await screen.findByRole('region', { name: '선택한 공고' })
    expect(screen.queryByText('공식 공고 URL·ID 직접 입력')).toBeNull()
    expect(screen.queryByLabelText('기업마당 공식 공고 URL 또는 공고 ID')).toBeNull()
    expect(repository.availability).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '저장된 신청 양식 확인' }))
    await screen.findByRole('status', { name: '신청 양식 확인 결과' })
    fireEvent.click(screen.getByRole('button', { name: '저장된 신청 양식 확인' }))
    expect(screen.queryByRole('status', { name: '신청 양식 확인 결과' })).toBeNull()
    const busyButton = screen.getByRole('button', { name: '양식 상태 조회 중…' }) as HTMLButtonElement
    expect(busyButton.disabled).toBe(true)
    fireEvent.click(busyButton)
    expect(repository.availability).toHaveBeenCalledTimes(2)
    await act(async () => request.reject(new ApplicationPreparationError(504, 'REQUEST_TIMEOUT')))
    expect((await screen.findByRole('alert')).textContent).toContain('신청 준비 요청 시간이 초과되었습니다.')
    fireEvent.click(screen.getByRole('button', { name: '선택 취소' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(repository.availability).toHaveBeenCalledTimes(2)
  })

  it('clears the previous failure when selecting another program', async () => {
    repository.availability.mockResolvedValueOnce({ state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status: 'NO_FORM',
      reasonCode: 'NO_FORM', nextRetryAt: null, attemptCount: 1 }, forms: { items: [] } })
    mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
    fireEvent.click(within(await screen.findByRole('region', { name: '선택한 공고' })).getByRole('button', { name: '저장된 신청 양식 확인' }))
    await screen.findByRole('status', { name: '신청 양식 확인 결과' })
    fireEvent.click(screen.getByRole('button', { name: '선택 취소' }))
    expect(screen.queryByRole('status', { name: '신청 양식 확인 결과' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '공고 검색' }))
    fireEvent.click(await screen.findByRole('button', { name: '선택' }))
    expect(repository.availability).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status', { name: '신청 양식 확인 결과' })).toBeNull()
  })

  it('displays the complete official detail without starting AI', async () => {
    mount('/app/application-preparations/12')
    await screen.findByRole('heading', { name: '공식 작성 항목' })

    expect(screen.getByRole('heading', { name: '신청 문서 / 답변 입력' })).toBeTruthy()
    expect(screen.getByText(firstForm.programTitle)).toBeTruthy()
    expect(screen.getByText(firstForm.attachmentFileName)).toBeTruthy()
    expect(screen.queryByText('양식명')).toBeNull()
    expect(screen.queryByText('파일 SHA-256')).toBeNull()
    expect(screen.queryByRole('heading', { name: '신청 준비 정보' })).toBeNull()
    expect(screen.getByRole('link', { name: /공식 공고 열기/ }).getAttribute('href')).toBe(firstForm.sourceUrl)
    expect(screen.getAllByLabelText('작성 상태: 0/1개 입력 확인')).toHaveLength(2)
    expect(screen.getAllByText('1. 기업 개요')).toHaveLength(2)
    expect(screen.queryByText(/공식 양식 위치:/)).toBeNull()
    expect(repository.create).not.toHaveBeenCalled()
    expect(repository.interpret).not.toHaveBeenCalled()
  })

  it('shows every saved answer in its input instead of retaining it invisibly', async () => {
    const ready = readyPreparation()
    ready.form.sections[0].facts[0].value = '기존 저장 업체명'
    ready.form.sections[0].facts[0].sourceText = '업체명: 기존 저장 업체명'
    repository.get.mockResolvedValue(ready)
    mount('/app/application-preparations/12')

    expect((await screen.findByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('기존 저장 업체명')
    expect(screen.getByRole('button', { name: '저장된 답변 삭제' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '문서 답변 저장' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('deletes a saved answer only through the explicit delete action and saves the visible section state', async () => {
    const ready = readyPreparation()
    repository.get.mockResolvedValue(ready)
    const updated = structuredClone(ready)
    updated.inputRevision = 4
    updated.form.sections[0].facts = []
    repository.replaceInputs.mockResolvedValue(updated)
    mount('/app/application-preparations/12')
    const input = await screen.findByLabelText('답변 입력') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '문서 답변 저장' }))
    expect((await screen.findByRole('alert')).textContent).toContain('기존 답변을 없애려면 답변 삭제')
    expect(repository.replaceInputs).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '저장된 답변 삭제' }))
    expect(screen.getByText('문서 답변 저장을 누르면 기존 답변이 삭제됩니다.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '문서 답변 저장' }))
    await waitFor(() => expect(repository.replaceInputs).toHaveBeenCalledWith(12, 'company-overview', {
      expectedRevision: 3, facts: [],
    }, expect.any(AbortSignal)))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('')
  })

  it('saves multiple question answers once without AI and retains another document draft', async () => {
    const form = structuredClone(detail)
    form.form.sections[0].fields.push({ key: 'contact', label: '담당자', guidance: '담당자를 입력하세요.', required: false })
    repository.get.mockResolvedValue(form)
    const saved = structuredClone(form)
    saved.inputRevision = 4
    saved.form.sections[0].facts = [
      { id: 1, fieldKey: 'company-name', status: 'PROVIDED', value: '새봄', sourceText: '업체명: 새봄', inputRevision: 4, updatedAt: detail.updatedAt },
      { id: 2, fieldKey: 'contact', status: 'UNKNOWN', value: null, sourceText: '담당자: 미정', inputRevision: 4, updatedAt: detail.updatedAt },
    ]
    repository.replaceInputs.mockResolvedValue(saved)
    mount('/app/application-preparations/12')
    await screen.findByRole('region', { name: '기업 개요 작성' })
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 질문' }))
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '미정' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 항목' }))
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '다른 문서의 초안' } })
    fireEvent.click(screen.getByRole('button', { name: '이전 항목' }))
    fireEvent.click(screen.getByRole('button', { name: '문서 답변 저장' }))
    await screen.findByText('저장된 답변 2개')
    expect(repository.interpret).not.toHaveBeenCalled()
    expect(repository.replaceInputs).toHaveBeenCalledTimes(1)
    expect(repository.replaceInputs).toHaveBeenCalledWith(12, 'company-overview', { expectedRevision: 3, facts: [
      { fieldKey: 'company-name', status: 'PROVIDED', value: '새봄', sourceText: '업체명: 새봄' },
      { fieldKey: 'contact', status: 'UNKNOWN', value: null, sourceText: '담당자: 미정' },
    ] }, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: '다음 항목' }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('다른 문서의 초안')
  })

  it('keeps unsaved answers when document saving fails', async () => {
    repository.replaceInputs.mockRejectedValue(new Error('저장 연결 실패'))
    mount('/app/application-preparations/12')
    await screen.findByRole('region', { name: '기업 개요 작성' })
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '보존할 답변' } })
    fireEvent.click(screen.getByRole('button', { name: '문서 답변 저장' }))
    await screen.findByRole('alert')
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('보존할 답변')
    expect(screen.queryByText(/저장된 답변 \d+개/)).toBeNull()
  })

  it('offers official single choices and keeps the selected answer when navigating', async () => {
    const choices = structuredClone(detail)
    choices.form.sections[0].fields[0] = { key: 'idea-field', label: '아이디어 분야 (택1)', guidance: '한 분야를 선택하세요.', required: true, options: ['기술', '생활'] }
    repository.get.mockResolvedValue(choices)
    mount('/app/application-preparations/12')
    const first = await screen.findByRole('radio', { name: '기술' })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('radio', { name: '생활' }))
    expect((first as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '다음 항목' }))
    fireEvent.click(screen.getByRole('button', { name: '이전 항목' }))
    expect((screen.getByRole('radio', { name: '생활' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('button', { name: 'AI로 답변 확인' })).toBeNull()
    expect(repository.interpret).not.toHaveBeenCalled()
  })

  it('explains missing official choices without inventing options', async () => {
    const choices = structuredClone(detail)
    choices.form.sections[0].fields[0].label = '아이디어 분야 (택1)'
    repository.get.mockResolvedValue(choices)
    mount('/app/application-preparations/12')
    expect(await screen.findByText(/공식 선택지를 확인하지 못했습니다/)).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('asks one of sixteen fields at a time and retains each answer without calling AI on navigation', async () => {
    const manyFields = structuredClone(detail)
    manyFields.form.sections[0].fields = Array.from({ length: 16 }, (_, index) => ({ key: `field-${index}`, label: `입력내용${index + 1}`, guidance: `안내문${index + 1}`, required: true }))
    repository.get.mockResolvedValue(manyFields)
    mount('/app/application-preparations/12')
    await screen.findByText('질문 1 / 16 · 답변 0개')
    expect(screen.getByText('안내문1')).toBeTruthy()
    expect(screen.queryByText('안내문2')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '첫 번째 답변' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 질문' }))
    expect(screen.getByText('질문 2 / 16 · 답변 1개')).toBeTruthy()
    expect(screen.getByText('안내문2')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '두 번째 답변' } })
    fireEvent.click(screen.getByRole('button', { name: '이전 질문' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('첫 번째 답변')
    for (let index = 0; index < 15; index++) fireEvent.click(screen.getByRole('button', { name: '다음 질문' }))
    expect(screen.getByText('질문 16 / 16 · 답변 2개')).toBeTruthy()
    expect((screen.getByRole('button', { name: '다음 질문' }) as HTMLButtonElement).disabled).toBe(true)
    expect(repository.interpret).not.toHaveBeenCalled()
    expect(repository.replaceInputs).not.toHaveBeenCalled()
  })

  it('opens one section at a time and preserves answers across navigation', async () => {
    mount('/app/application-preparations/12')
    const first = await screen.findByRole('region', { name: '기업 개요 작성' })
    expect(screen.queryByRole('region', { name: '바우처 활용 계획 작성' })).toBeNull()
    expect((screen.getByRole('button', { name: '이전 항목' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(first).getByRole('textbox'), { target: { value: '업체명은 새봄테크입니다.' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 항목' }))
    expect(screen.queryByRole('region', { name: '기업 개요 작성' })).toBeNull()
    const second = screen.getByRole('region', { name: '바우처 활용 계획 작성' })
    fireEvent.change(within(second).getByRole('textbox'), { target: { value: '새로운 과제입니다.' } })
    expect((screen.getByRole('button', { name: '다음 항목' }) as HTMLButtonElement).disabled).toBe(true)
    const lastNotice = within(second).getByText(/마지막 항목입니다/)
    const saveButton = within(second).getByRole('button', { name: '문서 답변 저장' })
    const saveHint = within(second).getByText(/저장 전 답변은 이 화면에서 항목을 이동할 때 유지됩니다/)
    expect(within(second).getByRole('textbox').compareDocumentPosition(lastNotice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(lastNotice.compareDocumentPosition(saveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(saveHint.compareDocumentPosition(saveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const list = screen.getByRole('navigation', { name: '신청 문서 작성 항목 목록' })
    fireEvent.click(within(list).getByRole('button', { name: /1. 기업 개요/ }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('업체명은 새봄테크입니다.')
    expect(within(list).getByRole('button', { name: /1. 기업 개요/ }).getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: '다음 항목' }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새로운 과제입니다.')
    expect(repository.interpret).not.toHaveBeenCalled()
    expect(repository.replaceInputs).not.toHaveBeenCalled()
  })

  it('rejects a malformed detail id without making a request', () => {
    mount('/app/application-preparations/not-a-number')
    expect(screen.getByRole('alert').textContent).toContain('올바른 신청 준비 주소')
    expect(repository.get).not.toHaveBeenCalled()
  })

  it.each([
    [new ApplicationPreparationError(401, 'AUTHENTICATION_REQUIRED'), '로그인이 만료되었습니다.'],
    [new ApplicationPreparationError(422, 'APPLICATION_FORM_NOT_SUPPORTED'), '현재 지원하지 않는 공고·양식·지원 분야입니다.'],
    [new ApplicationPreparationError(404, 'APPLICATION_PREPARATION_NOT_FOUND'), '신청 준비 건을 찾을 수 없습니다.'],
    [new ApplicationPreparationError(502, 'INVALID_RESPONSE'), '신청 준비 응답 형식을 확인하지 못했습니다.'],
  ] as const)('shows an understandable API failure for detail requests', async (failure, message) => {
    repository.get.mockRejectedValueOnce(failure)
    mount('/app/application-preparations/12')
    expect((await screen.findByRole('alert')).textContent).toContain(message)
  })

})
