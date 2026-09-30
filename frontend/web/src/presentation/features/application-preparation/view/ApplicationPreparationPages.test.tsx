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
import { chooseOption } from '../../../../test/selectField'

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
  expect(progress.textContent).toContain('답변 버전 3로 만들고 있어요')
  expect(progress.textContent).toContain('순서를 기다리고 있어요')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('status', { name: '문서 생성 진행' }).textContent).toContain('입력칸 위치를 확인하고 있어요')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('status', { name: '문서 생성 진행' }).textContent).toContain('답변을 문서에 기입하고 있어요')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('button', { name: '신청문서 1 다운로드' })).toBeTruthy()
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
  expect(screen.getByRole('status', { name: '문서 생성 진행' }).textContent).toContain('답변을 문서에 기입하고 있어요')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('button', { name: '신청문서 1 다운로드' })).toBeTruthy()
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  expect(repository.documentJob).toHaveBeenCalledWith(12, 77, expect.any(AbortSignal))
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
  expect(screen.getByRole('button', { name: '신청문서 1 다운로드' })).toBeTruthy()
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
  const button = await screen.findByRole('button', { name: '초안 만들기' })
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
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
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
  fireEvent.click(screen.getByRole('link', { name: '이전으로 · 답변 수정' }))
  expect((await screen.findByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새봄테크')
})

it('blocks generation until every required answer exists, then saves pending answers before generating', async () => {
  echoReplaceInputs(detail)
  mount('/app/application-preparations/12')
  await screen.findByLabelText('답변 입력')
  expect((screen.getByRole('button', { name: '초안 만들기' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/필수 답변 2개가 남았어요/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '새봄테크' } })
  fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
  expect(screen.getAllByRole('button', { name: '초안 만들기' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
  fireEvent.change(screen.getByLabelText('답변 입력'), { target: { value: '스마트 공정 과제' } })
  // 마지막 질문에서는 아래 바의 [다음 →]이 [초안 만들기]로 바뀝니다. 입력 중인 답변을 먼저 저장한 뒤 결과 화면으로 갑니다.
  const generateButtons = screen.getAllByRole('button', { name: '초안 만들기' })
  expect(generateButtons).toHaveLength(2)
  expect(generateButtons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true)
  fireEvent.click(generateButtons[1])
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
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
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
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

it('offers a whole-revision archive only for several current files and folds older versions away', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValue([
    { ...documentFile, id: 83, inputRevision: 3, fileName: '신청서_초안_v3.hwpx' },
    { ...documentFile, id: 82, inputRevision: 3, fileName: '사업계획서_초안_v3.docx' },
    { ...documentFile, id: 70, inputRevision: 2, fileName: '신청서_초안_v2.hwpx' },
  ])
  repository.downloadDocumentArchive.mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }))
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('신청문서_초안_v3.zip')
  })
  mount('/app/application-preparations/12/documents')
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  expect(screen.getByRole('button', { name: '신청문서 2 다운로드' })).toBeTruthy()
  const older = screen.getByText('이전 버전 1개 보기').closest('details') as HTMLDetailsElement
  expect(within(older).getByText('신청서_초안_v2.hwpx')).toBeTruthy()
  expect((screen.getByRole('button', { name: '다시 만들기' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '전체 내려받기' }))
  await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1))
  expect(repository.downloadDocumentArchive).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal))
  expect(repository.submitDocumentJob).not.toHaveBeenCalled()
  clicked.mockRestore()
  vi.unstubAllGlobals()
})

it('enables regeneration only after the answers changed and starts it from the header', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.documents.mockResolvedValueOnce([{ ...documentFile, inputRevision: 2 }]).mockResolvedValue([])
  jobSucceeds([{ ...documentFile, id: 84 }])
  mount('/app/application-preparations/12/documents')
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  expect(screen.queryByRole('button', { name: '전체 내려받기' })).toBeNull()
  const regenerate = screen.getByRole('button', { name: '다시 만들기' }) as HTMLButtonElement
  expect(regenerate.disabled).toBe(false)
  fireEvent.click(regenerate)
  expect((await screen.findByRole('status', { name: '문서 생성 진행' })).textContent).toContain('답변 버전 3로 만들고 있어요')
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 3, expect.any(AbortSignal), undefined)
})

it('regenerates the document with the revised answers after returning to the input page', async () => {
  const ready = readyPreparation()
  repository.get.mockResolvedValue(ready)
  repository.documents.mockResolvedValueOnce([documentFile]).mockResolvedValue([])
  echoReplaceInputs(ready)
  jobSucceeds([{ ...documentFile, id: 82, fileName: '신청서_초안_v4.hwpx' }])
  mount('/app/application-preparations/12/documents')
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  fireEvent.click(screen.getByRole('link', { name: '이전으로 · 답변 수정' }))
  fireEvent.change(await screen.findByLabelText('답변 입력'), { target: { value: '변경한 업체명' } })
  // 초안 만들기는 입력 중인 답변을 먼저 저장하고(버전 3 → 4) 그 버전으로 결과 화면에 들어갑니다.
  fireEvent.click(screen.getByRole('button', { name: '초안 만들기' }))
  await screen.findByText('신청서_초안_v4.hwpx')
  expect(repository.replaceInputs).toHaveBeenCalledWith(12, 'company-overview', { expectedRevision: 3, facts: [
    { fieldKey: 'company-name', status: 'PROVIDED', value: '변경한 업체명', sourceText: '업체명: 변경한 업체명' },
  ] }, expect.any(AbortSignal))
  expect(repository.submitDocumentJob).toHaveBeenCalledWith(12, 4, expect.any(AbortSignal), undefined)
})

it('shows the server failure message of a failed job and retries the same revision', async () => {
  repository.get.mockResolvedValue(readyPreparation())
  repository.submitDocumentJob.mockResolvedValueOnce(generationJob({ status: 'FAILED', stage: 'MAPPING', fileIds: [],
    failureCode: 'APPLICATION_DOCUMENT_MAPPING_FAILED', failureMessage: '질문 항목의 실제 입력 위치를 확인하지 못했습니다.' }))
  mount('/app/application-preparations/12/documents?generate=3')
  expect((await screen.findByRole('alert')).textContent).toContain('입력 위치')
  expect(screen.queryByRole('button', { name: /다운로드/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
  await screen.findByRole('button', { name: '신청문서 1 다운로드' })
  expect(repository.submitDocumentJob.mock.calls.map((call) => call[1])).toEqual([3, 3])
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
  expect(screen.getByRole('button', { name: '신청문서 1 다운로드' })).toBeTruthy()
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
  await screen.findByRole('heading', { name: '답변 입력' })
  expect(screen.getByText('답변 1 / 2 · 진행 중')).toBeTruthy()
  expect(screen.queryByText('사실 확인됨')).toBeNull()
})

it('starts reanalysis only on an explicit click and preserves existing preparations', async () => {
  mount('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
  await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
  fireEvent.click(screen.getByRole('button', { name: '다음' }))
  const button = await screen.findByRole('button', { name: '입력칸별로 다시 분석' })
  expect(repository.discover).not.toHaveBeenCalled()
  fireEvent.click(button)
  // 끝나면 2단계에 머문 채 토스트로 알리고, 분석이 남긴 경고를 요약 카드에 보여 줍니다.
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
    expect((screen.getByRole('button', { name: '완료' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('D-3')).toBeTruthy()
    // 답변 진행은 모든 카드에 보이고, 완료 카드는 날짜 자리에 "초안 있음"을 덧붙인다.
    expect(screen.getByText('필수 답변 11 / 11')).toBeTruthy()
    expect(screen.getByText(/^초안 있음 · \d{2}\.\d{2}$/)).toBeTruthy()
    expect(screen.getByText('필수 답변 2 / 9')).toBeTruthy()
    expect(screen.getByText('완료', { selector: 'span' })).toBeTruthy()
    expect(screen.getByText('진행 중', { selector: 'span' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '문서 보기' }).getAttribute('href')).toBe('/app/application-preparations/12/documents')
    expect(screen.getByRole('link', { name: '이어서 작성' }).getAttribute('href')).toBe('/app/application-preparations/11')
    fireEvent.click(screen.getByRole('button', { name: '진행 중' }))
    await waitFor(() => expect(repository.list.mock.calls[1]?.[0]).toEqual({ status: 'in_progress' }))
    fireEvent.click(screen.getByRole('button', { name: '전체' }))
    await waitFor(() => expect(repository.list.mock.calls[2]?.[0]).toEqual({}))
  })
})

describe('application preparation creation and detail', () => {
  const newPath = '/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1'
  const availabilityOf = (status: string, reasonCode: string, items: ApplicationForm[] = []) => ({ state: { sourceCode: 'BIZINFO',
    sourceProgramId: 'PBLN_1', status, reasonCode, nextRetryAt: null, attemptCount: 1 }, forms: { items } })
  const nextButton = () => screen.getByRole('button', { name: '다음' }) as HTMLButtonElement
  const startButton = () => screen.getByRole('button', { name: '작성 시작' }) as HTMLButtonElement

  it('loads the program from the address, shows its stored form without AI and creates the preparation from step 2', async () => {
    mount(newPath)
    expect(screen.getByRole('heading', { name: '새 문서' })).toBeTruthy()
    const crumbs = screen.getByRole('navigation', { name: '상위 화면' })
    expect(within(crumbs).getByRole('link', { name: '신청 문서 작성' }).getAttribute('href')).toBe('/app/application-preparations')
    expect(screen.getByText('공고를 고르면 저장된 신청 양식이 있는지 바로 확인해요')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('공고를 불러오는 중입니다.')
    expect(nextButton().disabled).toBe(true)

    const found = await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    expect(found.parentElement?.textContent).toContain(`${firstForm.formTitle} — 다음 단계에서 고를 수 있어요.`)
    expect(repository.availability).toHaveBeenCalledWith('BIZINFO', 'PBLN_1', expect.any(AbortSignal))
    const card = screen.getByRole('region', { name: '지원 공고' })
    expect(within(card).getByText(supportProgramDetails[0].title)).toBeTruthy()
    expect(within(card).getByText('기업마당')).toBeTruthy()
    const source = within(card).getByRole('link', { name: /원문 보기/ })
    expect(source.getAttribute('href')).toBe(supportProgramDetails[0].sourceUrl)
    expect(source.getAttribute('rel')).toBe('noreferrer')
    expect(source.getAttribute('target')).toBe('_blank')
    expect(screen.getByText(/작성을 시작하기 전까지는 AI를 부르지 않아요/)).toBeTruthy()

    fireEvent.click(nextButton())
    expect(await screen.findByRole('heading', { name: '작성할 양식' })).toBeTruthy()
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toContain('신청 문서 확인')
    // 양식이 하나면 고를 것 없이 요약만, 지원 분야는 "일반 신청" 하나가 아니므로 라디오로 고릅니다.
    expect(screen.queryByRole('radio', { name: new RegExp(firstForm.formTitle) })).toBeNull()
    const fields = screen.getByRole('radiogroup', { name: '작성할 지원 분야' })
    expect((within(fields).getByRole('radio', { name: '컨설팅' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(fields).getByRole('radio', { name: '마케팅' }))
    fireEvent.click(startButton())
    expect(await screen.findByRole('heading', { name: '답변 입력' })).toBeTruthy()
    expect(repository.create).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1',
      formVersionId: firstForm.formVersionId, serviceField: 'MARKETING' }, expect.any(AbortSignal))
    expect(repository.availability).toHaveBeenCalledTimes(1)
    expect(repository.discover).not.toHaveBeenCalled()
    expect(repository.discoveryJob).not.toHaveBeenCalled()
  })

  it('retries a failed program detail and a failed availability lookup, keeping the next step closed meanwhile', async () => {
    getProgramDetail.mockRejectedValueOnce(new Error('공고 상세를 불러오지 못했습니다.'))
    const request = deferred<never>()
    repository.availability.mockReturnValueOnce(request.promise)
    mount(newPath)
    const detailAlert = await screen.findByRole('alert')
    expect(detailAlert.textContent).toContain('공고 상세를 불러오지 못했습니다.')
    fireEvent.click(within(detailAlert).getByRole('button', { name: '다시 시도' }))
    await screen.findByText(supportProgramDetails[0].title)
    expect(screen.getByRole('status').textContent).toContain('저장된 신청 양식을 확인하고 있어요.')
    expect(nextButton().disabled).toBe(true)
    await act(async () => request.reject(new ApplicationPreparationError(504, 'REQUEST_TIMEOUT')))
    const lookupAlert = await screen.findByRole('alert')
    expect(lookupAlert.textContent).toContain('신청 준비 요청 시간이 초과되었습니다.')
    expect(nextButton().disabled).toBe(true)
    fireEvent.click(within(lookupAlert).getByRole('button', { name: '다시 시도' }))
    await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    expect(nextButton().disabled).toBe(false)
    expect(repository.availability).toHaveBeenCalledTimes(2)
    expect(repository.discover).not.toHaveBeenCalled()
  })

  it('picks a saved program in the panel without AI, discards on cancel and applies only on confirm', async () => {
    browseSavedPrograms.mockResolvedValue([{ savedAt: detail.createdAt, program: structuredClone(supportPrograms[0]) }])
    mount('/app/application-preparations/new')
    expect(screen.getByText('신청 문서를 만들 공고를 골라 주세요')).toBeTruthy()
    expect(nextButton().disabled).toBe(true)
    const pickButton = screen.getByRole('button', { name: '공고 고르기' })
    fireEvent.click(pickButton)
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(within(panel).getByText('신청 문서를 만들 공고 1개를 골라 주세요')).toBeTruthy()
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

    fireEvent.click(pickButton)
    const reopened = screen.getByRole('dialog', { name: '공고 고르기' })
    fireEvent.click(await within(reopened).findByRole('radio', { name: new RegExp(supportPrograms[0].title) }))
    await within(reopened).findByText('양식 1개 · 바로 작성할 수 있어요')
    fireEvent.click(within(reopened).getByRole('button', { name: '이 공고 선택' }))
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    const card = screen.getByRole('region', { name: '지원 공고' })
    expect(within(card).getByText(supportPrograms[0].title)).toBeTruthy()
    expect(within(card).getByText('작성할 수 있는 신청 양식 1개를 찾았어요')).toBeTruthy()
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: '공고 바꾸기' }))
    expect(nextButton().disabled).toBe(false)
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
    expect(progress.textContent).toContain('화면을 나가도 계속돼요')
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
    // 필터 칸은 고르는 중인 값만 바꾸고, [검색]을 눌러야 적용됩니다. 지역·분야는 여러 개를 쉼표로 이어 보냅니다.
    fireEvent.click(within(panel).getByRole('button', { name: '필터 (0)' }))
    fireEvent.click(within(panel).getByRole('button', { name: '지역' }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: '서울' }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: '부산' }))
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
    ['NO_FORM', 'NO_FORM', '분석한 공식 첨부에서 작성할 신청 양식을 찾지 못했습니다.'],
    ['DOCUMENT_UNAVAILABLE', 'SOURCE_NOT_FOUND', '공식 공고 또는 첨부가 없어졌거나 변경되었습니다.'],
    ['TOO_LARGE', 'SOURCE_TOO_LARGE', '첨부 파일의 크기나 문서 분량이 분석 제한을 초과했습니다.'],
    ['RETRY_WAITING', 'AI_UNAVAILABLE', 'AI 분석 서비스에 연결하지 못했습니다.'],
    ['REVIEW_REQUIRED', 'RETRY_EXHAUSTED:AI_UNAVAILABLE', 'AI 분석 서비스에 연결하지 못했습니다. 자동 재시도 한도에 도달하여 관리자 확인이 필요합니다.'],
    ['PENDING', 'NOT_ANALYZED', null],
    ['STALE', 'SOURCE_CHANGED', null],
  ])('lets a %s / %s program into step 2 with the analysis card and keeps writing closed', async (status, reasonCode, reason) => {
    repository.availability.mockResolvedValue(availabilityOf(status, reasonCode))
    mount(newPath)
    const notice = await screen.findByText('저장된 신청 양식이 없어요')
    expect(notice.parentElement?.textContent).toContain('다음 단계에서 입력칸별로 분석할 수 있어요.')
    expect(nextButton().disabled).toBe(false)
    fireEvent.click(nextButton())
    const card = await screen.findByRole('region', { name: '저장된 양식이 없어요' })
    expect(within(card).getByText('AI가 공식 첨부를 읽어 문항을 뽑아요 · 계정당 동시에 3건까지')).toBeTruthy()
    if (reason) expect(card.textContent).toContain(reason)
    else expect(card.textContent).not.toContain('최근 분석')
    expect(startButton().disabled).toBe(true)
    expect(repository.discover).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('analyzes a program without a stored form only on click, shows progress and stays in step 2 with a toast', async () => {
    repository.availability.mockResolvedValue(availabilityOf('PENDING', 'NOT_ANALYZED'))
    const started = deferred<ReturnType<typeof completedDiscovery>>()
    repository.discover.mockReturnValueOnce(started.promise)
    mount(newPath)
    await screen.findByText('저장된 신청 양식이 없어요')
    fireEvent.click(nextButton())
    fireEvent.click(await screen.findByRole('button', { name: '입력칸별로 분석' }))
    const progress = await screen.findByRole('status', { name: '양식 분석 진행' })
    expect(progress.textContent).toContain('공식 첨부에서 신청 양식을 분석하고 있어요')
    expect(progress.textContent).toContain('화면을 나가도 계속돼요')
    expect(within(progress).queryByRole('button', { name: '취소' })).toBeNull()
    expect(startButton().disabled).toBe(true)
    await act(async () => started.resolve(completedDiscovery({ items: [structuredClone(firstForm)], warnings: [], cached: false })))
    expect(await screen.findByText('양식을 분석했어요')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '작성할 양식' })).toBeTruthy()
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

  it('lists the account analyses that fill the capacity when starting another one is refused', async () => {
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
    fireEvent.click(nextButton())
    fireEvent.click(await screen.findByRole('button', { name: '입력칸별로 분석' }))
    const alert = await screen.findByRole('alert')
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
    fireEvent.click(nextButton())
    fireEvent.click(await screen.findByRole('button', { name: '입력칸별로 분석' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('양식을 분석하지 못했어요')
    expect(alert.textContent).toContain('신청 준비 정보를 처리하지 못했습니다.')
    expect(screen.queryByRole('heading', { name: '작성할 양식' })).toBeNull()
    expect(startButton().disabled).toBe(true)
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('offers multiple stored forms as radio cards and re-fits the service field to the chosen form', async () => {
    repository.availability.mockResolvedValue(availabilityOf('AVAILABLE', 'FORM_FOUND', [firstForm, { ...secondForm, sourceProgramId: 'PBLN_1' }]))
    mount(newPath)
    const found = await screen.findByText('작성할 수 있는 신청 양식 2개를 찾았어요')
    expect(found.parentElement?.textContent).toContain(`${firstForm.formTitle} · ${secondForm.formTitle}`)
    fireEvent.click(nextButton())
    const forms = await screen.findByRole('radiogroup', { name: '작성할 양식' })
    const [first, second] = within(forms).getAllByRole('radio') as HTMLInputElement[]
    expect([first.checked, second.checked]).toEqual([true, false])
    expect(second.labels?.[0]?.textContent).toContain(secondForm.formTitle)
    fireEvent.click(second)
    const fields = screen.getByRole('radiogroup', { name: '작성할 지원 분야' })
    expect(within(fields).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).checked)).toEqual([true])
    expect(within(fields).getByRole('radio', { name: '마케팅' })).toBeTruthy()
    expect(repository.discover).not.toHaveBeenCalled()
  })

  it('hides the service field choice when the form only supports general applications', async () => {
    repository.availability.mockResolvedValue(availabilityOf('AVAILABLE', 'FORM_FOUND', [{ ...firstForm, supportedServiceFields: ['GENERAL'] }]))
    mount(newPath)
    await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    fireEvent.click(nextButton())
    await screen.findByRole('heading', { name: '작성할 양식' })
    expect(screen.queryByRole('radiogroup', { name: '작성할 지원 분야' })).toBeNull()
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

  it('keeps the stored availability when moving between steps', async () => {
    mount(newPath)
    await screen.findByText('작성할 수 있는 신청 양식 1개를 찾았어요')
    fireEvent.click(nextButton())
    await screen.findByRole('heading', { name: '작성할 양식' })
    fireEvent.click(screen.getByRole('button', { name: '이전' }))
    expect(screen.getByText('작성할 수 있는 신청 양식 1개를 찾았어요')).toBeTruthy()
    fireEvent.click(nextButton())
    await screen.findByRole('heading', { name: '작성할 양식' })
    expect(repository.availability).toHaveBeenCalledTimes(1)
  })

  it('displays the complete official detail without starting AI', async () => {
    mount('/app/application-preparations/12')
    await screen.findByRole('heading', { name: '답변 입력' })

    const crumbs = screen.getByRole('navigation', { name: '상위 화면' })
    expect(within(crumbs).getByRole('link', { name: '신청 문서 작성' }).getAttribute('href')).toBe('/app/application-preparations')
    expect(screen.getByText(firstForm.programTitle)).toBeTruthy()
    expect(screen.getByText(firstForm.attachmentFileName)).toBeTruthy()
    expect(screen.queryByText('양식명')).toBeNull()
    expect(screen.queryByText('파일 SHA-256')).toBeNull()
    expect(screen.getByRole('link', { name: /원문 보기/ }).getAttribute('href')).toBe(firstForm.sourceUrl)
    expect(screen.getAllByLabelText('작성 상태: 시작 전')).toHaveLength(2)
    expect(screen.getByText('1. 기업 개요')).toBeTruthy()
    expect(screen.getByText('항목 1 / 2 · 질문 1 / 2')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /업체명/ })).toBeTruthy()
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('입력하면 자동으로 저장돼요'))).toBe(true)
    expect(screen.queryByRole('link', { name: '문서 보기' })).toBeNull()
    expect(repository.create).not.toHaveBeenCalled()
    expect(repository.interpret).not.toHaveBeenCalled()
    expect(repository.replaceInputs).not.toHaveBeenCalled()
  })

  it('opens the first unanswered required question and links to existing documents', async () => {
    const ready = readyPreparation()
    ready.form.sections[1].facts = []
    repository.get.mockResolvedValue(ready)
    repository.documents.mockResolvedValue([documentFile])
    mount('/app/application-preparations/12')
    await screen.findByText('항목 2 / 2 · 질문 2 / 2')
    expect(screen.getByRole('heading', { name: /과제명/ })).toBeTruthy()
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByRole('link', { name: '문서 보기' }).getAttribute('href')).toBe('/app/application-preparations/12/documents')
    fireEvent.click(screen.getByRole('button', { name: '문서 메뉴' }))
    const menu = screen.getByRole('menu', { name: '문서 메뉴' })
    expect(within(menu).getByRole('menuitem', { name: '원문 보기 ↗' }).getAttribute('href')).toBe(firstForm.sourceUrl)
    expect(within(menu).getByRole('menuitem', { name: '양식 다시 분석해 새로 시작' }).getAttribute('href')).toBe('/app/application-preparations/new?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
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
    expect(screen.getByText('답변 1 / 1 · 완료')).toBeTruthy()
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
    echoReplaceInputs(detail)
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
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
    await screen.findByText('항목 1 / 1 · 질문 1 / 16')
    expect(screen.getByText('안내문1')).toBeTruthy()
    expect(screen.queryByText('안내문2')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '첫 번째 답변' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByText('항목 1 / 1 · 질문 2 / 16')).toBeTruthy()
    expect(screen.getByText('안내문2')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '두 번째 답변' } })
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('첫 번째 답변')
    await waitFor(() => expect(screen.getByText('답변 2 / 16 · 진행 중')).toBeTruthy())
    for (let index = 0; index < 15; index++) fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByText('항목 1 / 1 · 질문 16 / 16')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '다음 →' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '초안 만들기' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(repository.interpret).not.toHaveBeenCalled()
    // 이동할 때마다 바뀐 항목만 저장합니다. 답변이 그대로면 요청을 보내지 않습니다.
    expect(repository.replaceInputs).toHaveBeenCalledTimes(2)
  })

  it('shows one question at a time, crosses section boundaries with one bar and keeps answers', async () => {
    echoReplaceInputs(detail)
    mount('/app/application-preparations/12')
    const first = await screen.findByRole('region', { name: '기업 개요 작성' })
    expect(screen.queryByRole('region', { name: '바우처 활용 계획 작성' })).toBeNull()
    expect((screen.getByRole('button', { name: '← 이전' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(first).getByRole('textbox'), { target: { value: '업체명은 새봄테크입니다.' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.queryByRole('region', { name: '기업 개요 작성' })).toBeNull()
    const second = screen.getByRole('region', { name: '바우처 활용 계획 작성' })
    fireEvent.change(within(second).getByRole('textbox'), { target: { value: '새로운 과제입니다.' } })
    // 마지막 질문: 아래 바의 [다음 →] 자리에 [초안 만들기]가 옵니다.
    expect(screen.queryByRole('button', { name: '다음 →' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '초안 만들기' })).toHaveLength(2)
    const list = screen.getByRole('complementary', { name: '신청 문서 작성 항목 목록' })
    fireEvent.click(within(list).getByRole('button', { name: /1. 기업 개요/ }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('업체명은 새봄테크입니다.')
    expect(within(list).getByRole('button', { name: /1. 기업 개요/ }).getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect((screen.getByLabelText('답변 입력') as HTMLTextAreaElement).value).toBe('새로운 과제입니다.')
    await waitFor(() => expect(repository.replaceInputs).toHaveBeenCalledTimes(2))
    expect(repository.interpret).not.toHaveBeenCalled()
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
