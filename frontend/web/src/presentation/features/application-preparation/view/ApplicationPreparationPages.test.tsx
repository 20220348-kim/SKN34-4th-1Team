// @vitest-environment jsdom
import { asValue } from 'awilix/browser'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { supportProgramDetails, supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { ApplicationDocumentGenerationJob, ApplicationForm, ApplicationPreparation, ApplicationPreparationPage } from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { ApplicationPreparationUseCase } from '../../../../domain/usecases/ApplicationPreparationUseCase'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { ApplicationPreparationEditorPage, ApplicationPreparationListPage } from './ApplicationPreparationPages'
import { supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { ApplicationPreparationNewPage } from './ApplicationPreparationNewPage'
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
const repository = { onlineInputGuide: vi.fn(), documents: vi.fn(), submitDocumentJob: vi.fn(), documentJob: vi.fn(), documentJobs: vi.fn(), confirmDocumentMappingMigration: vi.fn(), downloadDocument: vi.fn(), downloadDocumentArchive: vi.fn(), generateDraft: vi.fn(), saveContent: vi.fn(), confirmContent: vi.fn(), discoveryJobs: vi.fn(), discoveryJob: vi.fn(), availability: vi.fn(), forms: vi.fn(), discover: vi.fn(), list: vi.fn(), delete: vi.fn(), get: vi.fn(), create: vi.fn(), interpret: vi.fn(), replaceInputs: vi.fn(), updateProgress: vi.fn() }

function completedDiscovery(result: { items: ApplicationForm[]; warnings: string[]; cached: boolean }) {
  return { id: 77, sourceCode: result.items[0].sourceCode, sourceProgramId: result.items[0].sourceProgramId,
    programTitle: result.items[0].programTitle, programSourceUrl: result.items[0].sourceUrl,
    status: 'SUCCEEDED' as const, result, failureCode: null, createdAt: detail.createdAt }
}

/**
 * 자동 저장 대역입니다. 보낸 사실을 그 항목에 그대로 반영하고 입력 버전을 1 올린 준비 건을 돌려줍니다.
 * 이후 `get`도 같은 결과를 돌려줘 결과 화면이 최신 버전으로 열립니다.
 */
function echoReplaceInputs(base: ApplicationPreparation) {
  let latest = structuredClone(base)
  repository.replaceInputs.mockImplementation(async (_id: number, sectionKey: string, input: { expectedRevision: number; facts: { fieldKey: string; status: 'PROVIDED' | 'UNKNOWN'; value: string | null; sourceText: string }[] }) => {
    const next = structuredClone(latest)
    next.inputRevision = input.expectedRevision + 1
    const section = next.form.sections.find((candidate) => candidate.key === sectionKey)!
    section.facts = input.facts.map((fact, index) => ({ id: index + 1, ...fact, inputRevision: next.inputRevision, updatedAt: detail.updatedAt }))
    section.status = section.facts.length > 0 ? 'INPUT_CONFIRMED' : 'NOT_STARTED'
    latest = next
    repository.get.mockResolvedValue(structuredClone(next))
    // 온라인 입력 안내는 입력 버전이 같을 때만 정상으로 보이므로 새 버전을 따라갑니다.
    repository.onlineInputGuide.mockResolvedValue({ preparationId: next.id, inputRevision: next.inputRevision, totalCount: 0,
      readyCount: 0, needsReviewCount: 0, missingCount: 0, directInputCount: 0,
      externalMappingVerified: false, officialApplicationUrl: null, items: [], savedAnswers: [] })
    return structuredClone(next)
  })
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

function generationJob(overrides: Partial<ApplicationDocumentGenerationJob> = {}): ApplicationDocumentGenerationJob {
  return { id: 501, preparationId: 12, expectedRevision: 3, status: 'SUCCEEDED', stage: 'SAVING', fileIds: [81], failureCode: null,
    failureMessage: null, mappingMigration: null, createdAt: detail.createdAt, finishedAt: detail.updatedAt, ...overrides }
}

/** 생성 작업 대역입니다. 접수 즉시 SUCCEEDED로 돌아오고, 그 뒤 문서 목록은 만든 파일을 돌려줍니다. */
function jobSucceeds(files: (typeof documentFile)[]) {
  repository.submitDocumentJob.mockImplementation(async (_id: number, revision: number) => {
    const created = files.map((file) => ({ ...file, inputRevision: revision }))
    repository.documents.mockResolvedValue(created)
    return generationJob({ expectedRevision: revision, fileIds: created.map((file) => file.id) })
  })
}

/** 머리글 안에서만 찾습니다. 600px 미만 아래 동작 줄에도 같은 버튼이 있어서입니다. */
function header() {
  return within(screen.getByRole('banner'))
}

/** 파일 카드의 [받기] 버튼입니다. 파일 이름이 접근 이름에 붙습니다. */
function receiveButton(fileName = documentFile.fileName) {
  return screen.getByRole('button', { name: `받기: ${fileName}` }) as HTMLButtonElement
}

/** 답변 입력·초안 본문 첫 줄 "공고명 · 양식명 · 신청 분야"입니다. 전체 문구가 title에 있습니다. */
const ledeText = '혁신바우처 지원사업 · 혁신바우처 사업계획서 · 기술지원'
function expectLede() {
  const lede = screen.getByTitle(ledeText)
  expect(lede.textContent).toBe(ledeText)
  expect(within(lede).getByText('혁신바우처 지원사업').tagName).toBe('STRONG')
}

/** [다음 →]이 검토의 [초안 만들기]로 바뀐 뒤 클릭을 받지 않는 400ms가 지난 것으로 시계를 1초 앞당깁니다. */
function afterSwapGuard() {
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 1_000)
}

function stageStates() {
  return within(screen.getByRole('list', { name: '진행 단계' })).getAllByRole('listitem').map((item) => item.textContent)
}

it('follows a queued job stage by stage and loads the files once it succeeds', async () => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValueOnce([]).mockResolvedValue([documentFile])
  repository.submitDocumentJob.mockResolvedValue(generationJob({ status: 'QUEUED', stage: null, fileIds: [], finishedAt: null }))
  repository.documentJob.mockResolvedValueOnce(generationJob({ status: 'RUNNING', stage: 'MAPPING', fileIds: [], finishedAt: null }))
    .mockResolvedValueOnce(generationJob({ status: 'RUNNING', stage: 'WRITING', fileIds: [], finishedAt: null }))
    .mockResolvedValueOnce(generationJob())
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  const progress = screen.getByRole('status', { name: '문서 생성 진행' })
  expect(progress.textContent).toContain('답변 버전 3로 초안을 만들고 있어요')
  expect(progress.textContent).toContain('보통 1~3분 걸려요. 양식이 크면 더 걸릴 수 있어요.')
  expect(progress.textContent).toContain('순서를 기다리고 있어요')
  expect(progress.textContent).toContain('화면을 나가도 계속돼요')
  expect(stageStates()).toEqual(['답변 확인 · 대기', '입력칸 위치 찾기 · 대기', '입력칸 기입 · 대기', '파일 저장 · 대기'])
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(stageStates()).toEqual(['답변 확인 · 완료', '입력칸 위치 찾기 · 진행 중', '입력칸 기입 · 대기', '파일 저장 · 대기'])
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(stageStates()).toEqual(['답변 확인 · 완료', '입력칸 위치 찾기 · 완료', '입력칸 기입 · 진행 중', '파일 저장 · 대기'])
  expect(screen.queryByText(/기입 \d+ \/ \d+/)).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(receiveButton()).toBeTruthy()
  expect(screen.queryByRole('status', { name: '문서 생성 진행' })).toBeNull()
  expect(screen.getByText('초안을 만들었어요')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 2, name: /^답변 버전 3 문서/ }).textContent).toMatch(/^답변 버전 3 문서 · \d{2}\.\d{2} \d{2}:\d{2} · 1개$/)
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
  expect(repository.documentJob).toHaveBeenCalledTimes(3)
  expect(repository.documentJob).toHaveBeenLastCalledWith(12, 501, expect.any(AbortSignal))
})

it('resumes a job that is already running instead of submitting another paid generation', async () => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValueOnce([]).mockResolvedValue([documentFile])
  repository.documentJobs.mockResolvedValue([generationJob({ id: 77, status: 'RUNNING', stage: 'WRITING', fileIds: [], finishedAt: null })])
  repository.documentJob.mockResolvedValue(generationJob({ id: 77 }))
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  expect(stageStates()).toContain('입력칸 기입 · 진행 중')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(receiveButton()).toBeTruthy()
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  expect(repository.documentJob).toHaveBeenCalledWith(12, 77, expect.any(AbortSignal))
})

it('keeps the previous documents downloadable while a new draft is being made', async () => {
  vi.useFakeTimers()
  const previous = { ...documentFile, id: 70, inputRevision: 2, fileName: '신청서_초안_v2.hwpx' }
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValueOnce([previous]).mockResolvedValue([previous, documentFile])
  repository.submitDocumentJob.mockResolvedValue(generationJob({ status: 'RUNNING', stage: 'MAPPING', fileIds: [], finishedAt: null }))
  repository.documentJob.mockResolvedValue(generationJob())
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  expect(screen.getByRole('status', { name: '문서 생성 진행' }).textContent).toContain('답변 버전 3로 초안을 다시 만들고 있어요')
  expect(screen.getByRole('heading', { level: 2, name: /^답변 버전 2 문서/ })).toBeTruthy()
  expect(receiveButton(previous.fileName).disabled).toBe(false)
  // 만드는 동안 머리글 동작 자리에는 버튼 없이 상태 태그만 있습니다. 경로·제목·lede는 그대로입니다.
  expect(header().getByText('초안 만드는 중')).toBeTruthy()
  expect(header().queryAllByRole('button')).toHaveLength(0)
  expect(within(screen.getByRole('navigation', { name: '상위 화면' })).getAllByRole('link').map((link) => link.textContent)).toEqual(['신청 문서 작성', '답변 입력'])
  expectLede()
  expect(screen.queryByText('답변이 바뀜')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(header().queryByText('초안 만드는 중')).toBeNull()
  expect(header().getByRole('button', { name: '내려받기' })).toBeTruthy()
  expect(screen.getByRole('heading', { level: 2, name: /^답변 버전 3 문서/ })).toBeTruthy()
  expect(screen.getByText('이전 버전 문서 1개')).toBeTruthy()
  expect(screen.getByText('초안을 만들었어요')).toBeTruthy()
})

it('follows the existing job after a submit conflict without repeating generation', async () => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValueOnce([]).mockResolvedValue([documentFile])
  repository.submitDocumentJob.mockRejectedValueOnce(new ApplicationPreparationError(409, 'APPLICATION_PREPARATION_RUN_CONFLICT'))
  repository.documentJobs.mockResolvedValueOnce([]).mockResolvedValueOnce([generationJob({ id: 78, status: 'RUNNING', stage: 'MAPPING', fileIds: [], finishedAt: null })])
  repository.documentJob.mockResolvedValue(generationJob({ id: 78 }))
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(receiveButton()).toBeTruthy()
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
  expect(repository.documentJob).toHaveBeenCalledWith(12, 78, expect.any(AbortSignal))
})

it('explains a blocked slot after an unknown outcome without starting another job', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockRejectedValueOnce(new ApplicationPreparationError(409, 'APPLICATION_PREPARATION_RUN_CONFLICT'))
  repository.documentJobs.mockResolvedValue([generationJob({ id: 79, status: 'UNKNOWN', stage: 'WRITING', fileIds: [], failureCode: 'APPLICATION_DOCUMENT_OUTCOME_UNKNOWN', failureMessage: '결과 불명' })])
  mount('/app/application-preparations/12/documents?generate=3')
  expect((await screen.findByRole('alert')).textContent).toContain('이전 문서 생성의 결과를 아직 확인하지 못해')
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
  expect(repository.documentJob).not.toHaveBeenCalled()
})

it.each(['REQUEST_TIMEOUT', 'REQUEST_FAILED', 'AI_SERVICE_INVALID_RESPONSE'])('shows %s from the submit request without polling', async (code) => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockRejectedValueOnce(new ApplicationPreparationError(502, code))
  await act(async () => { mount('/app/application-preparations/12/documents?generate=3') })
  expect(screen.getByRole('alert')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
  expect(repository.documents).toHaveBeenCalledTimes(1)
  expect(repository.documentJob).not.toHaveBeenCalled()
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
})

it('stops following a job when the results page is closed', async () => {
  vi.useFakeTimers()
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockResolvedValue(generationJob({ status: 'QUEUED', stage: null, fileIds: [], finishedAt: null }))
  let rendered!: ReturnType<typeof mount>
  await act(async () => { rendered = mount('/app/application-preparations/12/documents?generate=3') })
  rendered.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
  expect(repository.documentJob).not.toHaveBeenCalled()
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
})

it('moves to a separate results page, generates a native file and returns to saved answers', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  mount('/app/application-preparations/12')
  // [초안 만들기]는 목록의 "검토하고 초안 만들기" 링크가 여는 검토 단계에만 있습니다.
  await screen.findByLabelText('답변 입력')
  expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: '검토하고 초안 만들기' }))
  const button = screen.getByRole('button', { name: '초안 만들기' })
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  fireEvent.click(button)
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  // 경로는 "신청 문서 작성 › 답변 입력 › 신청 문서 초안"이고, 공고 맥락은 머리글 부제가 아니라 본문 첫 줄에 있습니다.
  const breadcrumbs = screen.getByRole('navigation', { name: '상위 화면' })
  expect(within(breadcrumbs).getAllByRole('link').map((link) => link.textContent)).toEqual(['신청 문서 작성', '답변 입력'])
  expect(within(breadcrumbs).getByRole('link', { name: '신청 문서 작성' }).getAttribute('href')).toBe('/app/application-preparations')
  expect(within(breadcrumbs).getByRole('link', { name: '답변 입력' }).getAttribute('href')).toBe('/app/application-preparations/12')
  expect(screen.getByRole('link', { name: '답변 입력으로 돌아가기' }).getAttribute('href')).toBe('/app/application-preparations/12')
  expect(screen.getByRole('heading', { level: 1, name: '신청 문서 초안' })).toBeTruthy()
  expect(screen.getByRole('banner').querySelector('p')).toBeNull()
  expectLede()
  expect(screen.queryByRole('link', { name: '이전으로 · 답변 수정' })).toBeNull()
  expect(screen.queryByText(/신청문서/)).toBeNull()
  expect(screen.queryByRole('region', { name: /답하지 않은 선택 항목/ })).toBeNull()
  expect(screen.queryByLabelText('답변 입력')).toBeNull()
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
  fireEvent.click(within(breadcrumbs).getByRole('link', { name: '답변 입력' }))
  expect((await screen.findByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새봄테크')
})

it('keeps [초안 만들기] out of the question steps and saves pending answers before generating from the review', async () => {
  echoReplaceInputs(detail)
  mount('/app/application-preparations/12')
  await screen.findByLabelText('답변 입력')
  expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
  expect(screen.getByText(/필수 답변 2개가 남았어요/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄테크' } })
  fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
  fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '스마트 공정 과제' } })
  // 마지막 질문에서도 [다음 →]이고, 누르면 검토 단계로 갑니다. 검토의 [초안 만들기]는 입력 중인 답변을 먼저 저장한 뒤 결과 화면으로 갑니다.
  expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
  expect(screen.getByTestId('location').textContent).toBe('/app/application-preparations/12?step=review')
  afterSwapGuard()
  fireEvent.click(screen.getByRole('button', { name: '초안 만들기' }))
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  expect(repository.replaceInputs).toHaveBeenCalledTimes(2)
  expect(repository.replaceInputs).toHaveBeenLastCalledWith(12, 'voucher-plan', { expectedRevision: 4, facts: [
    { fieldKey: 'project-title', status: 'PROVIDED', value: '스마트 공정 과제', sourceText: '과제명: 스마트 공정 과제' },
  ] }, expect.any(AbortSignal))
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 5, expect.any(AbortSignal), undefined)
})

it('reuses a stored native document on refresh without another generation call', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([documentFile])
  mount('/app/application-preparations/12/documents?generate=3')
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  expect(screen.queryByText('초안을 만들었어요')).toBeNull()
})

it('shows each file with its format, size, fill meter and folded auto-fill misses', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([{ ...documentFile, filledAnswerCount: 1, unfilledAnswerCount: 1, unfilledAnswers: [{
    fieldId: 'company-overview:consent', fieldLabel: '기업 개요 / 개인정보 동의', value: '동의함', reason: 'INPUT_LOCATION_NOT_FOUND',
  }] }])
  mount('/app/application-preparations/12/documents')
  const card = await screen.findByRole('article', { name: documentFile.fileName })
  expect(within(card).getByText('HWPX · 1 KB')).toBeTruthy()
  expect(within(card).getByText('1개 기입 · 1개 미기입')).toBeTruthy()
  expect(card.textContent).not.toContain('답변 버전')
  expect(card.textContent).not.toContain('문서에 포함된 작성 항목')
  const misses = within(card).getByText('자동 기입 못한 답변 보기 (1)').closest('details') as HTMLDetailsElement
  expect(misses.open).toBe(false)
  expect(within(card).getByLabelText('자동 기입하지 못한 답변').textContent).toContain('기업 개요 / 개인정보 동의: 동의함 — 입력 위치 확인 불가')
  expect(within(card).getByRole('button', { name: `받기: ${documentFile.fileName}` })).toBeTruthy()
})

it('offers a whole-revision archive only for several current files and folds older versions away', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([
    { ...documentFile, id: 83, inputRevision: 3, fileName: '신청서_초안_v3.hwpx' },
    { ...documentFile, id: 82, inputRevision: 3, fileName: '사업계획서_초안_v3.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { ...documentFile, id: 70, inputRevision: 2, fileName: '신청서_초안_v2.hwpx' },
  ])
  repository.downloadDocumentArchive.mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }))
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('신청 문서_초안_v3.zip')
  })
  mount('/app/application-preparations/12/documents')
  await waitFor(() => expect(receiveButton('신청서_초안_v3.hwpx')).toBeTruthy())
  expect(within(screen.getByRole('article', { name: '사업계획서_초안_v3.docx' })).getByText('DOCX · 1 KB')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 2, name: /^답변 버전 3 문서/ }).textContent).toBe('답변 버전 3 문서 · 2개')
  const older = screen.getByText('이전 버전 문서 1개').closest('details') as HTMLDetailsElement
  expect(older.open).toBe(false)
  expect(within(older).getByText('신청서_초안_v2.hwpx')).toBeTruthy()
  expect((header().getByRole('button', { name: '다시 만들기' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByText('답변이 바뀜')).toBeNull()
  expect(header().queryByRole('button', { name: '내려받기' })).toBeNull()
  fireEvent.click(header().getByRole('button', { name: '전체 내려받기' }))
  await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1))
  expect(repository.downloadDocumentArchive).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal))
  expect(repository.downloadDocument).not.toHaveBeenCalled()
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  clicked.mockRestore()
  vi.unstubAllGlobals()
})

it('downloads a single current file directly from the header instead of an archive', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([documentFile])
  repository.downloadDocument.mockResolvedValue(new Blob(['hwpx'], { type: documentFile.mediaType }))
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe(documentFile.fileName)
  })
  mount('/app/application-preparations/12/documents')
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  expect(header().queryByRole('button', { name: '전체 내려받기' })).toBeNull()
  fireEvent.click(header().getByRole('button', { name: '내려받기' }))
  await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1))
  expect(repository.downloadDocument).toHaveBeenCalledWith(12, 81, expect.any(AbortSignal))
  expect(repository.downloadDocumentArchive).not.toHaveBeenCalled()
  clicked.mockRestore()
  vi.unstubAllGlobals()
})

it('enables regeneration only after the answers changed and starts it from the header', async () => {
  const previous = { ...documentFile, inputRevision: 2 }
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([previous])
  jobSucceeds([{ ...documentFile, id: 84 }])
  mount('/app/application-preparations/12/documents')
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  const regenerate = header().getByRole('button', { name: '다시 만들기' }) as HTMLButtonElement
  expect(regenerate.disabled).toBe(false)
  expect(regenerate.title).toBe('')
  expect(header().getByText('답변이 바뀜')).toBeTruthy()
  fireEvent.click(regenerate)
  expect(await screen.findByText('초안을 만들었어요')).toBeTruthy()
  expect(screen.queryByText('답변이 바뀜')).toBeNull()
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
})

it('regenerates the document with the revised answers after returning to the input page', async () => {
  const ready = readyPreparation()
  repository.get.mockResolvedValue(ready)
  repository.documents.mockResolvedValueOnce([documentFile]).mockResolvedValue([])
  echoReplaceInputs(ready)
  jobSucceeds([{ ...documentFile, id: 82, fileName: '신청서_초안_v4.hwpx' }])
  mount('/app/application-preparations/12/documents')
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  fireEvent.click(within(screen.getByRole('navigation', { name: '상위 화면' })).getByRole('link', { name: '답변 입력' }))
  fireEvent.change(await screen.findByLabelText('답변 입력'), { target: { value: '변경한 업체명' } })
  // 초안 만들기는 입력 중인 답변을 먼저 저장하고(버전 3 → 4) 그 버전으로 결과 화면에 들어갑니다.
  fireEvent.click(screen.getByRole('link', { name: '검토하고 초안 만들기' }))
  fireEvent.click(screen.getByRole('button', { name: '초안 만들기' }))
  await screen.findByText('신청서_초안_v4.hwpx')
  expect(repository.replaceInputs).toHaveBeenCalledWith(12, 'company-overview', { expectedRevision: 3, facts: [
    { fieldKey: 'company-name', status: 'PROVIDED', value: '변경한 업체명', sourceText: '업체명: 변경한 업체명' },
  ] }, expect.any(AbortSignal))
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 4, expect.any(AbortSignal), undefined)
})

it('retries a temporary failure once with the current answers and keeps the server sentence as small detail', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockResolvedValueOnce(generationJob({ status: 'FAILED', stage: 'PREPARING', fileIds: [],
    failureCode: 'GENERATION_FAILED', failureMessage: '문서를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.' }))
  mount('/app/application-preparations/12/documents?generate=3')
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong')?.textContent).toBe('일시적인 문제로 초안을 만들지 못했어요')
  expect(alert.textContent).toContain('잠시 후 다시 시도해 주세요. 답변은 그대로 저장되어 있어요.')
  expect(within(alert).getByText('문서를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.').tagName).toBe('P')
  expect(alert.className).toContain('bg-danger-soft')
  expect(screen.queryByRole('button', { name: /받기/ })).toBeNull()
  expect(screen.queryByText('아직 만든 초안이 없어요')).toBeNull()
  fireEvent.click(within(alert).getByRole('button', { name: '다시 시도' }))
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  expect(repository.submitDocumentJob.mock.calls.map((call) => call[1])).toEqual([3, 3])
})

const editorPath = '/app/application-preparations/12'
const reanalyzePath = '/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1'
it.each([
  // (a) 양식 한계: 원문에서 양식을 받고 답변을 모아 보며 직접 작성합니다. 재분석 · 다시 시도 없음.
  ['APPLICATION_DOCUMENT_LIMIT_EXCEEDED', 'FAILED', '이 양식은 자동으로 채우기 어려워요', '다시 시도해도 결과는 같아요',
    [['원문에서 양식 받기 ↗ (새 창)', firstForm.sourceUrl], ['답변 모아 보기', `${editorPath}?step=review&helper=open`]]],
  ['APPLICATION_DOCUMENT_UNSUPPORTED', 'FAILED', '이 양식은 자동으로 채우기 어려워요', '원본 양식에 직접 옮겨 적어 주세요',
    [['원문에서 양식 받기 ↗ (새 창)', firstForm.sourceUrl], ['답변 모아 보기', `${editorPath}?step=review&helper=open`]]],
  ['APPLICATION_DOCUMENT_NO_WRITABLE_INPUT', 'FAILED', '이 양식은 자동으로 채우기 어려워요', '다시 시도해도 결과는 같아요',
    [['원문에서 양식 받기 ↗ (새 창)', firstForm.sourceUrl], ['답변 모아 보기', `${editorPath}?step=review&helper=open`]]],
  // (b) 양식 재분석 필요.
  ['APPLICATION_DOCUMENT_MAPPING_FAILED', 'FAILED', '양식을 다시 분석해야 해요', '양식을 다시 분석하면 해결될 수 있어요',
    [['양식 다시 분석해 새로 시작', reanalyzePath]]],
  ['APPLICATION_DOCUMENT_SOURCE_CHANGED', 'FAILED', '양식을 다시 분석해야 해요', '공고의 첨부 파일이 바뀌었어요. 바뀐 양식으로 다시 분석해 주세요.',
    [['양식 다시 분석해 새로 시작', reanalyzePath]]],
  // (c) 답변을 고치면 풀림.
  ['APPLICATION_DOCUMENT_INPUT_REQUIRED', 'FAILED', '저장된 답변이 없어 초안을 만들 수 없어요', '답변을 먼저 저장해 주세요',
    [['답변 입력으로', `${editorPath}?step=review`]]],
  ['APPLICATION_DOCUMENT_OVERFLOW', 'FAILED', '답변이 입력칸보다 길어요', '줄인 뒤 다시 만들어 주세요', [['답변 입력으로', editorPath]]],
  // (e) 서비스 중단 · 결과 확인 중.
  ['APPLICATION_DOCUMENT_MCP_NOT_READY', 'FAILED', '지금은 초안 만들기를 쓸 수 없어요', '다시 시도해도 해결되지 않아요', [['답변 입력으로', editorPath]]],
  ['RUN_OUTCOME_UNKNOWN', 'UNKNOWN', '초안 결과를 확인하고 있어요', '확인이 끝나면 자동으로 풀리고', []],
  ['APPLICATION_DOCUMENT_OUTCOME_UNKNOWN', 'UNKNOWN', '초안 결과를 확인하고 있어요', '같은 초안이 두 번 만들어지지 않도록', []],
] as const)('explains the %s failure by its group without a retry', async (failureCode, status, title, body, links) => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockResolvedValueOnce(generationJob({ status, stage: 'WRITING', fileIds: [], failureCode,
    failureMessage: '문서 편집을 완료하지 못했습니다. 오류 상태를 확인해 주세요.' }))
  mount('/app/application-preparations/12/documents?generate=3')
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong')?.textContent).toBe(title)
  expect(alert.textContent).toContain(body)
  expect(alert.textContent).toContain('문서 편집을 완료하지 못했습니다. 오류 상태를 확인해 주세요.')
  expect(alert.textContent).not.toContain(failureCode)
  expect(alert.className).toContain('bg-warning-soft')
  expect(within(alert).queryByRole('button', { name: '다시 시도' })).toBeNull()
  expect(within(alert).queryAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual(links)
  if (links.some(([name]) => name.startsWith('원문에서'))) {
    expect(within(alert).getByRole('link', { name: /원문에서 양식 받기/ }).getAttribute('target')).toBe('_blank')
  }
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
})

it('treats an unknown failure code as a temporary problem that can be retried', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockResolvedValueOnce(generationJob({ status: 'FAILED', stage: 'WRITING', fileIds: [],
    failureCode: 'APPLICATION_DOCUMENT_SOMETHING_NEW', failureMessage: null }))
  mount('/app/application-preparations/12/documents?generate=3')
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong')?.textContent).toBe('일시적인 문제로 초안을 만들지 못했어요')
  expect(within(alert).getByRole('button', { name: '다시 시도' })).toBeTruthy()
})

it('forgets the requested revision after a failed job so coming back does not submit again', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockResolvedValueOnce(generationJob({ status: 'FAILED', stage: 'MAPPING', fileIds: [],
    failureCode: 'APPLICATION_DOCUMENT_LIMIT_EXCEEDED', failureMessage: null }))
  const first = mount('/app/application-preparations/12/documents?generate=3')
  await screen.findByRole('alert')
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
  // 주소에서 ?generate=가 지워져, 같은 주소로 다시 들어와도 제출하지 않습니다.
  const address = screen.getByTestId('location').textContent!
  expect(address).toBe('/app/application-preparations/12/documents')
  first.unmount()
  mount(address)
  expect(await screen.findByRole('heading', { name: '아직 만든 초안이 없어요' })).toBeTruthy()
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
})

it('shows the saved form-limit failure again on a later visit without offering to generate', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([{ ...documentFile, id: 70, inputRevision: 2, fileName: '신청서_초안_v2.hwpx' }])
  repository.documentJobs.mockResolvedValue([
    generationJob({ id: 9, status: 'FAILED', stage: 'MAPPING', fileIds: [], failureCode: 'APPLICATION_DOCUMENT_LIMIT_EXCEEDED', failureMessage: null }),
    generationJob({ id: 4, expectedRevision: 2, fileIds: [70] }),
  ])
  mount('/app/application-preparations/12/documents')
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong')?.textContent).toBe('이 양식은 자동으로 채우기 어려워요')
  expect(within(alert).getByRole('link', { name: /원문에서 양식 받기/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
  expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
  expect(screen.queryByText('아직 만든 초안이 없어요')).toBeNull()
  // 앞선 답변 버전의 문서는 카드 아래에 그대로 받을 수 있고, 같은 답변으로 다시 만드는 버튼은 꺼 둡니다.
  expect(receiveButton('신청서_초안_v2.hwpx')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '다시 만들기' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
})

it('shows the checking card again for an unknown outcome of the current answers', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documentJobs.mockResolvedValue([generationJob({ id: 9, status: 'UNKNOWN', stage: 'WRITING', fileIds: [],
    failureCode: 'APPLICATION_DOCUMENT_OUTCOME_UNKNOWN', failureMessage: null })])
  mount('/app/application-preparations/12/documents')
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong')?.textContent).toBe('초안 결과를 확인하고 있어요')
  expect(within(alert).queryAllByRole('button')).toHaveLength(0)
  expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
})

it('offers a retry that submits for a saved temporary failure of the current answers', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documentJobs.mockResolvedValue([generationJob({ id: 9, status: 'FAILED', stage: 'WRITING', fileIds: [],
    failureCode: 'APPLICATION_DOCUMENT_PLAN_TIMEOUT', failureMessage: null })])
  mount('/app/application-preparations/12/documents')
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong')?.textContent).toBe('일시적인 문제로 초안을 만들지 못했어요')
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  fireEvent.click(within(alert).getByRole('button', { name: '다시 시도' }))
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
})

it('keeps the empty state when the last failure belongs to answers that have changed since', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documentJobs.mockResolvedValue([generationJob({ id: 9, expectedRevision: 2, status: 'FAILED', stage: 'MAPPING', fileIds: [],
    failureCode: 'APPLICATION_DOCUMENT_LIMIT_EXCEEDED', failureMessage: null })])
  mount('/app/application-preparations/12/documents')
  expect(await screen.findByRole('heading', { name: '아직 만든 초안이 없어요' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: '초안 만들기' })).toBeTruthy()
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
})

it('explains the three-job limit at submit time and submits again only on retry', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockRejectedValueOnce(new ApplicationPreparationError(429, 'APPLICATION_DOCUMENT_JOB_CAPACITY'))
  mount('/app/application-preparations/12/documents?generate=3')
  const alert = await screen.findByRole('alert')
  expect(alert.querySelector('strong')?.textContent).toBe('진행 중인 초안 만들기가 3건이에요')
  expect(alert.textContent).toContain('계정당 동시에 3건까지 만들 수 있어요')
  expect(alert.textContent).not.toContain('신청 준비 정보를 처리하지 못했습니다')
  expect(within(alert).getByRole('link', { name: '목록으로' }).getAttribute('href')).toBe('/app/application-preparations')
  expect(screen.queryByText('아직 만든 초안이 없어요')).toBeNull()
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
  fireEvent.click(within(alert).getByRole('button', { name: '다시 시도' }))
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  expect(repository.submitDocumentJob.mock.calls.map((call) => call[1])).toEqual([3, 3])
  expect(new ApplicationPreparationError(429, 'APPLICATION_DOCUMENT_JOB_CAPACITY').message)
    .toBe('진행 중인 초안 만들기가 3건이에요. 끝난 뒤 다시 시도해 주세요.')
})

it('shows the empty state and makes the first draft from the current answers on click', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  mount('/app/application-preparations/12/documents')
  expect(await screen.findByRole('heading', { name: '아직 만든 초안이 없어요' })).toBeTruthy()
  expectLede()
  expect(header().queryByRole('button', { name: '다시 만들기' })).toBeNull()
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '초안 만들기' }))
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  expect(screen.queryByText('아직 만든 초안이 없어요')).toBeNull()
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
})

it('keeps the header and explains an invalid document address with a way back to the list', () => {
  mount('/app/application-preparations/not-a-number/documents')
  expect(screen.getByRole('heading', { level: 1, name: '신청 문서 초안' })).toBeTruthy()
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain('문서 주소가 올바르지 않아요')
  expect(within(alert).getByRole('link', { name: '목록으로' }).getAttribute('href')).toBe('/app/application-preparations')
  expect(repository.get).not.toHaveBeenCalled()
})

const migrationNotice = {
  status: 'MAPPING_CHANGED' as const, approvalToken: '12345678-1234-1234-1234-123456789abc',
  expectedRevision: 3, expiresInSeconds: 900,
  changes: [{ fieldLabel: '기업 개요 · 업체명', changeType: 'TARGET_CHANGED' as const,
    oldLocation: '표 1 · 2행 · 기업명', newLocation: '표 2 · 3행 · 기업명' }],
}
const migrationBlockedJob = () => generationJob({ status: 'FAILED', stage: 'MAPPING', fileIds: [],
  failureCode: 'APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED', failureMessage: '입력 위치가 변경됐습니다.', mappingMigration: migrationNotice })

it('shows the mapping diff and keeps the old file when approval is cancelled', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([{ ...documentFile, inputRevision: 2 }])
  repository.submitDocumentJob.mockResolvedValueOnce(migrationBlockedJob())
  mount('/app/application-preparations/12/documents?generate=3')
  const review = await screen.findByLabelText('신청서 입력 위치 변경 확인')
  expect(within(review).getByText(/표 1 · 2행/)).toBeTruthy()
  expect(within(review).getByText(/표 2 · 3행/)).toBeTruthy()
  expect(review.textContent).not.toContain('t1.r1')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(receiveButton()).toBeTruthy()
  fireEvent.click(within(review).getByRole('button', { name: '취소하고 기존 작성 유지' }))
  expect(repository.confirmDocumentMappingMigration).not.toHaveBeenCalled()
  expect(await screen.findByText(/기존 답변과 파일은 그대로 유지됩니다/)).toBeTruthy()
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
})

it('applies the reviewed map only on approval and starts regeneration on a separate click', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([{ ...documentFile, inputRevision: 2 }])
  repository.submitDocumentJob.mockResolvedValueOnce(migrationBlockedJob())
  repository.confirmDocumentMappingMigration.mockResolvedValue({ status: 'REGENERATION_REQUIRED',
    preparationId: 12, inputRevision: 3, formVersionId: 'approved-form-v2' })
  mount('/app/application-preparations/12/documents?generate=3')
  const review = await screen.findByLabelText('신청서 입력 위치 변경 확인')
  fireEvent.click(within(review).getByRole('button', { name: '새 입력 위치 적용' }))
  expect(await screen.findByText(/새 입력 위치가 이 작성본에만 적용됐습니다/)).toBeTruthy()
  expect(repository.confirmDocumentMappingMigration).toHaveBeenCalledWith(12, 3,
    migrationNotice.approvalToken, expect.any(AbortSignal))
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(1)
  jobSucceeds([{ ...documentFile, id: 82, fileName: '신청서_초안_v3_new.hwpx' }])
  fireEvent.click(screen.getByRole('button', { name: '새 초안 생성' }))
  expect(await screen.findByText('신청서_초안_v3_new.hwpx')).toBeTruthy()
  expect(repository.submitDocumentJob).toHaveBeenCalledTimes(2)
})

it('prevents generating with a stale revision and aborts requests after leaving', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  const { unmount } = mount('/app/application-preparations/12/documents?generate=2')
  expect((await screen.findByRole('alert')).textContent).toContain('답변이 변경')
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
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
  await waitFor(() => expect(receiveButton()).toBeTruthy())
  fireEvent.click(receiveButton())
  await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(receiveButton().disabled).toBe(false))
  fireEvent.click(receiveButton())
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

it('sums up unanswered fields in one alert that opens the first one in the editor', async () => {
  const ready = readyPreparation()
  ready.form.sections[1].facts[0].status = 'UNKNOWN'
  ready.form.sections[1].facts[0].value = null
  repository.get.mockResolvedValue(ready)
  repository.documents.mockResolvedValue([documentFile])
  mount('/app/application-preparations/12/documents')
  const report = await screen.findByRole('region', { name: '답하지 않은 선택 항목 1개' })
  expect(report.textContent).toContain('바우처 활용 계획 · 과제명 — 문서에 빈칸으로 남아요.')
  expect(report.textContent).not.toContain('기업 개요 · 업체명')
  expect(within(report).queryByRole('listitem')).toBeNull()
  const link = within(report).getByRole('link', { name: '답변 입력으로' })
  expect(link.getAttribute('href')).toBe('/app/application-preparations/12?question=project-title')
  fireEvent.click(link)
  expect(await screen.findByText('바우처 활용 계획 · 질문 2 / 2')).toBeTruthy()
})

it('shows a partial answer count even when the server confirms all required fields', async () => {
  const ready = readyPreparation()
  ready.form.sections[0].fields.push({ key: 'position', label: '직위', guidance: '직위만 입력', required: false })
  repository.get.mockResolvedValue(ready)
  mount('/app/application-preparations/12')
  await screen.findByRole('heading', { name: '답변 입력' })
  expect(sectionRow('기업 개요').textContent).toContain('답변 1 / 2')
  expect(sectionRow('기업 개요').textContent).toContain('진행 중')
  expect(screen.queryByText('사실 확인됨')).toBeNull()
})

it('starts reanalysis only on an explicit click and preserves existing preparations', async () => {
  mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
  await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
  const button = screen.getByRole('button', { name: '입력칸별로 다시 분석' })
  expect(repository.discover).not.toHaveBeenCalled()
  fireEvent.click(button)
  // 끝나면 ②에 양식 카드를 다시 두고 토스트로 알리며, 분석이 남긴 경고를 요약 카드에 보여 줍니다.
  expect(await screen.findByText('양식을 다시 분석했어요')).toBeTruthy()
  expect(screen.getByText('원문 대조 필요')).toBeTruthy()
  expect(screen.getByRole('heading', { name: '작성할 양식' })).toBeTruthy()
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
  repository.onlineInputGuide.mockResolvedValue({ preparationId: 12, inputRevision: 3, totalCount: 0,
    readyCount: 0, needsReviewCount: 0, missingCount: 0, directInputCount: 0,
    externalMappingVerified: false, officialApplicationUrl: null, items: [], savedAnswers: [] })
  repository.documents.mockResolvedValue([])
  repository.documentJobs.mockResolvedValue([])
  jobSucceeds([documentFile])
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
    ...structuredClone(supportProgramDetails[0]),
    sourceCode: identity.sourceCode,
    id: identity.sourceProgramId,
    evidenceQuestionSupported: identity.sourceCode === 'BIZINFO',
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  appContainer.register({
    applicationPreparationUseCase: asValue(original),
    browseSupportProgramsUseCase: asValue(originalCatalog),
    browseSavedSupportProgramsUseCase: asValue(originalSavedPrograms),
    getSupportProgramDetailUseCase: asValue(originalProgramDetail),
  })
})

/** 현재 주소를 읽기 위한 숨은 표시입니다. 새 문서 화면이 고른 공고를 주소에 적는지 확인합니다. */
function LocationProbe() {
  const location = useLocation()
  return <span hidden data-testid="location">{location.pathname + location.search}</span>
}

/** 왼쪽 항목 목록에서 항목 행 버튼을 찾습니다. */
function sectionRow(title: string) {
  return within(screen.getByRole('complementary', { name: '작성 항목' })).getByRole('button', { name: new RegExp(title) })
}

function mount(path: string) {
  const store = createAppStore()
  store.dispatch(signedIn({ email: 'owner@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, accountType: null, onboarded: true, company: null }))
  const rendered = render(<Provider store={store}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/app/application-preparations" element={<ApplicationPreparationListPage />} />
    <Route path="/app/application-preparations/:preparationId/documents" element={<ApplicationDocumentPage />} />
    <Route path="/app/application-preparations/new" element={<ApplicationPreparationNewPage />} />
    <Route path="/app/application-preparations/:preparationId" element={<ApplicationPreparationEditorPage />} />
  </Routes><LocationProbe /></MemoryRouter></Provider>)
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
    expect(repository.list.mock.calls[1]?.[0]).toEqual({ beforeId: 12 })
  })

  it('aborts the previous account request and ignores its late response', async () => {
    const firstRequest = deferred<ApplicationPreparationPage>()
    const secondRequest = deferred<ApplicationPreparationPage>()
    repository.list.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(secondRequest.promise)
    const { store } = mount('/app/application-preparations')
    const firstSignal = repository.list.mock.calls[0]?.[1] as AbortSignal

    act(() => {
      store.dispatch(signedIn({ email: 'next@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, accountType: null, onboarded: true, company: null }))
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

    // 삭제는 카드의 [⋯] 메뉴 안에만 있고, 카드에 빨간 버튼을 두지 않는다.
    expect(screen.queryByRole('button', { name: '삭제' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `문서 메뉴: ${firstForm.programTitle}` }))
    const menu = screen.getByRole('menu', { name: '문서 메뉴' })
    expect(within(menu).getByRole('menuitem', { name: '공고 보기' }).getAttribute('href')).toBe(supportProgramDetailPath({ sourceCode: firstForm.sourceCode, sourceProgramId: firstForm.sourceProgramId }, true))
    fireEvent.click(within(menu).getByRole('menuitem', { name: '삭제' }))
    const confirmation = screen.getByRole('dialog', { name: '신청 문서를 삭제할까요?' })
    expect(confirmation.textContent).toContain('AI 실행 기록')
    expect(repository.delete).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '삭제' }))

    expect(repository.delete).toHaveBeenCalledWith(12, expect.any(AbortSignal))
    expect(await screen.findByRole('heading', { name: '아직 시작한 신청 문서가 없습니다.' })).toBeTruthy()
    expect(screen.queryByText(firstForm.programTitle)).toBeNull()
    expect(screen.getByText('삭제했어요.')).toBeTruthy()
  })

  it('filters by status through the address and shows answer progress, deadline and the document link', async () => {
    const soon = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(Date.now() + 3 * 86_400_000))
    repository.list.mockResolvedValue({
      items: [
        { id: 12, inputRevision: 3, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
          sourceCode: firstForm.sourceCode, sourceProgramId: firstForm.sourceProgramId, serviceField: 'TECHNICAL_SUPPORT',
          programTitle: firstForm.programTitle, formTitle: firstForm.formTitle, updatedAt: detail.updatedAt,
          answeredRequired: 11, requiredTotal: 11, hasCurrentDocument: true, applicationPeriod: '2026-09-01 ~ 2026-10-03', applicationEndDate: soon },
        { id: 11, inputRevision: 1, progressStage: 'PREPARING', progressRevision: 1, progressStageUpdatedAt: detail.updatedAt,
          sourceCode: secondForm.sourceCode, sourceProgramId: secondForm.sourceProgramId, serviceField: 'MARKETING',
          programTitle: secondForm.programTitle, formTitle: secondForm.formTitle, updatedAt: detail.updatedAt,
          answeredRequired: 2, requiredTotal: 9, hasCurrentDocument: false, applicationPeriod: null, applicationEndDate: null },
      ],
      nextBeforeId: null,
    })
    mount('/app/application-preparations?status=done')

    await screen.findByText(firstForm.programTitle)
    expect(repository.list.mock.calls[0]?.[0]).toEqual({ status: 'done' })
    // 상태 필터는 관심 공고함과 같은 머리글 세그먼트(tablist)이고, 초록 채움은 [새 문서] 하나뿐입니다.
    const filter = within(screen.getByRole('banner')).getByRole('tablist', { name: '작성 상태 필터' })
    expect(within(filter).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]))
      .toEqual([['전체', 'false'], ['진행 중', 'false'], ['완료', 'true']])
    expect(screen.getByRole('banner').querySelector('p')).toBeNull()
    expect(screen.getByText('D-3')).toBeTruthy()
    // 답변 진행은 모든 카드에 보이고, 완료 카드는 날짜 자리에 "초안 있음"을 덧붙인다.
    expect(screen.getByText('필수 답변 11 / 11')).toBeTruthy()
    expect(screen.getByText(/^초안 있음 · \d{2}\.\d{2}$/)).toBeTruthy()
    expect(screen.getByText('필수 답변 2 / 9')).toBeTruthy()
    expect(screen.getByText('완료', { selector: 'span' })).toBeTruthy()
    expect(screen.getByText('진행 중', { selector: 'span' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '문서 보기' }).getAttribute('href')).toBe('/app/application-preparations/12/documents')
    expect(screen.getByRole('link', { name: '이어서 작성' }).getAttribute('href')).toBe('/app/application-preparations/11')
    fireEvent.click(screen.getByRole('tab', { name: '진행 중' }))
    await waitFor(() => expect(repository.list.mock.calls[1]?.[0]).toEqual({ status: 'in_progress' }))
    expect(screen.getByRole('tab', { name: '진행 중' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: '전체' }))
    await waitFor(() => expect(repository.list.mock.calls[2]?.[0]).toEqual({}))
  })
})

describe('application preparation creation and detail', () => {
  const newPath = '/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1'
  const availabilityOf = (status: string, reasonCode: string, items: ApplicationForm[] = []) => ({ state: { sourceCode: 'BIZINFO',
    sourceProgramId: 'PBLN_1', status, reasonCode, nextRetryAt: null, attemptCount: 1 }, forms: { items } })
  const startButton = () => screen.getByRole('button', { name: '작성 시작' }) as HTMLButtonElement
  /** ① 공고 · ② 양식 · 분야 섹션입니다. 번호는 화면 낭독에서 빼고 제목만 이름으로 씁니다. */
  const programSection = () => screen.getByRole('region', { name: '공고' })
  const formSection = () => screen.getByRole('region', { name: '양식 · 분야' })
  /** [작성 시작]을 못 누르는 이유 줄입니다. 버튼이 aria-describedby로 가리킵니다. */
  const startReason = () => document.getElementById(startButton().getAttribute('aria-describedby') ?? '')?.textContent ?? null
  const follows = (earlier: Node, later: Node) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('loads the program from the address with ① filled and ② open, and creates the preparation from the end of the page', async () => {
    mount(newPath)
    expect(screen.getByRole('heading', { name: '새 문서' })).toBeTruthy()
    const crumbs = screen.getByRole('navigation', { name: '상위 화면' })
    expect(within(crumbs).getByRole('link', { name: '신청 문서 작성' }).getAttribute('href')).toBe('/app/application-preparations')
    expect(screen.getByRole('banner').querySelector('p')).toBeNull()
    expect(screen.getByText('공고를 고르면 저장된 신청 양식이 있는지 바로 확인해요')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('공고를 불러오는 중입니다.')
    // 단계 표시와 위쪽 [취소][다음] 줄은 없고, 공고가 정해지기 전에는 [작성 시작]도 그리지 않습니다.
    expect(screen.queryByRole('list', { name: '새 문서 단계' })).toBeNull()
    expect(screen.queryByRole('button', { name: /다음/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '작성 시작' })).toBeNull()

    const found = await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    expect(found.parentElement?.textContent).toContain('아래 ②에서 양식을 확인하고 작성을 시작해 주세요.')
    expect(repository.availability).toHaveBeenCalledWith('BIZINFO', 'PBLN_1', expect.any(AbortSignal))
    const card = programSection()
    expect(within(card).getByText(supportProgramDetails[0].title)).toBeTruthy()
    expect(within(card).getByText('기업마당')).toBeTruthy()
    const source = within(card).getByRole('link', { name: /원문 보기/ })
    expect(source.getAttribute('href')).toBe(supportProgramDetails[0].sourceUrl)
    expect(source.getAttribute('rel')).toBe('noreferrer')
    expect(source.getAttribute('target')).toBe('_blank')

    // ②가 열린 채 들어옵니다. 양식이 하나면 고를 것 없이 이름만, 신청 분야는 "일반 신청" 하나가 아니므로 드롭다운으로 고릅니다.
    const form = formSection()
    expect(within(form).getByRole('heading', { name: '작성할 양식' })).toBeTruthy()
    expect(within(form).queryByRole('radio', { name: new RegExp(firstForm.formTitle) })).toBeNull()
    // 공고명과 원문 링크는 ①에만 있습니다. ②에는 양식 이름과 면책 문구만 둡니다.
    expect(within(form).queryByText(firstForm.programTitle)).toBeNull()
    expect(within(form).queryByRole('link', { name: /원문 보기/ })).toBeNull()
    expect(within(form).getByRole('region', { name: '양식 안내' }).textContent).toContain('기관 검수나 선정 가능성을 뜻하지 않으며')
    const field = within(form).getByRole('combobox', { name: '신청 분야' })
    expect(selectedValue(field)).toBe('CONSULTING')
    chooseOption(field, 'MARKETING')

    // 동작은 내용 끝에 있고, DOM · 탭 순서는 내용 → [취소] → [작성 시작]입니다.
    const cancel = screen.getByRole('link', { name: '취소' })
    expect(cancel.getAttribute('href')).toBe('/app/application-preparations')
    expect(follows(form, cancel)).toBe(true)
    expect(follows(cancel, startButton())).toBe(true)
    expect(startButton().disabled).toBe(false)
    expect(startButton().getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(startButton())
    expect(await screen.findByRole('heading', { name: '답변 입력' })).toBeTruthy()
    expect(repository.create).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1',
      formVersionId: firstForm.formVersionId, serviceField: 'MARKETING' }, expect.any(AbortSignal))
    expect(repository.availability).toHaveBeenCalledTimes(1)
    expect(repository.discover).not.toHaveBeenCalled()
    expect(repository.discoveryJob).not.toHaveBeenCalled()
  })

  it('retries a failed program detail and a failed availability lookup, keeping writing closed meanwhile', async () => {
    getProgramDetail.mockRejectedValueOnce(new Error('공고 상세를 불러오지 못했습니다.'))
    const request = deferred<never>()
    repository.availability.mockReturnValueOnce(request.promise)
    mount(newPath)
    const detailAlert = await within(programSection()).findByRole('alert')
    expect(detailAlert.textContent).toContain('공고 상세를 불러오지 못했습니다.')
    expect(screen.queryByRole('button', { name: '작성 시작' })).toBeNull()
    fireEvent.click(within(detailAlert).getByRole('button', { name: '다시 시도' }))
    await screen.findByText(supportProgramDetails[0].title)
    expect(within(formSection()).getByRole('status').textContent).toContain('저장된 신청 양식을 확인하고 있어요.')
    expect(startButton().disabled).toBe(true)
    await act(async () => request.reject(new ApplicationPreparationError(504, 'REQUEST_TIMEOUT')))
    const lookupAlert = await within(formSection()).findByRole('alert')
    expect(lookupAlert.textContent).toContain('신청 준비 요청 시간이 초과되었습니다.')
    expect(startButton().disabled).toBe(true)
    expect(startReason()).toBe('저장된 양식을 확인하면 시작할 수 있어요')
    fireEvent.click(within(lookupAlert).getByRole('button', { name: '다시 시도' }))
    await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    expect(startButton().disabled).toBe(false)
    expect(repository.availability).toHaveBeenCalledTimes(2)
    expect(repository.discover).not.toHaveBeenCalled()
  })

  it('starts empty with one pick button, picks in the panel without AI and moves focus to ② on confirm', async () => {
    browseSavedPrograms.mockResolvedValue([{ savedAt: detail.createdAt, program: structuredClone(supportPrograms[0]) }])
    mount('/app/application-preparations/new')
    expect(screen.getByText('신청 문서를 만들 공고를 골라 주세요')).toBeTruthy()
    // 빈 상태의 동작은 [공고 고르기] 하나입니다. [취소][작성 시작] 줄은 아직 없고, ②는 흐린 제목만 보입니다.
    const main = screen.getByRole('main')
    expect(within(main).getAllByRole('button').map((button) => button.textContent)).toEqual(['공고 고르기'])
    expect(within(main).queryByRole('link', { name: '취소' })).toBeNull()
    expect(screen.queryByRole('button', { name: '작성 시작' })).toBeNull()
    expect(screen.getByRole('heading', { name: /양식 · 분야/ }).textContent).toContain('공고를 고르면 열려요')
    const pickButton = screen.getByRole('button', { name: '공고 고르기' })
    fireEvent.click(pickButton)
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(within(panel).getByText('신청 문서를 만들 공고 1개를 골라 주세요')).toBeTruthy()
    // 처음 포커스는 [✕]가 아니라 고른 탭입니다.
    expect(document.activeElement).toBe(within(panel).getByRole('tab', { name: '관심 공고함' }))
    const row = await within(panel).findByRole('radio', { name: new RegExp(supportPrograms[0].title) })
    expect(within(panel).getByRole('tab', { name: '관심 공고함' }).getAttribute('aria-selected')).toBe('true')
    expect((within(panel).getByRole('button', { name: '이 공고 선택' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(row)
    expect(await within(panel).findByText('양식 1개 · 바로 작성할 수 있어요')).toBeTruthy()
    expect(repository.availability).toHaveBeenCalledWith(supportPrograms[0].sourceCode, supportPrograms[0].id, expect.any(AbortSignal))

    fireEvent.click(within(panel).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    expect(screen.getByText('신청 문서를 만들 공고를 골라 주세요')).toBeTruthy()
    expect(document.activeElement).toBe(pickButton)

    fireEvent.click(pickButton)
    fireEvent.keyDown(screen.getByRole('dialog', { name: '공고 고르기' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    expect(document.activeElement).toBe(pickButton)

    // 패널 안을 누르면 그대로, 뒤를 덮은 흐린 배경을 누르면 버리고 닫습니다.
    fireEvent.click(pickButton)
    const dimmed = screen.getByRole('dialog', { name: '공고 고르기' })
    fireEvent.mouseDown(dimmed)
    expect(screen.getByRole('dialog', { name: '공고 고르기' })).toBeTruthy()
    fireEvent.mouseDown(dimmed.parentElement!)
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    expect(document.activeElement).toBe(pickButton)

    fireEvent.click(pickButton)
    const reopened = screen.getByRole('dialog', { name: '공고 고르기' })
    fireEvent.click(await within(reopened).findByRole('radio', { name: new RegExp(supportPrograms[0].title) }))
    await within(reopened).findByText('양식 1개 · 바로 작성할 수 있어요')
    fireEvent.click(within(reopened).getByRole('button', { name: '이 공고 선택' }))
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    const card = programSection()
    expect(within(card).getByText(supportPrograms[0].title)).toBeTruthy()
    expect(within(card).getByText('작성할 수 있는 신청 양식 1개를 찾았어요')).toBeTruthy()
    expect(within(card).getByRole('button', { name: '공고 바꾸기' })).toBeTruthy()
    // 고르면 ②가 열리고 포커스가 ② 제목으로 옮겨 가 이어서 앞으로 진행합니다.
    const formHeading = screen.getByRole('heading', { name: '양식 · 분야' })
    expect(document.activeElement).toBe(formHeading)
    expect(within(formSection()).getByRole('heading', { name: '작성할 양식' })).toBeTruthy()
    expect(startButton().disabled).toBe(false)
    // 고른 공고를 주소에 적어 새로고침·재방문 때 같은 공고(와 진행 중인 분석)로 돌아옵니다. 다시 불러오지는 않습니다.
    expect(screen.getByTestId('location').textContent).toBe(`/app/application-preparations/new?sourceCode=${supportPrograms[0].sourceCode}&sourceProgramId=${supportPrograms[0].id}`)
    expect(getProgramDetail).not.toHaveBeenCalled()
    // 패널에서 조회한 결과를 그대로 씁니다(두 번 조회했지만 모두 행을 고를 때뿐).
    expect(repository.availability).toHaveBeenCalledTimes(2)
    expect(repository.discover).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('lists running analyses when opened without a program and resumes one through its link without calling discover', async () => {
    repository.availability.mockResolvedValue(availabilityOf('PENDING', 'NOT_ANALYZED'))
    const running = { ...completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false }), status: 'RUNNING' as const, result: null }
    repository.discoveryJobs.mockResolvedValue([running, { ...running, id: 78, status: 'UNKNOWN' as const, programTitle: '확인 필요 공고' }])
    repository.discoveryJob.mockReturnValue(new Promise(() => {}))
    mount('/app/application-preparations/new')
    const alert = (await screen.findByText('분석 중인 공고가 있어요')).closest('[role="status"]') as HTMLElement
    const rows = within(alert).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain(firstForm.programTitle)
    expect(rows[0].textContent).toContain('분석 중')
    const link = within(rows[0]).getByRole('link', { name: /이어서 보기/ })
    expect(link.getAttribute('href')).toBe('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
    fireEvent.click(link)
    const progress = await screen.findByRole('status', { name: '양식 분석 진행' })
    expect(formSection().contains(progress)).toBe(true)
    expect(progress.textContent).toContain('화면을 나가도 계속돼요')
    expect(startButton().disabled).toBe(true)
    expect(startReason()).toBe('분석이 끝나면 시작할 수 있어요')
    expect(screen.queryByText('분석 중인 공고가 있어요')).toBeNull()
    expect(getProgramDetail).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1' }, expect.any(AbortSignal))
    expect(repository.discover).not.toHaveBeenCalled()
  })

  it('marks the program from the address in the panel and keeps its known availability', async () => {
    browseSavedPrograms.mockResolvedValue([{ savedAt: detail.createdAt, program: { ...structuredClone(supportPrograms[0]), id: 'PBLN_1' } }])
    mount(newPath)
    await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    fireEvent.click(screen.getByRole('button', { name: '공고 바꾸기' }))
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    const row = await within(panel).findByRole('radio', { name: /지금 공고/ })
    expect((row as HTMLInputElement).checked).toBe(true)
    expect(within(panel).getByText('양식 1개 · 바로 작성할 수 있어요')).toBeTruthy()
    expect((within(panel).getByRole('button', { name: '이 공고 선택' }) as HTMLButtonElement).disabled).toBe(false)
    expect(repository.availability).toHaveBeenCalledTimes(1)
  })

  it('opens the full search when the saved list is empty, filters with chips and appends more results', async () => {
    const page = (number: number) => ({
      programs: [{ ...structuredClone(supportPrograms[number - 1]), id: `PBLN_${number}0` }], total: 2, page: number, pageSize: 10, totalPages: 2,
      regions: ['서울'], categories: [], startupStages: [], applicantTypes: [], founderAges: [],
    })
    browsePrograms.mockImplementation(async (query: { page: number }) => page(query.page))
    mount('/app/application-preparations/new')
    fireEvent.click(screen.getByRole('button', { name: '공고 고르기' }))
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    await waitFor(() => expect(within(panel).getByRole('tab', { name: '전체 검색' }).getAttribute('aria-selected')).toBe('true'))
    // 관심 공고함이 비어 전체 검색으로 넘어가면 포커스도 검색칸으로 옮깁니다.
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole('searchbox', { name: '공고명·기관명' })))
    await within(panel).findByRole('radio', { name: new RegExp(supportPrograms[0].title) })
    expect(browsePrograms.mock.calls[0][0]).toMatchObject({ keyword: '', status: 'ALL', page: 1 })

    fireEvent.click(within(panel).getByRole('button', { name: '더 보기' }))
    await within(panel).findByRole('radio', { name: new RegExp(supportPrograms[1].title) })
    expect(within(panel).getByRole('radio', { name: new RegExp(supportPrograms[0].title) })).toBeTruthy()
    expect(browsePrograms.mock.calls[1][0]).toMatchObject({ page: 2 })
    expect(within(panel).queryByRole('button', { name: '더 보기' })).toBeNull()

    fireEvent.change(within(panel).getByRole('searchbox', { name: '공고명·기관명' }), { target: { value: '  AI  ' } })
    fireEvent.keyDown(within(panel).getByRole('searchbox', { name: '공고명·기관명' }), { key: 'Enter' })
    await waitFor(() => expect(browsePrograms).toHaveBeenCalledTimes(3))
    expect(browsePrograms.mock.calls[2][0]).toMatchObject({ keyword: 'AI', page: 1 })
    // 네 필터 모두 칸 위에 같은 모양의 이름표를 두고, 칸에는 고른 값(없으면 "전체")을 보여 줍니다.
    fireEvent.click(within(panel).getByRole('button', { name: '필터 (0)' }))
    const filters = within(panel).getByRole('group', { name: '공고 검색 필터' })
    expect(Array.from(filters.children).filter((child) => child.tagName === 'DIV').map((child) => child.firstElementChild?.textContent))
      .toEqual(['지역', '지원 분야', '출처', '접수 상태'])
    expect(within(filters).getByRole('button', { name: '지역' }).textContent).toContain('전체')
    // 필터 칸은 고르는 중인 값만 바꾸고, [검색]을 눌러야 적용됩니다. 지역·분야는 여러 개를 쉼표로 이어 보냅니다.
    fireEvent.click(within(panel).getByRole('button', { name: '지역' }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: '서울' }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: '부산' }))
    expect(within(filters).getByRole('button', { name: '지역' }).textContent).toContain('서울 외 1')
    chooseOption(within(panel).getByRole('combobox', { name: '출처' }), 'BIZINFO')
    expect(browsePrograms).toHaveBeenCalledTimes(3)
    expect(within(panel).getByRole('button', { name: '필터 (0)' })).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: '지역 · 서울 조건 해제' })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: '검색' }))
    await waitFor(() => expect(browsePrograms).toHaveBeenCalledTimes(4))
    expect(browsePrograms.mock.calls[3][0]).toMatchObject({ keyword: 'AI', region: '서울,부산', sourceCode: 'BIZINFO', page: 1 })
    expect(await within(panel).findByRole('button', { name: '필터 (3)' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '지역 · 부산 조건 해제' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '출처 · 기업마당 조건 해제' })).toBeTruthy()
    // 칩 해제와 필터 초기화는 누르는 즉시 적용합니다.
    fireEvent.click(within(panel).getByRole('button', { name: '지역 · 서울 조건 해제' }))
    await waitFor(() => expect(browsePrograms).toHaveBeenCalledTimes(5))
    expect(browsePrograms.mock.calls[4][0]).toMatchObject({ keyword: 'AI', region: '부산', sourceCode: 'BIZINFO' })
    expect(await within(panel).findByRole('button', { name: '필터 (2)' })).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: '지역 · 서울 조건 해제' })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: '필터 초기화' }))
    await waitFor(() => expect(browsePrograms).toHaveBeenCalledTimes(6))
    expect(browsePrograms.mock.calls[5][0]).toMatchObject({ keyword: 'AI', region: '', category: '', sourceCode: '', status: 'ALL' })
    expect(await within(panel).findByRole('button', { name: '필터 (0)' })).toBeTruthy()

    fireEvent.click(within(panel).getByRole('tab', { name: '관심 공고함' }))
    expect(within(panel).getByText('관심 공고함이 비어 있어요')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '전체 검색' }))
    expect(within(panel).getByRole('tab', { name: '전체 검색' }).getAttribute('aria-selected')).toBe('true')
    expect(repository.availability).not.toHaveBeenCalled()
  })

  it('shows retry states for failed panel lists and a failed row lookup', async () => {
    browseSavedPrograms.mockRejectedValueOnce(new Error('saved failed')).mockResolvedValue([{ savedAt: detail.createdAt, program: structuredClone(supportPrograms[0]) }])
    repository.availability.mockRejectedValueOnce(new ApplicationPreparationError(504, 'REQUEST_TIMEOUT'))
    mount('/app/application-preparations/new')
    fireEvent.click(screen.getByRole('button', { name: '공고 고르기' }))
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    const listError = await within(panel).findByRole('alert')
    expect(listError.textContent).toContain('관심 공고를 불러오지 못했어요.')
    fireEvent.click(within(listError).getByRole('button', { name: '다시 시도' }))
    fireEvent.click(await within(panel).findByRole('radio', { name: new RegExp(supportPrograms[0].title) }))
    const rowError = await within(panel).findByRole('alert')
    expect(rowError.textContent).toContain('신청 준비 요청 시간이 초과되었습니다.')
    expect((within(panel).getByRole('button', { name: '이 공고 선택' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(rowError).getByRole('button', { name: '다시 시도' }))
    expect(await within(panel).findByText('양식 1개 · 바로 작성할 수 있어요')).toBeTruthy()
    expect((within(panel).getByRole('button', { name: '이 공고 선택' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([
    ['NO_FORM', 'NO_FORM', '최근 분석: 분석한 공식 첨부에서 작성할 신청 양식을 찾지 못했습니다.'],
    ['DOCUMENT_UNAVAILABLE', 'SOURCE_NOT_FOUND', '최근 분석: 공식 공고 또는 첨부가 없어졌거나 변경되었습니다.'],
    ['TOO_LARGE', 'SOURCE_TOO_LARGE', '최근 분석: 첨부 파일의 크기나 문서 분량이 분석 제한을 초과했습니다.'],
    ['RETRY_WAITING', 'AI_UNAVAILABLE', '최근 분석: AI 분석 서비스에 연결하지 못했습니다.'],
    ['REVIEW_REQUIRED', 'RETRY_EXHAUSTED:AI_UNAVAILABLE', '최근 분석: AI 분석 서비스에 연결하지 못했습니다. 자동 재시도 한도에 도달하여 관리자 확인이 필요합니다.'],
    ['PENDING', 'NOT_ANALYZED', '이 공고는 아직 신청 양식을 분석한 적이 없어요.'],
    ['STALE', 'SOURCE_CHANGED', '공고나 공식 첨부가 바뀌어 양식을 다시 분석해야 해요.'],
  ])('offers analysis of a %s / %s program as a button in ② and keeps writing closed with a reason', async (_status, reasonCode, reason) => {
    repository.availability.mockResolvedValue(availabilityOf(_status, reasonCode))
    mount(newPath)
    const notice = await screen.findByText('저장된 신청 양식이 없어요')
    expect(notice.parentElement?.textContent).toContain('아래 ②에서 입력칸별로 분석할 수 있어요.')
    const card = within(formSection()).getByRole('region', { name: '저장된 양식이 없어요' })
    // 분석은 텍스트 링크가 아니라 가운데 보조 버튼이고, 유료 AI와 한도를 바로 아래에 적습니다.
    expect(within(card).getByRole('button', { name: '입력칸별로 분석' }).tagName).toBe('BUTTON')
    expect(within(card).queryByRole('link', { name: '입력칸별로 분석' })).toBeNull()
    expect(within(card).getByText('AI가 공식 첨부를 읽어 문항을 뽑아요. 유료 AI 호출이며 계정당 동시에 3건까지 할 수 있어요.')).toBeTruthy()
    expect(card.textContent).toContain(reason)
    expect(startButton().disabled).toBe(true)
    expect(startReason()).toBe('양식을 분석하면 시작할 수 있어요')
    expect(follows(card, startButton())).toBe(true)
    expect(repository.discover).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('analyzes a program without a stored form only on click, shows progress in ② and opens the form with a toast', async () => {
    repository.availability.mockResolvedValue(availabilityOf('PENDING', 'NOT_ANALYZED'))
    const started = deferred<ReturnType<typeof completedDiscovery>>()
    repository.discover.mockReturnValueOnce(started.promise)
    mount(newPath)
    await screen.findByText('저장된 신청 양식이 없어요')
    fireEvent.click(within(formSection()).getByRole('button', { name: '입력칸별로 분석' }))
    const progress = await within(formSection()).findByRole('status', { name: '양식 분석 진행' })
    expect(progress.textContent).toContain('공식 첨부에서 신청 양식을 분석하고 있어요')
    expect(progress.textContent).toContain('화면을 나가도 계속돼요')
    expect(within(progress).queryByRole('button', { name: '취소' })).toBeNull()
    expect(startButton().disabled).toBe(true)
    await act(async () => started.resolve(completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false })))
    expect(await screen.findByText('양식을 분석했어요')).toBeTruthy()
    expect(within(formSection()).getByRole('heading', { name: '작성할 양식' })).toBeTruthy()
    expect(within(programSection()).getByText('작성할 수 있는 신청 양식 1개를 찾았어요')).toBeTruthy()
    expect(startButton().disabled).toBe(false)
    expect(repository.discover).toHaveBeenCalledTimes(1)
    expect(repository.discover).toHaveBeenCalledWith('BIZINFO', 'PBLN_1', expect.any(AbortSignal), expect.any(String))
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('resumes a discovery job that is still running for the selected notice', async () => {
    vi.useFakeTimers()
    repository.availability.mockResolvedValue(availabilityOf('PENDING', 'NOT_ANALYZED'))
    const running = { ...completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false }), status: 'RUNNING' as const, result: null }
    repository.discoveryJobs.mockResolvedValue([running])
    repository.discoveryJob.mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false }))
    await act(async () => { mount(newPath) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const progress = screen.getByRole('status', { name: '양식 분석 진행' })
    expect(progress.textContent).toContain('화면을 나가도 계속돼요')
    expect(progress.textContent).toContain('이전에 시작한 분석을 이어서 보여 드려요.')
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(repository.discoveryJob).toHaveBeenCalledWith(77, expect.any(AbortSignal))
    expect(screen.getByRole('heading', { name: '작성할 양식' })).toBeTruthy()
    expect(screen.getByText('양식을 분석했어요')).toBeTruthy()
    expect(repository.discover).not.toHaveBeenCalled()
  })

  it('lists the account analyses that fill the capacity in ② when starting another one is refused', async () => {
    repository.availability.mockResolvedValue(availabilityOf('NO_FORM', 'NO_FORM'))
    repository.discoveryJobs.mockResolvedValueOnce([]).mockResolvedValue([
      { ...completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false }), id: 1, status: 'QUEUED', result: null, programTitle: '대기 공고' },
      { ...completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false }), id: 2, status: 'RUNNING', result: null, programTitle: '분석 공고' },
      { ...completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false }), id: 3, status: 'UNKNOWN', result: null, programTitle: '확인 공고' },
      { ...completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false }), id: 4, programTitle: '끝난 공고' },
    ])
    repository.discover.mockRejectedValue(new ApplicationPreparationError(429, 'APPLICATION_FORM_JOB_CAPACITY'))
    mount(newPath)
    await screen.findByText('저장된 신청 양식이 없어요')
    fireEvent.click(within(formSection()).getByRole('button', { name: '입력칸별로 분석' }))
    const alert = await within(formSection()).findByRole('alert')
    expect(alert.textContent).toContain('진행 중이거나 확인이 필요한 분석이 3건입니다')
    const jobs = within(alert).getByRole('list', { name: '진행 중인 분석' })
    expect(within(jobs).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('대기 공고대기 중'), expect.stringContaining('분석 공고분석 중'), expect.stringContaining('확인 공고결과 확인 필요'),
    ])
    expect(within(jobs).getByText('최대 30분 뒤 자동으로 풀립니다')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(repository.discover).toHaveBeenCalledTimes(2))
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('shows discovery failure without pretending an uncached form is available', async () => {
    repository.availability.mockResolvedValue(availabilityOf('PENDING', 'NOT_ANALYZED'))
    repository.discover.mockRejectedValue(new ApplicationPreparationError(503, 'AI_UNAVAILABLE'))
    mount(newPath)
    await screen.findByText('저장된 신청 양식이 없어요')
    fireEvent.click(within(formSection()).getByRole('button', { name: '입력칸별로 분석' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('양식을 분석하지 못했어요')
    expect(alert.textContent).toContain('신청 준비 정보를 처리하지 못했습니다.')
    expect(screen.queryByRole('heading', { name: '작성할 양식' })).toBeNull()
    expect(startButton().disabled).toBe(true)
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('offers multiple stored forms as radio cards, re-fits the service field and reanalyzes with a secondary button', async () => {
    repository.availability.mockResolvedValue(availabilityOf('AVAILABLE', 'FORM_FOUND', [firstForm, { ...secondForm, sourceProgramId: 'PBLN_1' }]))
    const started = deferred<ReturnType<typeof completedDiscovery>>()
    repository.discover.mockReturnValueOnce(started.promise)
    mount(newPath)
    const found = await screen.findByText('작성할 수 있는 신청 양식 2개를 찾았어요')
    expect(found.parentElement?.textContent).toContain('아래 ②에서 작성할 양식을 골라 주세요.')
    const forms = within(formSection()).getByRole('radiogroup', { name: '작성할 양식' })
    const [first, second] = within(forms).getAllByRole('radio') as HTMLInputElement[]
    expect([first.checked, second.checked]).toEqual([true, false])
    expect(second.labels?.[0]?.textContent).toContain(secondForm.formTitle)
    fireEvent.click(second)
    const field = screen.getByRole('combobox', { name: '신청 분야' })
    expect(selectedValue(field)).toBe('MARKETING')
    expect(optionValues(field)).toEqual(['MARKETING'])
    expect(repository.discover).not.toHaveBeenCalled()

    // 유료 재분석은 텍스트 링크가 아니라 요약 상자 안의 보조 버튼이고, 비용과 한도를 바로 옆에 적습니다.
    const summary = screen.getByRole('region', { name: '양식 안내' })
    const reanalyze = within(summary).getByRole('button', { name: '입력칸별로 다시 분석' })
    expect(reanalyze.parentElement?.textContent).toContain('유료 AI · 계정당 동시에 3건')
    fireEvent.click(reanalyze)
    const progress = await within(formSection()).findByRole('status', { name: '양식 분석 진행' })
    expect(progress.textContent).toContain('입력칸별로 다시 분석하고 있어요')
    expect(repository.discover).toHaveBeenCalledTimes(1)
  })

  it('hides the service field choice when the form only supports general applications', async () => {
    repository.availability.mockResolvedValue(availabilityOf('AVAILABLE', 'FORM_FOUND', [{ ...firstForm, supportedServiceFields: ['GENERAL'] }]))
    mount(newPath)
    await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    await screen.findByRole('heading', { name: '작성할 양식' })
    expect(screen.queryByRole('combobox', { name: '신청 분야' })).toBeNull()
    fireEvent.click(startButton())
    await waitFor(() => expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ serviceField: 'GENERAL' }), expect.any(AbortSignal)))
  })

  it('aborts active snapshot lookup when leaving the page', async () => {
    repository.availability.mockReturnValue(new Promise(() => {}))
    const page = mount(newPath)
    await waitFor(() => expect(repository.availability).toHaveBeenCalled())
    const signal = repository.availability.mock.calls[0][2] as AbortSignal
    page.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('displays the complete official detail without starting AI', async () => {
    mount('/app/application-preparations/12')
    await screen.findByRole('heading', { name: '답변 입력' })

    // 경로는 "신청 문서 작성 › 답변 입력" 두 칸이고 머리글에 부제가 없습니다. 공고명 · 양식명 · 신청 분야는 본문 첫 줄에 있습니다.
    const crumbs = screen.getByRole('navigation', { name: '상위 화면' })
    expect(within(crumbs).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]))
      .toEqual([['신청 문서 작성', '/app/application-preparations']])
    expect(crumbs.textContent).not.toContain(firstForm.programTitle)
    const banner = screen.getByRole('banner')
    expect(banner.textContent).not.toContain(firstForm.programTitle)
    expect(banner.querySelector('p')).toBeNull()
    expectLede()
    expect(document.querySelector('main')!.firstElementChild).toBe(screen.getByTitle(ledeText))
    expect(screen.queryByText('파일 SHA-256')).toBeNull()
    // 검증된 양식에는 AI 추출 안내가 없습니다.
    expect(screen.queryByText('AI가 공식 첨부에서 뽑은 문항이에요')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    // 지금 보고 있는 항목은 답이 없어도 "진행 중", 나머지는 "시작 전"입니다.
    expect(sectionRow('기업 개요').getAttribute('aria-current')).toBe('step')
    expect(sectionRow('기업 개요').textContent).toContain('진행 중')
    expect(sectionRow('바우처 활용 계획').textContent).toContain('시작 전')
    expect(screen.getByText('전체 답변 0 / 2')).toBeTruthy()
    expect(screen.getByText('기업 개요 · 질문 1 / 2')).toBeTruthy()
    expect(screen.getByText('필수').className).toContain('border-warning-line')
    expect(screen.getByText('0 / 2,000자')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '업체명' })).toBeTruthy()
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('입력하면 자동으로 저장돼요'))).toBe(true)
    expect(screen.queryByRole('link', { name: '문서 보기' })).toBeNull()
    expect(repository.create).not.toHaveBeenCalled()
    expect(repository.interpret).not.toHaveBeenCalled()
    expect(repository.replaceInputs).not.toHaveBeenCalled()
  })

  it('keeps the same header while loading and holds the lede line with a skeleton', async () => {
    const request = deferred<ApplicationPreparation>()
    repository.get.mockReturnValueOnce(request.promise)
    mount('/app/application-preparations/12')
    const banner = screen.getByRole('banner')
    expect(within(banner).getByRole('heading', { level: 1, name: '답변 입력' })).toBeTruthy()
    expect(within(within(banner).getByRole('navigation', { name: '상위 화면' })).getAllByRole('link').map((link) => link.textContent)).toEqual(['신청 문서 작성'])
    expect(banner.querySelector('p')).toBeNull()
    const skeleton = document.querySelector('main')!.firstElementChild!
    expect(skeleton.getAttribute('aria-hidden')).toBe('true')
    expect(skeleton.className).toContain('animate-pulse')
    await act(async () => request.resolve(structuredClone(detail)))
    expectLede()
  })

  it('opens the first unanswered required question and links to existing documents', async () => {
    const ready = readyPreparation()
    ready.form.sections[1].facts = []
    repository.get.mockResolvedValue(ready)
    repository.documents.mockResolvedValue([documentFile])
    mount('/app/application-preparations/12')
    await screen.findByText('바우처 활용 계획 · 질문 2 / 2')
    expect(screen.getByRole('heading', { name: /과제명/ })).toBeTruthy()
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('')
    const documentsLink = within(screen.getByRole('banner')).getByRole('link', { name: '문서 보기' })
    expect(documentsLink.getAttribute('href')).toBe('/app/application-preparations/12/documents')
    // 머리글 버튼은 공용 규격(secondary)이고 600px 미만에서는 메뉴 안으로 옮깁니다.
    expect(documentsLink.className).toContain('min-h-10')
    expect(documentsLink.className).toContain('max-[599px]:hidden')
    fireEvent.click(screen.getByRole('button', { name: '문서 메뉴' }))
    const menu = screen.getByRole('menu', { name: '문서 메뉴' })
    // 모바일에서만 보이는 [문서 보기]가 메뉴 첫 줄입니다.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['문서 보기', '원문 보기 ↗', '양식 다시 분석해 새로 시작'])
    expect(within(menu).getByRole('menuitem', { name: '원문 보기 ↗' }).getAttribute('href')).toBe(firstForm.sourceUrl)
    expect(within(menu).getByRole('menuitem', { name: '양식 다시 분석해 새로 시작' }).getAttribute('href')).toBe('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
  })

  it('opens the question named in the address and ignores an unknown one', async () => {
    repository.get.mockResolvedValue(readyPreparation())
    const first = mount('/app/application-preparations/12?question=project-title')
    expect(await screen.findByText('바우처 활용 계획 · 질문 2 / 2')).toBeTruthy()
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새봄테크')
    first.unmount()
    mount('/app/application-preparations/12?question=missing-field')
    expect(await screen.findByText('기업 개요 · 질문 1 / 2')).toBeTruthy()
  })

  it('shows every saved answer in its input instead of retaining it invisibly', async () => {
    const ready = readyPreparation()
    ready.form.sections[0].facts[0].value = '기존 저장 업체명'
    ready.form.sections[0].facts[0].sourceText = '업체명: 기존 저장 업체명'
    repository.get.mockResolvedValue(ready)
    mount('/app/application-preparations/12')

    expect((await screen.findByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('기존 저장 업체명')
    expect(screen.getByRole('button', { name: '답변 지우기' })).toBeTruthy()
    expect(repository.replaceInputs).not.toHaveBeenCalled()
  })

  it('keeps a saved answer when the input is merely emptied, clears it only with the button and restores it from the toast', async () => {
    vi.useFakeTimers()
    const ready = readyPreparation()
    repository.get.mockResolvedValue(ready)
    echoReplaceInputs(ready)
    await act(async () => { mount('/app/application-preparations/12') })
    const input = screen.getByLabelText('답변 입력') as HTMLTextAreaElement

    // 칸을 비우는 것만으로는 저장된 답변이 지워지지 않으므로 요청도 없습니다.
    fireEvent.change(input, { target: { value: '' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(repository.replaceInputs).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '새봄테크' } })
    fireEvent.click(screen.getByRole('button', { name: '답변 지우기' }))
    await act(async () => {})
    expect(repository.replaceInputs).toHaveBeenCalledWith(12, 'company-overview', { expectedRevision: 3, facts: [] }, expect.any(AbortSignal))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('')
    const toast = screen.getByText('업체명 답변을 지웠어요').closest('[role="status"]') as HTMLElement

    fireEvent.click(within(toast).getByRole('button', { name: '되돌리기' }))
    await act(async () => {})
    expect(repository.replaceInputs).toHaveBeenLastCalledWith(12, 'company-overview', { expectedRevision: 4, facts: [
      { fieldKey: 'company-name', status: 'PROVIDED', value: '새봄테크', sourceText: '업체명: 새봄테크' },
    ] }, expect.any(AbortSignal))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새봄테크')
    expect(screen.queryByText(/답변을 지웠어요/)).toBeNull()
  })

  it('autosaves two seconds after typing stops and again with keepalive when the page is hidden', async () => {
    vi.useFakeTimers()
    echoReplaceInputs(detail)
    await act(async () => { mount('/app/application-preparations/12') })
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄' } })
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('입력을 멈추면 저장돼요'))).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
    expect(repository.replaceInputs).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(repository.replaceInputs).toHaveBeenCalledWith(12, 'company-overview', { expectedRevision: 3, facts: [
      { fieldKey: 'company-name', status: 'PROVIDED', value: '새봄', sourceText: '업체명: 새봄' },
    ] }, expect.any(AbortSignal))
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('자동 저장됨 · 방금'))).toBe(true)

    // 탭을 숨기면(다른 탭·창 닫기) 기다리지 않고 keepalive로 보냅니다.
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄테크' } })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(repository.replaceInputs).toHaveBeenLastCalledWith(12, 'company-overview', { expectedRevision: 4, facts: [
      { fieldKey: 'company-name', status: 'PROVIDED', value: '새봄테크', sourceText: '업체명: 새봄테크' },
    ] }, undefined, { keepalive: true })
  })

  it('marks an answer as undecided with the checkbox and saves it as UNKNOWN', async () => {
    vi.useFakeTimers()
    echoReplaceInputs(detail)
    await act(async () => { mount('/app/application-preparations/12') })
    fireEvent.click(screen.getByRole('checkbox', { name: '아직 정해지지 않았어요' }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(repository.replaceInputs).toHaveBeenCalledWith(12, 'company-overview', { expectedRevision: 3, facts: [
      { fieldKey: 'company-name', status: 'UNKNOWN', value: null, sourceText: '업체명: 미정' },
    ] }, expect.any(AbortSignal))
    expect(sectionRow('기업 개요').textContent).toContain('답변 1 / 1')
    expect(sectionRow('기업 개요').textContent).toContain('완료')
    fireEvent.click(screen.getByRole('checkbox', { name: '아직 정해지지 않았어요' }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('reloads the latest answers but keeps the typed value on a revision conflict', async () => {
    vi.useFakeTimers()
    repository.replaceInputs.mockRejectedValueOnce(new ApplicationPreparationError(409, 'APPLICATION_PREPARATION_REVISION_CONFLICT'))
    await act(async () => { mount('/app/application-preparations/12') })
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '충돌 중 입력' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByRole('alert').textContent).toContain('다른 곳에서 답변이 먼저 바뀌어')
    expect(repository.get).toHaveBeenCalledTimes(2)
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('충돌 중 입력')
    // 충돌 알림의 버튼은 "다시 시도"가 아니라 내 답변을 최신 버전 위에 다시 저장하는 동작입니다.
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
    echoReplaceInputs(detail)
    fireEvent.click(screen.getByRole('button', { name: '내 답변으로 다시 저장' }))
    await act(async () => {})
    expect(repository.replaceInputs).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('saves each section when moving between questions without AI and keeps answers across sections', async () => {
    const form = structuredClone(detail)
    form.form.sections[0].fields.push({ key: 'contact', label: '담당자', guidance: '담당자를 입력하세요.', required: false })
    repository.get.mockResolvedValue(form)
    echoReplaceInputs(form)
    mount('/app/application-preparations/12')
    await screen.findByRole('region', { name: '기업 개요 작성' })
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await waitFor(() => expect(repository.replaceInputs).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '미정' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await waitFor(() => expect(repository.replaceInputs).toHaveBeenCalledTimes(2))
    expect(repository.replaceInputs).toHaveBeenLastCalledWith(12, 'company-overview', { expectedRevision: 4, facts: [
      { fieldKey: 'company-name', status: 'PROVIDED', value: '새봄', sourceText: '업체명: 새봄' },
      { fieldKey: 'contact', status: 'UNKNOWN', value: null, sourceText: '담당자: 미정' },
    ] }, expect.any(AbortSignal))
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '다른 문서의 초안' } })
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    await waitFor(() => expect(repository.replaceInputs).toHaveBeenCalledTimes(3))
    expect(repository.interpret).not.toHaveBeenCalled()
    // 글자로 적은 "미정"도 저장 뒤에는 "아직 정해지지 않았어요" 체크로 보입니다.
    expect((screen.getByRole('checkbox', { name: '아직 정해지지 않았어요' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('다른 문서의 초안')
    expect(repository.replaceInputs).toHaveBeenCalledTimes(3)
  })

  it('keeps the typed answer, shows a retry when autosave fails, and retries on click', async () => {
    vi.useFakeTimers()
    repository.replaceInputs.mockRejectedValueOnce(new Error('저장 연결 실패'))
    await act(async () => { mount('/app/application-preparations/12') })
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '보존할 답변' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByRole('alert').textContent).toContain('답변을 저장하지 못했어요. 저장 연결 실패')
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('보존할 답변')
    echoReplaceInputs(detail)
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await act(async () => {})
    expect(repository.replaceInputs).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('자동 저장됨'))).toBe(true)
  })

  it('offers official single choices and keeps the selected answer when navigating', async () => {
    const choices = structuredClone(detail)
    choices.form.sections[0].fields[0] = { key: 'idea-field', label: '아이디어 분야 (택1)', guidance: '한 분야를 선택하세요.', required: true, options: ['기술', '생활'] }
    repository.get.mockResolvedValue(choices)
    echoReplaceInputs(choices)
    mount('/app/application-preparations/12')
    const first = await screen.findByRole('radio', { name: '기술' })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('radio', { name: '생활' }))
    expect((first as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await waitFor(() => expect(repository.replaceInputs).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
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
    manyFields.form.sections = [manyFields.form.sections[0]]
    manyFields.form.sections[0].fields = Array.from({ length: 16 }, (_, index) => ({ key: `field-${index}`, label: `입력내용${index + 1}`, guidance: `안내문${index + 1}`, required: true }))
    repository.get.mockResolvedValue(manyFields)
    echoReplaceInputs(manyFields)
    mount('/app/application-preparations/12')
    await screen.findByText('기업 개요 · 질문 1 / 16')
    expect(screen.getByText('안내문1')).toBeTruthy()
    expect(screen.queryByText('안내문2')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '첫 번째 답변' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByText('기업 개요 · 질문 2 / 16')).toBeTruthy()
    expect(screen.getByText('안내문2')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '두 번째 답변' } })
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('첫 번째 답변')
    await waitFor(() => expect(sectionRow('기업 개요').textContent).toContain('답변 2 / 16'))
    for (let index = 0; index < 15; index++) fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByText('기업 개요 · 질문 16 / 16')).toBeTruthy()
    // 마지막 질문에서도 [다음 →]이고 [초안 만들기]는 검토 단계에만 있습니다.
    expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByRole('heading', { name: '초안을 만들기 전에 확인해 주세요' })).toBeTruthy()
    expect(repository.interpret).not.toHaveBeenCalled()
    // 이동할 때마다 바뀐 항목만 저장합니다. 답변이 그대로면 요청을 보내지 않습니다.
    expect(repository.replaceInputs).toHaveBeenCalledTimes(2)
  })

  it('shows one question at a time with the move buttons inside the card and keeps answers across sections', async () => {
    echoReplaceInputs(detail)
    mount('/app/application-preparations/12')
    const first = await screen.findByRole('region', { name: '기업 개요 작성' })
    expect(screen.queryByRole('region', { name: '바우처 활용 계획 작성' })).toBeNull()
    // PC에서는 [← 이전] · 자동 저장 상태 · [다음 →]이 고정 바가 아니라 질문 카드의 바닥 줄입니다.
    expect(within(first).getByRole('button', { name: '← 이전' })).toBeTruthy()
    expect(within(first).getByRole('button', { name: '다음 →' })).toBeTruthy()
    expect(within(first).getAllByRole('status').some((node) => node.textContent === '입력하면 자동으로 저장돼요')).toBe(true)
    expect(document.querySelector('.sticky.bottom-0')).toBeNull()
    expect((screen.getByRole('button', { name: '← 이전' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(first).getByRole('textbox'), { target: { value: '업체명은 새봄테크입니다.' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.queryByRole('region', { name: '기업 개요 작성' })).toBeNull()
    const second = screen.getByRole('region', { name: '바우처 활용 계획 작성' })
    fireEvent.change(within(second).getByRole('textbox'), { target: { value: '새로운 과제입니다.' } })
    // 마지막 질문에서도 같은 자리에 [다음 →]이 있고, [초안 만들기]로 바뀌지 않습니다.
    expect(within(second).getByRole('button', { name: '다음 →' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
    fireEvent.click(sectionRow('기업 개요'))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('업체명은 새봄테크입니다.')
    expect(sectionRow('기업 개요').getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새로운 과제입니다.')
    await waitFor(() => expect(repository.replaceInputs).toHaveBeenCalledTimes(2))
    expect(repository.interpret).not.toHaveBeenCalled()
  })

  it('shows the AI extraction notice with the source link only for extracted forms', async () => {
    const extracted = structuredClone(detail)
    extracted.form.verificationStatus = 'SOURCE_DOCUMENT_EXTRACTED'
    repository.get.mockResolvedValue(extracted)
    mount('/app/application-preparations/12')
    const note = await screen.findByRole('note')
    expect(within(note).getByText('AI가 공식 첨부에서 뽑은 문항이에요')).toBeTruthy()
    expect(note.textContent).toContain('원문과 대조해 주세요. 기관 검수 · 선정과 무관하며 자동 제출되지 않아요.')
    expect(within(note).getByRole('link', { name: /원문 보기 ↗/ }).getAttribute('href')).toBe(firstForm.sourceUrl)
  })

  it('keeps the save time in the card footer on PC', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 30, 9, 41))
    echoReplaceInputs(detail)
    await act(async () => { mount('/app/application-preparations/12') })
    const footerStatus = () => screen.getAllByRole('status').find((node) => node.className.includes('truncate'))!
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(footerStatus().textContent).toBe('자동 저장됨 · 방금 09:41')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await act(async () => {})
    // 마지막 질문에서도 상태 자리는 자동 저장 상태입니다. 남은 필수 답변 수는 목록 위 막대 카드에 있습니다.
    expect(footerStatus().textContent).toBe('자동 저장됨 · 방금 09:41')
    expect(screen.getByText('필수 답변 1개가 남았어요')).toBeTruthy()
  })

  it('under 600px uses a content-width bar, one overall progress line and keeps the save status there', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(max-width: 599px)', addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    echoReplaceInputs(detail)
    mount('/app/application-preparations/12')
    const card = await screen.findByRole('region', { name: '기업 개요 작성' })
    // 이동 버튼은 카드 밖의 아래 고정 바에 있고, 바는 본문 칸 폭을 넘지 않습니다(음수 좌우 여백 없음).
    expect(within(card).queryByRole('button', { name: '다음 →' })).toBeNull()
    const bar = screen.getByRole('button', { name: '다음 →' }).parentElement!
    expect(bar.className).toContain('sticky')
    expect(bar.className).not.toMatch(/-mx-/)
    expect(within(bar).queryByRole('status')).toBeNull()
    // 진행 줄은 카드와 같은 전체 기준 "질문 1 / 2"와 섹션 이름입니다.
    expect(screen.getByText('질문 1 / 2')).toBeTruthy()
    expect(screen.getAllByRole('status').some((node) => node.textContent === '입력하면 자동으로 저장돼요')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByText('질문 2 / 2')).toBeTruthy()
    // "질문 n / m"은 진행 줄에만 한 번 있고, 카드 머리에는 섹션 이름과 필수 표시만 남습니다.
    expect(screen.getAllByText(/질문 2 \/ 2/)).toHaveLength(1)
    const next = screen.getByRole('region', { name: '바우처 활용 계획 작성' })
    expect(within(next).getByText('바우처 활용 계획')).toBeTruthy()
    expect(within(next).getByText('필수')).toBeTruthy()
    expect(within(next).queryByText(/질문 2 \/ 2/)).toBeNull()
  })

  it('shows a validation error only under the field and warns once when a paste is cut at the limit', async () => {
    vi.useFakeTimers()
    await act(async () => { mount('/app/application-preparations/12') })
    const input = screen.getByLabelText('답변 입력') as HTMLTextAreaElement
    fireEvent.paste(input, { clipboardData: { getData: () => '가'.repeat(2001) } })
    expect(screen.getByText('2,000자까지만 저장돼요')).toBeTruthy()
    // 붙여 넣기 제한을 우회한 값은 저장 전에 칸 오류가 됩니다. 위쪽 실패 알림으로 겹쳐 띄우지 않습니다.
    fireEvent.change(input, { target: { value: '가'.repeat(2001) } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(repository.replaceInputs).not.toHaveBeenCalled()
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toBe('답변은 2,000자 이내로 입력해 주세요.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: '짧은 답변' } })
    expect(screen.queryByText('2,000자까지만 저장돼요')).toBeNull()
    expect(screen.getByText('5 / 2,000자')).toBeTruthy()
  })

  it('restores the typed value when the undecided check is cleared', async () => {
    mount('/app/application-preparations/12')
    const input = await screen.findByLabelText('답변 입력') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '새봄테크' } })
    const check = screen.getByRole('checkbox', { name: '아직 정해지지 않았어요' })
    fireEvent.click(check)
    expect(input.value).toBe('')
    expect(input.disabled).toBe(true)
    fireEvent.click(check)
    expect(input.value).toBe('새봄테크')
    expect(input.disabled).toBe(false)
  })

  it('opens the section sheet as a dialog that traps focus, closes with Escape and returns focus', async () => {
    mount('/app/application-preparations/12')
    await screen.findByLabelText('답변 입력')
    const opener = screen.getByRole('button', { name: '항목 목록' })
    fireEvent.click(opener)
    const sheet = screen.getByRole('dialog', { name: '항목 목록' })
    const close = within(sheet).getByRole('button', { name: '닫기' })
    expect(document.activeElement).toBe(close)
    // 마지막 요소("검토하고 초안 만들기" 링크)에서 Tab을 누르면 첫 요소로, 첫 요소에서 Shift+Tab을 누르면 마지막 요소로 돕니다.
    const last = within(sheet).getByRole('link', { name: '검토하고 초안 만들기' })
    expect(sheet.getAttribute('data-covers-assistant')).toBe('true')
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '항목 목록' })).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('moves with Ctrl/⌘+Enter and Ctrl/⌘+Shift+Enter, but not on a plain Enter or while composing Hangul', async () => {
    echoReplaceInputs(detail)
    mount('/app/application-preparations/12')
    const input = await screen.findByLabelText('답변 입력')
    expect(screen.getByRole('button', { name: '다음 →' }).getAttribute('aria-keyshortcuts')).toBe('Control+Enter')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, keyCode: 229 })
    expect(screen.getByText('기업 개요 · 질문 1 / 2')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(screen.getByText('바우처 활용 계획 · 질문 2 / 2')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('답변 입력'), { key: 'Enter', metaKey: true, shiftKey: true })
    expect(screen.getByText('기업 개요 · 질문 1 / 2')).toBeTruthy()
  })

  it('announces a section change once and marks a passed section whose required answer is still empty', async () => {
    echoReplaceInputs(detail)
    mount('/app/application-preparations/12')
    await screen.findByLabelText('답변 입력')
    const statusWith = (text: string) => screen.getAllByRole('status').find((node) => node.textContent === text)
    // 비어 있는 필수 질문을 두고 넘어가도 막지 않고, 띠와 목록 줄로 알립니다.
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByRole('heading', { name: '과제명' })).toBeTruthy()
    expect(statusWith('기업 개요에 비어 있는 필수 질문이 1개 있어요 → 바우처 활용 계획')).toBeTruthy()
    expect(sectionRow('기업 개요').textContent).toContain('필수 비어 있음')
    fireEvent.click(screen.getByRole('button', { name: '그 질문으로' }))
    expect(screen.getByRole('heading', { name: '업체명' })).toBeTruthy()
    expect(statusWith('기업 개요에 비어 있는 필수 질문이 1개 있어요 → 바우처 활용 계획')).toBeUndefined()
    fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄테크' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(statusWith('기업 개요 완료 → 바우처 활용 계획')).toBeTruthy()
    expect(sectionRow('기업 개요').textContent).toContain('완료')
    // 같은 섹션 안의 이동이나 되돌아가기에서는 띠를 비웁니다.
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    expect(statusWith('기업 개요 완료 → 바우처 활용 계획')).toBeUndefined()
  })

  it('opens the review after the last question, ignores a second click within 400ms and then creates the draft', async () => {
    repository.get.mockResolvedValue(readyPreparation())
    mount('/app/application-preparations/12?question=project-title')
    await screen.findByText('바우처 활용 계획 · 질문 2 / 2')
    const next = screen.getByRole('button', { name: '다음 →' })
    fireEvent.click(next)
    expect(screen.getByTestId('location').textContent).toBe('/app/application-preparations/12?question=project-title&step=review')
    const title = screen.getByRole('heading', { name: '초안을 만들기 전에 확인해 주세요' })
    expect(document.activeElement).toBe(title)
    expect(screen.getByText('필수 질문을 모두 채웠어요')).toBeTruthy()
    expect(screen.getByText('검토 · 질문 2개를 모두 지났어요')).toBeTruthy()
    expect(screen.getByText('AI가 공식 양식에 답변을 기입해요 · 보통 1~3분')).toBeTruthy()
    const rows = within(screen.getByRole('list', { name: '항목별 답변' })).getAllByRole('button').map((row) => row.textContent)
    expect(rows).toEqual(['1. 기업 개요답변 1 / 1완료', '2. 바우처 활용 계획답변 1 / 1완료'])
    // 같은 자리의 버튼이 [초안 만들기]로 바뀐 직후의 두 번째 클릭은 받지 않습니다.
    const create = screen.getByRole('button', { name: '초안 만들기' })
    expect(create.querySelector('svg')).toBeTruthy()
    fireEvent.click(create)
    await act(async () => {})
    expect(screen.getByTestId('location').textContent).toContain('step=review')
    expect(repository.submitDocumentJob).not.toHaveBeenCalled()
    afterSwapGuard()
    fireEvent.click(create)
    await waitFor(() => expect(receiveButton()).toBeTruthy())
    expect(screen.getByTestId('location').textContent).toContain('/app/application-preparations/12/documents')
    expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
  })

  it('keeps the review on refresh, links each empty required question and focuses that summary instead of creating a draft', async () => {
    const partial = readyPreparation()
    partial.form.sections[0].fields.push({ key: 'position', label: '직위', guidance: '직위만 입력', required: false })
    partial.form.sections[1].facts = []
    repository.get.mockResolvedValue(partial)
    mount('/app/application-preparations/12?step=review')
    const summary = await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: '초안을 만들기 전에 확인해 주세요' })).toBeTruthy()
    expect(within(summary).getByText('필수 질문 1개가 비어 있어요')).toBeTruthy()
    const missing = within(summary).getByRole('link', { name: '바우처 활용 계획 · 과제명' })
    expect(missing.getAttribute('href')).toBe('/app/application-preparations/12?question=project-title')
    expect(screen.getByText('선택 질문 1개는 비워 두면 문서에 빈칸으로 남아요.')).toBeTruthy()
    expect(within(screen.getByRole('list', { name: '항목별 답변' })).getAllByRole('button').map((row) => row.textContent))
      .toEqual(['1. 기업 개요답변 1 / 2선택 1', '2. 바우처 활용 계획답변 0 / 1필수 1'])
    // 목록의 링크는 검토 단계를 가리키고, 지나온 항목의 빈 필수 질문을 "필수 비어 있음"으로 남깁니다.
    expect(screen.getByRole('link', { name: '검토하고 초안 만들기' }).getAttribute('aria-current')).toBe('step')
    expect(sectionRow('바우처 활용 계획').textContent).toContain('필수 비어 있음')
    // 필수가 비어 있으면 버튼을 비활성화하지 않고, 눌러도 작업을 보내지 않은 채 요약으로 포커스를 옮깁니다.
    const create = screen.getByRole('button', { name: '초안 만들기' }) as HTMLButtonElement
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    await act(async () => {})
    expect(document.activeElement).toBe(summary)
    expect(screen.getByTestId('location').textContent).toBe('/app/application-preparations/12?step=review')
    expect(repository.submitDocumentJob).not.toHaveBeenCalled()
    // [← 이전]은 마지막 질문으로 돌아갑니다.
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    expect(screen.getByTestId('location').textContent).toBe('/app/application-preparations/12')
    expect(screen.getByText('바우처 활용 계획 · 질문 3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '검토하고 초안 만들기' }))
    fireEvent.click(within(screen.getByRole('alert')).getByRole('link', { name: '바우처 활용 계획 · 과제명' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '과제명' }))
    expect(screen.getByTestId('location').textContent).toBe('/app/application-preparations/12')
    // 요약의 [첫 빈 필수 질문으로]도 같은 질문으로 갑니다. 필수가 남아 있는 동안에는 [첫 빈 선택 질문으로]를 두지 않습니다.
    fireEvent.click(screen.getByRole('link', { name: '검토하고 초안 만들기' }))
    expect(screen.queryByRole('button', { name: '첫 빈 선택 질문으로' })).toBeNull()
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '첫 빈 필수 질문으로' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '과제명' }))
  })

  it('points to the first empty optional question once every required one is answered', async () => {
    const optional = readyPreparation()
    optional.form.sections[0].fields.push({ key: 'position', label: '직위', guidance: '직위만 입력', required: false })
    repository.get.mockResolvedValue(optional)
    mount('/app/application-preparations/12?step=review')
    expect(await screen.findByText('필수 질문을 모두 채웠어요')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '첫 빈 필수 질문으로' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '첫 빈 선택 질문으로' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '직위' }))
  })

  it('scrolls the workspace so the card sits under the header and focuses the title without a focus scroll', async () => {
    echoReplaceInputs(detail)
    const { container } = mount('/app/application-preparations/12')
    const card = await screen.findByRole('region', { name: '기업 개요 작성' })
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo
    container.scrollTop = 900
    container.style.setProperty('--workspace-header-h', '89px')
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
    vi.spyOn(card.parentElement!, 'getBoundingClientRect').mockReturnValue({ top: -300 } as DOMRect)
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    // 카드 윗변(-300) − 머리글(89) − 16px만큼 스크롤 칸을 올립니다.
    expect(scrollTo).toHaveBeenCalledWith({ top: 900 - 300 - 89 - 16 })
    const title = screen.getByRole('heading', { name: '과제명' })
    expect(document.activeElement).toBe(title)
    expect(focus.mock.contexts.at(-1)).toBe(title)
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
  })

  it('folds the online input helper under the card unless the address asks to open it', async () => {
    const first = mount('/app/application-preparations/12')
    const helper = (await screen.findByRole('heading', { name: '온라인 신청 입력 도우미' })).closest('details') as HTMLDetailsElement
    expect(helper.open).toBe(false)
    expect(screen.getByRole('region', { name: '기업 개요 작성' }).compareDocumentPosition(helper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    first.unmount()
    mount('/app/application-preparations/12?helper=open')
    const opened = (await screen.findByRole('heading', { name: '온라인 신청 입력 도우미' })).closest('details') as HTMLDetailsElement
    expect(opened.open).toBe(true)
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
