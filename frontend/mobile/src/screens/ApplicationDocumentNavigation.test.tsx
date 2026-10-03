import { act, fireEvent, waitFor } from '@testing-library/react-native'
import { Text } from 'react-native'
import { Stack, router } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { shareApplicationFile } from '../api/applicationDocumentFiles'
import { useAuth } from '../auth/session'
import { ApplicationDocumentScreen } from './ApplicationDocumentScreen'
import { ApplicationOnlineInputScreen } from './ApplicationOnlineInputScreen'
import { ApplicationPreparationEditorScreen } from './ApplicationPreparationEditorScreen'
import { documentFile, documentForm, documentJob, documentPreparation } from '../test/applicationDocumentFixtures'

jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn() }))
jest.mock('../api/applicationDocumentFiles', () => ({ shareApplicationFile: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/preparationPending', () => ({ readPendingPreparation: jest.fn().mockResolvedValue(null) }))
const api = { get: jest.fn(), documents: jest.fn(), documentJobs: jest.fn(), documentJob: jest.fn(), markDocumentJobsSeen: jest.fn(),
  downloadDocument: jest.fn(), onlineInputGuide: jest.fn(), submitDocumentJob: jest.fn() }
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
  documents: () => <ApplicationDocumentScreen id={9} onLogin={jest.fn()} onEditor={jest.fn()} onReanalyze={jest.fn()}
    onOnline={() => router.push('/online')} onList={jest.fn()} onOpenPending={jest.fn()} />,
  online: () => <ApplicationOnlineInputScreen id={9} onLogin={jest.fn()} onEditor={() => router.push('/other')} />,
  other: () => <Text>다른 화면</Text>,
  review: () => <ApplicationPreparationEditorScreen id={9} reviewing onLogin={jest.fn()} onEditor={jest.fn()} onReview={jest.fn()}
    onDocuments={jest.fn()} onReanalyze={jest.fn()} />,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
const blob = () => new Blob(['data'], { type: 'application/hwp+zip' })
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  Object.values(api).forEach(fn => fn.mockReset())
  jest.mocked(shareApplicationFile).mockReset().mockResolvedValue(undefined)
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

test('TXT sharing loses its permission on blur and a new attempt is available after returning', async () => {
  const sharing = deferred<void>()
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
  await act(async () => { sharing.resolve(undefined); router.back() })
  await screen.findByText('준비된 답변 1 / 1')
  fireEvent.press(screen.getByLabelText('TXT로 내려받기·공유'))
  await waitFor(() => expect(shareApplicationFile).toHaveBeenCalledTimes(2))
})

test('the review cannot submit generation when every saved answer is undecided', async () => {
  api.get.mockResolvedValue({ ...documentPreparation, form: { ...documentForm, sections: documentForm.sections.map(section => ({ ...section,
    facts: section.facts.map(fact => ({ ...fact, status: 'UNKNOWN', value: null })),
  })) } })
  renderRouter(routes, { initialUrl: '/review' })
  await screen.findByText('필수 답변을 저장했어요. 미정인 답변 2개는 자동으로 기입하지 않아요.')
  const generate = screen.getByLabelText('공식 양식으로 초안 만들기')
  expect(generate.props.accessibilityState.disabled).toBe(true)
  fireEvent.press(generate)
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})
