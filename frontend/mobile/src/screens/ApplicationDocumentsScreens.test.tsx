import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import { useAuth } from '../auth/session'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { programClient } from '../api/client'
import { listReviewSavedPrograms } from '../api/combinationReviews'
import { shareApplicationFile } from '../api/applicationDocumentFiles'
import { readPendingPreparation } from '../auth/preparationPending'
import { ApplicationDocumentsListScreen } from './ApplicationDocumentsListScreen'
import { ApplicationPreparationNewScreen } from './ApplicationPreparationNewScreen'
import { ApplicationDocumentScreen } from './ApplicationDocumentScreen'
import { documentFile, documentForm, documentJob, documentPreparation, documentProgram, documentSummary } from '../test/applicationDocumentFixtures'

jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => () => void) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(callback, [callback])
} }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../api/combinationReviews', () => ({ listReviewSavedPrograms: jest.fn() }))
jest.mock('../api/applicationDocumentFiles', () => ({ shareApplicationFile: jest.fn() }))
jest.mock('../auth/preparationPending', () => ({ readPendingPreparation: jest.fn(), savePendingPreparation: jest.fn().mockResolvedValue(undefined), clearPendingPreparation: jest.fn().mockResolvedValue(undefined) }))
const api = {
  list: jest.fn(), recentDocumentJobs: jest.fn(), discoveryJobs: jest.fn(), delete: jest.fn(), availability: jest.fn(), markDiscoveryJobsSeen: jest.fn(),
  discover: jest.fn(), create: jest.fn(), get: jest.fn(), documents: jest.fn(), documentJobs: jest.fn(), documentJob: jest.fn(), markDocumentJobsSeen: jest.fn(),
  submitDocumentJob: jest.fn(), downloadDocument: jest.fn(), downloadDocumentArchive: jest.fn(), confirmDocumentMappingMigration: jest.fn(),
}
const auth = { status: 'signedIn', session: { accessToken: 'owned-token', account: { email: 'first@test.com' } }, invalidateSession: jest.fn() }
const listProps = { onLogin: jest.fn(), onNew: jest.fn(), onOpen: jest.fn() }
const newProps = { onLogin: jest.fn(), onOpenProgram: jest.fn(), onCreated: jest.fn(), onList: jest.fn(), onPendingDocument: jest.fn() }
const docProps = { id: 9, onLogin: jest.fn(), onEditor: jest.fn(), onReanalyze: jest.fn(), onOnline: jest.fn(), onList: jest.fn(), onOpenPending: jest.fn() }
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  jest.mocked(useAuth).mockReturnValue(auth as unknown as ReturnType<typeof useAuth>)
  Object.values(api).forEach(fn => fn.mockReset())
  Object.values(listProps).forEach(fn => fn.mockClear()); Object.values(newProps).forEach(fn => fn.mockClear())
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
  jest.mocked(readPendingPreparation).mockResolvedValue(null)
  api.list.mockResolvedValue({ items: [documentSummary], nextBeforeId: null }); api.recentDocumentJobs.mockResolvedValue([]); api.discoveryJobs.mockResolvedValue([]); api.delete.mockResolvedValue(undefined)
  api.availability.mockResolvedValue({ state: { status: 'AVAILABLE' }, forms: { items: [documentForm] } }); api.markDiscoveryJobsSeen.mockResolvedValue(undefined); api.create.mockResolvedValue(documentPreparation)
  api.get.mockResolvedValue(documentPreparation); api.documents.mockResolvedValue([documentFile]); api.documentJobs.mockResolvedValue([documentJob]); api.documentJob.mockResolvedValue(documentJob); api.markDocumentJobsSeen.mockResolvedValue(undefined)
  api.downloadDocument.mockResolvedValue(new Blob(['data'], { type: 'application/hwp+zip' })); jest.mocked(shareApplicationFile).mockResolvedValue(undefined)
  jest.mocked(listReviewSavedPrograms).mockResolvedValue([documentProgram])
  jest.mocked(programClient).mockReturnValue({ browseCatalog: jest.fn().mockResolvedValue({ programs: [documentProgram], total: 1, page: 1, pageSize: 12, totalPages: 1,
    regions: ['서울'], categories: ['기술'], startupStages: [], applicantTypes: [], founderAges: [] }) } as unknown as ReturnType<typeof programClient>)
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.restoreAllMocks() })

test('list management identifies its deletion target and does not delete before confirmation', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  render(<ApplicationDocumentsListScreen {...listProps} />)
  await screen.findByText('사업계획서')
  fireEvent.press(screen.getByText('문서 관리'))
  fireEvent.press(screen.getByLabelText('사업계획서 삭제'))
  expect(api.delete).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('이 신청문서를 삭제할까요?', expect.stringContaining('테스트 신청 지원사업'), expect.any(Array))
  const buttons = alert.mock.calls[0][2]!
  await act(async () => { buttons.find(button => button.style === 'destructive')!.onPress!() })
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith(9, expect.any(AbortSignal)))
})
test('active generation blocks deletion and opens its result without submitting again', async () => {
  api.recentDocumentJobs.mockResolvedValue([{ ...documentJob, status: 'RUNNING', fileIds: [], finishedAt: null }])
  render(<ApplicationDocumentsListScreen {...listProps} />)
  await screen.findByText('초안 만드는 중')
  fireEvent.press(screen.getByText('문서 관리'))
  expect(screen.getByLabelText('사업계획서 삭제').props.accessibilityState.disabled).toBe(true)
  fireEvent.press(screen.getByText('생성 결과 확인'))
  expect(listProps.onOpen).toHaveBeenCalledWith(9, true)
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})
test('guest list does not read private document jobs', () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
  render(<ApplicationDocumentsListScreen {...listProps} />)
  fireEvent.press(screen.getByText('로그인하고 시작하기'))
  expect(listProps.onLogin).toHaveBeenCalled()
  expect(api.list).not.toHaveBeenCalled(); expect(api.recentDocumentJobs).not.toHaveBeenCalled()
})
test('document picker reuses filter and saved cards, separates details from selection and uses cached forms without AI', async () => {
  render(<ApplicationPreparationNewScreen {...newProps} />)
  await screen.findByLabelText(`${documentProgram.title}, 상세 보기`)
  fireEvent.press(screen.getByLabelText(`${documentProgram.title}, 상세 보기`))
  expect(newProps.onOpenProgram).toHaveBeenCalledWith({ sourceCode: documentProgram.sourceCode, sourceProgramId: documentProgram.id })
  expect(screen.getByLabelText('다음 · 양식 확인').props.accessibilityState.disabled).toBe(true)
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '저장할 검색어')
  fireEvent.press(screen.getByLabelText(`${documentProgram.title} 선택`))
  fireEvent.press(screen.getByLabelText('관심 공고함'))
  await screen.findByText('✓ 작성 대상 선택됨')
  fireEvent.press(screen.getByLabelText('필터 검색'))
  expect(screen.getByLabelText('공고명·기관명').props.value).toBe('저장할 검색어')
  fireEvent.press(screen.getByLabelText('다음 · 양식 확인'))
  await screen.findByText('사업계획서.hwpx')
  expect(api.discover).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('이 양식으로 작성 시작'))
  await waitFor(() => expect(newProps.onCreated).toHaveBeenCalledWith(9))
  expect(api.create).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123', formVersionId: 'test-form-v1', serviceField: 'GENERAL' }, expect.any(AbortSignal))
})
test('opening a completed result only reads jobs and downloads the selected owned file', async () => {
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 완료')
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 기기에 저장'))
  await waitFor(() => expect(shareApplicationFile).toHaveBeenCalledWith('https://api.example.test:first@test.com', expect.any(Blob), '사업계획서.hwpx', expect.any(Function), expect.any(AbortSignal), 'save'))
  expect(api.downloadDocument).toHaveBeenCalledWith(9, 11, expect.any(AbortSignal))
})
test('unknown generation offers a read-only recovery and never automatic paid retries', async () => {
  const unknown = { ...documentJob, status: 'UNKNOWN', fileIds: [], failureCode: 'APPLICATION_DOCUMENT_OUTCOME_UNKNOWN', finishedAt: documentJob.finishedAt }
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([unknown]); api.documentJob.mockResolvedValue(unknown)
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 결과를 확인하고 있어요')
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('초안 만들기')).toBeNull()
})

test('current generated documents retain overflow guidance and remaining examples for manual completion', async () => {
  api.documents.mockResolvedValue([{ ...documentFile, filledAnswerCount: 1, unfilledAnswerCount: 1, remainingExampleCount: 2,
    unfilledAnswers: [{ fieldId: 'company:goal', fieldLabel: '추진 목표', value: '길어서 들어가지 않은 목표', reason: 'OVERFLOW', capacity: 12 }] }])
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('직접 작성할 칸 2곳에 예시 문구가 남아 있어요. 제출 전에 지워 주세요.')
  expect(screen.getByText('추진 목표: 칸보다 길어 넣지 못했어요. 약 12자 이내로 줄여 주세요.')).toBeTruthy()
  expect(screen.getByText('길어서 들어가지 않은 목표')).toBeTruthy()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})
