import { act, fireEvent, waitFor } from '@testing-library/react-native'
import { useState } from 'react'
import { Text } from 'react-native'
import { Stack, router } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { shareApplicationFile, type ApplicationFileResult } from '../api/applicationDocumentFiles'
import { useAuth } from '../auth/session'
import { readPendingPreparation, savePendingPreparation, clearPendingPreparation } from '../auth/preparationPending'
import { ApplicationDocumentScreen } from './ApplicationDocumentScreen'
import { ApplicationOnlineInputScreen } from './ApplicationOnlineInputScreen'
import { ApplicationPreparationEditorScreen } from './ApplicationPreparationEditorScreen'
import { documentFile, documentForm, documentJob, documentPreparation } from '../test/applicationDocumentFixtures'

jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn() }))
jest.mock('../api/applicationDocumentFiles', () => ({ shareApplicationFile: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }))
jest.mock('../auth/preparationPending', () => ({ readPendingPreparation: jest.fn(), savePendingPreparation: jest.fn(), clearPendingPreparation: jest.fn() }))
const api = { get: jest.fn(), documents: jest.fn(), documentJobs: jest.fn(), documentJob: jest.fn(), markDocumentJobsSeen: jest.fn(),
  downloadDocument: jest.fn(), onlineInputGuide: jest.fn(), submitDocumentJob: jest.fn(), replaceInputs: jest.fn() }
const onDocuments = jest.fn()
let enterReview: () => void
function EditableReviewRoute() {
  const [reviewing, setReviewing] = useState(false)
  enterReview = () => setReviewing(true)
  return <ApplicationPreparationEditorScreen id={9} reviewing={reviewing} onLogin={jest.fn()} onEditor={jest.fn()}
    onReview={jest.fn()} onDocuments={onDocuments} onReanalyze={jest.fn()} />
}
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
  documents: () => <ApplicationDocumentScreen id={9} onLogin={jest.fn()} onEditor={jest.fn()} onReanalyze={jest.fn()}
    onOnline={() => router.push('/online')} onList={jest.fn()} onOpenPending={jest.fn()} />,
  online: () => <ApplicationOnlineInputScreen id={9} onLogin={jest.fn()} onEditor={() => router.push('/other')} />,
  other: () => <Text>다른 화면</Text>,
  review: () => <ApplicationPreparationEditorScreen id={9} reviewing onLogin={jest.fn()} onEditor={jest.fn()} onReview={jest.fn()}
    onDocuments={onDocuments} onReanalyze={jest.fn()} />,
  editable: EditableReviewRoute,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
function savedPreparation(name: string) {
  return { ...documentPreparation, inputRevision: 2, form: { ...documentForm,
    sections: documentForm.sections.map(section => ({ ...section, facts: section.facts.map(fact => ({ ...fact, inputRevision: 2,
      value: fact.fieldKey === 'name' ? name : fact.value, sourceText: fact.fieldKey === 'name' ? name : fact.sourceText,
    })) })) } }
}
const blob = () => new Blob(['data'], { type: 'application/hwp+zip' })
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  Object.values(api).forEach(fn => fn.mockReset())
  onDocuments.mockReset()
  jest.mocked(readPendingPreparation).mockReset().mockResolvedValue(null)
  jest.mocked(savePendingPreparation).mockReset().mockResolvedValue(undefined)
  jest.mocked(clearPendingPreparation).mockReset().mockResolvedValue(undefined)
  api.submitDocumentJob.mockResolvedValue(documentJob)
  jest.mocked(shareApplicationFile).mockReset().mockResolvedValue({ status: 'shareClosed' })
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owned', account: { email: 'owner@test.com' } },
    invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  api.get.mockResolvedValue(documentPreparation); api.documents.mockResolvedValue([documentFile]); api.documentJobs.mockResolvedValue([documentJob])
  api.documentJob.mockResolvedValue(documentJob); api.markDocumentJobsSeen.mockResolvedValue(undefined); api.downloadDocument.mockResolvedValue(blob())
  api.onlineInputGuide.mockResolvedValue({ preparationId: 9, inputRevision: 1, totalCount: 1, readyCount: 1, needsReviewCount: 0, missingCount: 0,
    directInputCount: 0, externalMappingVerified: false, officialApplicationUrl: null, items: [], savedAnswers: [{ fieldId: 'company:name', label: '기업명', answer: '테스트 기업' }] })
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.restoreAllMocks() })

test('Stack navigation aborts a pending download and a late response cannot open sharing after returning', async () => {
  const download = deferred<Blob>()
  api.downloadDocument.mockReturnValueOnce(download.promise)
  renderRouter(routes, { initialUrl: '/documents' })
  await screen.findByText('초안 완료')
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 공유'))
  await waitFor(() => expect(api.downloadDocument).toHaveBeenCalledTimes(1))
  const signal: AbortSignal = api.downloadDocument.mock.calls[0][2]
  fireEvent.press(screen.getByLabelText('온라인 신청 입력 도우미'))
  await screen.findByText('온라인 신청을 준비하세요')
  expect(signal.aborted).toBe(true)
  await act(async () => router.back())
  await screen.findByText('초안 완료')
  await act(async () => download.resolve(blob()))
  expect(shareApplicationFile).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 공유'))
  await waitFor(() => expect(shareApplicationFile).toHaveBeenCalledTimes(1))
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('leaving during native saving prevents a late saved notice and blocks repeated taps', async () => {
  const saving = deferred<ApplicationFileResult>()
  jest.mocked(shareApplicationFile).mockReturnValueOnce(saving.promise)
  renderRouter(routes, { initialUrl: '/documents' })
  await screen.findByText('초안 완료')
  const save = screen.getByLabelText('사업계획서.hwpx 기기에 저장')
  fireEvent.press(save); fireEvent.press(save)
  await waitFor(() => expect(shareApplicationFile).toHaveBeenCalledTimes(1))
  expect(api.downloadDocument).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('온라인 신청 입력 도우미'))
  await screen.findByText('온라인 신청을 준비하세요')
  await act(async () => { saving.resolve({ status: 'saved', fileName: '사업계획서.hwpx', renamed: false }); router.back() })
  await screen.findByText('초안 완료')
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('TXT sharing loses its permission on blur and a new attempt is available after returning', async () => {
  const sharing = deferred<ApplicationFileResult>()
  jest.mocked(shareApplicationFile).mockReturnValueOnce(sharing.promise)
  renderRouter(routes, { initialUrl: '/online' })
  await screen.findByText('준비된 답변 1 / 1')
  fireEvent.press(screen.getByLabelText('TXT로 내려받기·공유'))
  await waitFor(() => expect(shareApplicationFile).toHaveBeenCalledTimes(1))
  const [, , , isCurrent, signal] = jest.mocked(shareApplicationFile).mock.calls[0]
  expect(isCurrent()).toBe(true)
  fireEvent.press(screen.getByLabelText('답변 입력으로 돌아가기'))
  await screen.findByText('다른 화면')
  expect(signal!.aborted).toBe(true)
  expect(isCurrent()).toBe(false)
  await act(async () => { sharing.resolve({ status: 'shareClosed' }); router.back() })
  await screen.findByText('준비된 답변 1 / 1')
  expect(screen.queryByText('공유 화면을 닫았어요.')).toBeNull()
  fireEvent.press(screen.getByLabelText('TXT로 내려받기·공유'))
  await waitFor(() => expect(shareApplicationFile).toHaveBeenCalledTimes(2))
  await screen.findByText('공유 화면을 닫았어요.')
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
})

test.each(['empty', 'undecided', 'partial'] as const)('the review explicitly creates a draft for %s answers and never creates on entry', async kind => {
  api.get.mockResolvedValue({ ...documentPreparation, form: { ...documentForm, sections: documentForm.sections.map(section => ({ ...section,
    facts: kind === 'empty' ? [] : kind === 'partial' ? section.facts.slice(0, 1) : section.facts.map(fact => ({ ...fact, status: 'UNKNOWN', value: null })),
  })) } })
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([])
  renderRouter(routes, { initialUrl: '/review' })
  const generate = await screen.findByRole('button', { name: '공식 양식으로 초안 만들기' })
  expect(generate).toBeEnabled()
  if (kind === 'partial') expect(screen.getByText('비워 둔 채로도 초안을 만들 수 있어요. 비운 질문은 문서에 빈칸으로 남아요.')).toBeTruthy()
  else expect(screen.getByText(/AI를 호출하지 않아요/)).toBeTruthy()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  fireEvent.press(generate)
  await waitFor(() => expect(api.submitDocumentJob).toHaveBeenCalledWith(9, 1, expect.any(AbortSignal), '11111111-1111-4111-8111-111111111111'))
  expect(savePendingPreparation).toHaveBeenCalledWith('https://api.example.test', 'owner@test.com', {
    kind: 'document', preparationId: 9, expectedRevision: 1, requestKey: '11111111-1111-4111-8111-111111111111',
  })
  await waitFor(() => expect(onDocuments).toHaveBeenCalledWith(documentJob.id))
  expect(api.submitDocumentJob).toHaveBeenCalledTimes(1)
  expect(clearPendingPreparation).toHaveBeenCalledTimes(1)
})

test('the review saves pending edits and uses the acknowledged revision for generation', async () => {
  const saving = deferred<typeof documentPreparation>()
  api.replaceInputs.mockReturnValue(saving.promise)
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([])
  renderRouter(routes, { initialUrl: '/editable' })
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '저장 후 생성할 기업')
  await act(async () => enterReview())
  fireEvent.press(screen.getByLabelText('공식 양식으로 초안 만들기'))
  await waitFor(() => expect(api.replaceInputs).toHaveBeenCalledTimes(1))
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  await act(async () => saving.resolve(savedPreparation('저장 후 생성할 기업')))
  await waitFor(() => expect(api.submitDocumentJob).toHaveBeenCalledWith(9, 2, expect.any(AbortSignal), '11111111-1111-4111-8111-111111111111'))
})

test('a failed save keeps pending edits and prevents generation even when empty answers are allowed', async () => {
  api.replaceInputs.mockRejectedValue(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  renderRouter(routes, { initialUrl: '/editable' })
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '저장 실패에도 보존할 기업')
  await act(async () => enterReview())
  fireEvent.press(screen.getByLabelText('공식 양식으로 초안 만들기'))
  await screen.findByRole('button', { name: '저장 다시 시도' })
  expect(screen.getByText('저장 실패에도 보존할 기업')).toBeTruthy()
  expect(api.documents).not.toHaveBeenCalled()
  expect(savePendingPreparation).not.toHaveBeenCalled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('repeated original-draft taps share a single reservation before preflight completes', async () => {
  const files = deferred<Array<typeof documentFile>>()
  api.get.mockResolvedValue({ ...documentPreparation, form: { ...documentForm, sections: documentForm.sections.map(section => ({ ...section, facts: [] })) } })
  api.documents.mockReturnValue(files.promise); api.documentJobs.mockResolvedValue([])
  renderRouter(routes, { initialUrl: '/review' })
  const generate = await screen.findByRole('button', { name: '공식 양식으로 초안 만들기' })
  await act(async () => { fireEvent.press(generate); fireEvent.press(generate) })
  await waitFor(() => expect(api.documents).toHaveBeenCalledTimes(1))
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  await act(async () => files.resolve([]))
  await waitFor(() => expect(api.submitDocumentJob).toHaveBeenCalledTimes(1))
  expect(savePendingPreparation).toHaveBeenCalledTimes(1)
})

test.each([1, 2])('an unresolved job blocks new generation even when its revision is %s', async revision => {
  api.get.mockResolvedValue({ ...documentPreparation, inputRevision: 2 })
  api.documents.mockResolvedValue([])
  api.documentJobs.mockResolvedValue([{ ...documentJob, status: 'UNKNOWN', expectedRevision: revision, fileIds: [], failureCode: 'RUN_OUTCOME_UNKNOWN' }])
  renderRouter(routes, { initialUrl: '/review' })
  fireEvent.press(await screen.findByRole('button', { name: '공식 양식으로 초안 만들기' }))
  await screen.findByText('이전 생성 결과를 아직 확인하지 못했어요. 새 초안 생성을 시작하지 않았어요.')
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  expect(savePendingPreparation).not.toHaveBeenCalled()
})

test('the current revision file opens the result instead of submitting another draft', async () => {
  renderRouter(routes, { initialUrl: '/review' })
  fireEvent.press(await screen.findByRole('button', { name: '공식 양식으로 초안 만들기' }))
  await waitFor(() => expect(onDocuments).toHaveBeenCalledWith())
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  expect(savePendingPreparation).not.toHaveBeenCalled()
})

test('unmounting during input saving cannot submit a late generation request', async () => {
  const saving = deferred<typeof documentPreparation>()
  api.replaceInputs.mockReturnValue(saving.promise)
  const view = renderRouter(routes, { initialUrl: '/editable' })
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '이탈 전에 입력한 기업')
  await act(async () => enterReview())
  fireEvent.press(screen.getByLabelText('공식 양식으로 초안 만들기'))
  await waitFor(() => expect(api.replaceInputs).toHaveBeenCalledTimes(1))
  view.unmount()
  await act(async () => saving.resolve(savedPreparation('이탈 전에 입력한 기업')))
  expect(api.documents).not.toHaveBeenCalled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})
