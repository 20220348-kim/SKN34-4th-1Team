import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert, AppState, type AppStateStatus } from 'react-native'
import { useAuth } from '../auth/session'
import { applicationPreparationUseCase, discardDeletedPendingPreparation } from '../api/applicationPreparation'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
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
jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn(), discardDeletedPendingPreparation: jest.fn() }))
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
function captureTimeouts() {
  const original = globalThis.setTimeout
  const calls: Parameters<typeof setTimeout>[] = [], results: ReturnType<typeof setTimeout>[] = []
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    calls.push(args); const timer = original(...args); results.push(timer); return timer
  }) as typeof setTimeout
  return { calls, results, restore: () => { globalThis.setTimeout = original } }
}
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  jest.mocked(useAuth).mockReturnValue(auth as unknown as ReturnType<typeof useAuth>)
  Object.values(api).forEach(fn => fn.mockReset())
  Object.values(listProps).forEach(fn => fn.mockClear()); Object.values(newProps).forEach(fn => fn.mockClear())
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
  jest.mocked(readPendingPreparation).mockReset().mockResolvedValue(null)
  jest.mocked(discardDeletedPendingPreparation).mockReset().mockResolvedValue(undefined)
  api.list.mockResolvedValue({ items: [documentSummary], nextBeforeId: null }); api.recentDocumentJobs.mockResolvedValue([]); api.discoveryJobs.mockResolvedValue([]); api.delete.mockResolvedValue(undefined)
  api.availability.mockResolvedValue({ state: { status: 'AVAILABLE' }, forms: { items: [documentForm] } }); api.markDiscoveryJobsSeen.mockResolvedValue(undefined); api.create.mockResolvedValue(documentPreparation)
  api.get.mockResolvedValue(documentPreparation); api.documents.mockResolvedValue([documentFile]); api.documentJobs.mockResolvedValue([documentJob]); api.documentJob.mockResolvedValue(documentJob); api.markDocumentJobsSeen.mockResolvedValue(undefined)
  api.downloadDocument.mockResolvedValue(new Blob(['data'], { type: 'application/hwp+zip' })); jest.mocked(shareApplicationFile).mockReset().mockResolvedValue({ status: 'shareClosed' })
  jest.mocked(listReviewSavedPrograms).mockResolvedValue([documentProgram])
  jest.mocked(programClient).mockReturnValue({ browseCatalog: jest.fn().mockResolvedValue({ programs: [documentProgram], total: 1, page: 1, pageSize: 12, totalPages: 1,
    regions: ['서울'], categories: ['기술'], startupStages: [], applicantTypes: [], founderAges: [] }) } as unknown as ReturnType<typeof programClient>)
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.restoreAllMocks() })

test('saving reports the final numbered filename after copying finishes', async () => {
  jest.mocked(shareApplicationFile).mockResolvedValueOnce({ status: 'saved', fileName: '사업계획서 (2).hwpx', renamed: true })
  render(<ApplicationDocumentScreen {...docProps} />)
  // 이 파일의 첫 테스트라 첫 렌더가 모듈을 처음 읽는 시간까지 떠안습니다. 느린 CI에서 기본 1초를 넘겨 실패하지 않게 첫 화면만 넉넉히 기다립니다.
  await screen.findByText('초안 완료', {}, { timeout: 5000 })
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 기기에 저장'))
  await screen.findByText('사업계획서 (2).hwpx 파일을 저장했어요. 같은 이름의 파일이 있어 번호를 붙였어요.')
  expect(shareApplicationFile).toHaveBeenCalledWith('https://api.example.test:first@test.com', expect.any(Blob), documentFile.fileName, expect.any(Function), expect.any(AbortSignal), 'save')
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('a cancelled retry removes the previous saved notice without showing an error or new success', async () => {
  jest.mocked(shareApplicationFile).mockResolvedValueOnce({ status: 'saved', fileName: documentFile.fileName, renamed: false })
    .mockResolvedValueOnce({ status: 'cancelled' })
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 완료')
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 기기에 저장'))
  await screen.findByText('사업계획서.hwpx 파일을 저장했어요.')
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 기기에 저장'))
  await waitFor(() => expect(shareApplicationFile).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByLabelText('사업계획서.hwpx 기기에 저장').props.accessibilityState.disabled).toBe(false))
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
  expect(screen.queryByText(/저장할 폴더를 열지 못했어요/)).toBeNull()
})

test('copy failure shows its error and never shows a saved notice', async () => {
  jest.mocked(shareApplicationFile).mockRejectedValueOnce(new Error('파일을 저장하지 못했어요. 선택한 폴더의 접근 권한과 저장 공간을 확인해 주세요.'))
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 완료')
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 기기에 저장'))
  await screen.findByText(/파일을 저장하지 못했어요/)
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('sharing reports only share sheet closure without a saved notice', async () => {
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 완료')
  fireEvent.press(screen.getByLabelText('사업계획서.hwpx 공유'))
  await screen.findByText('공유 화면을 닫았어요.')
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
})

test('archive saving and sharing use the same current revision ZIP download without regenerating it', async () => {
  api.documents.mockResolvedValue([documentFile, { ...documentFile, id: 82, fileName: '별첨.pdf', mediaType: 'application/pdf' }])
  api.downloadDocumentArchive.mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }))
  const name = `신청문서-9-답변${documentPreparation.inputRevision}.zip`
  jest.mocked(shareApplicationFile).mockResolvedValueOnce({ status: 'saved', fileName: name, renamed: false })
    .mockResolvedValueOnce({ status: 'shareClosed' })
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByLabelText('현재 답변 파일 ZIP 기기에 저장')
  fireEvent.press(screen.getByLabelText('현재 답변 파일 ZIP 기기에 저장'))
  await screen.findByText(`${name} 파일을 저장했어요.`)
  expect(api.downloadDocumentArchive).toHaveBeenCalledWith(9, documentPreparation.inputRevision, expect.any(AbortSignal))
  expect(shareApplicationFile).toHaveBeenNthCalledWith(1, 'https://api.example.test:first@test.com', expect.any(Blob), name, expect.any(Function), expect.any(AbortSignal), 'save')
  fireEvent.press(screen.getByLabelText('현재 답변 파일 ZIP 공유'))
  await screen.findByText('공유 화면을 닫았어요.')
  expect(shareApplicationFile).toHaveBeenNthCalledWith(2, 'https://api.example.test:first@test.com', expect.any(Blob), name, expect.any(Function), expect.any(AbortSignal), 'share')
  expect(api.downloadDocument).not.toHaveBeenCalled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

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

test('a storage failure remains visible after selecting a form and retry restores the original pending analysis key without posting', async () => {
  const pending = { kind: 'discovery' as const, sourceCode: documentProgram.sourceCode, sourceProgramId: documentProgram.id,
    requestKey: '11111111-1111-4111-8111-111111111111' }
  jest.mocked(readPendingPreparation).mockRejectedValueOnce(new Error('보관 요청 조회 실패')).mockResolvedValue(pending)
  render(<ApplicationPreparationNewScreen {...newProps} />)
  await screen.findByText('보관 요청 조회 실패')
  fireEvent.press(screen.getByLabelText(`${documentProgram.title} 선택`))
  fireEvent.press(screen.getByLabelText('다음 · 양식 확인'))
  await screen.findByText('사업계획서.hwpx')
  expect(screen.getByText('보관 요청 조회 실패')).toBeTruthy()
  expect(screen.getByLabelText('입력칸별 양식 다시 분석').props.accessibilityState.disabled).toBe(true)
  fireEvent.press(screen.getByLabelText('보관 요청 다시 확인'))
  await waitFor(() => expect(screen.getByLabelText('같은 분석 요청으로 확인').props.accessibilityState.disabled).toBe(false))
  expect(readPendingPreparation).toHaveBeenCalledTimes(2)
  expect(readPendingPreparation).toHaveBeenLastCalledWith('https://api.example.test', 'first@test.com')
  expect(screen.queryByText('보관 요청 조회 실패')).toBeNull()
  expect(api.discover).not.toHaveBeenCalled()
  expect(api.create).not.toHaveBeenCalled()
})

test('a repeated storage failure keeps analysis blocked and reports the retry failure', async () => {
  jest.mocked(readPendingPreparation).mockRejectedValue(new Error('보관 요청 조회 실패'))
  render(<ApplicationPreparationNewScreen {...newProps} />)
  await screen.findByText('보관 요청 조회 실패')
  fireEvent.press(screen.getByLabelText(`${documentProgram.title} 선택`))
  fireEvent.press(screen.getByLabelText('다음 · 양식 확인'))
  await screen.findByText('사업계획서.hwpx')
  fireEvent.press(screen.getByLabelText('보관 요청 다시 확인'))
  await waitFor(() => expect(readPendingPreparation).toHaveBeenCalledTimes(2))
  await screen.findByText('보관 요청 조회 실패')
  expect(screen.getByLabelText('입력칸별 양식 다시 분석').props.accessibilityState.disabled).toBe(true)
  expect(api.discover).not.toHaveBeenCalled()
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

test('undecided saved facts do not enable document generation', async () => {
  const undecided = { ...documentPreparation, form: { ...documentForm, sections: documentForm.sections.map(section => ({ ...section,
    facts: section.facts.map(fact => ({ ...fact, status: 'UNKNOWN', value: null })),
  })) } }
  api.get.mockResolvedValue(undecided); api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([])
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안을 만들기 전에 작성할 답변을 저장하고 필수 항목을 확인해 주세요.')
  expect(screen.queryByLabelText('초안 만들기')).toBeNull()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('undecided current answers still allow confirming the same previously stored request', async () => {
  const requestKey = '11111111-1111-4111-8111-111111111111'
  jest.mocked(readPendingPreparation).mockResolvedValue({ kind: 'document', preparationId: 9, expectedRevision: 1, requestKey })
  api.get.mockResolvedValue({ ...documentPreparation, inputRevision: 2, form: { ...documentForm, sections: documentForm.sections.map(section => ({ ...section,
    facts: section.facts.map(fact => ({ ...fact, status: 'UNKNOWN', value: null })),
  })) } })
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([]); api.submitDocumentJob.mockResolvedValue(documentJob)
  render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText('같은 생성 요청으로 확인'))
  await waitFor(() => expect(api.submitDocumentJob).toHaveBeenCalledWith(9, 1, expect.any(AbortSignal), requestKey))
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

test('changing a filter cancels deletion and immediately releases its lock', async () => {
  let finish!: () => void
  api.delete.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  render(<ApplicationDocumentsListScreen {...listProps} />)
  await screen.findByText('사업계획서')
  fireEvent.press(screen.getByText('문서 관리')); fireEvent.press(screen.getByLabelText('사업계획서 삭제'))
  await act(async () => { alert.mock.calls[0][2]!.find(button => button.style === 'destructive')!.onPress!() })
  const signal = api.delete.mock.calls[0][1] as AbortSignal
  fireEvent.press(screen.getByRole('tab', { name: '작성 중' }))
  await waitFor(() => expect(api.list).toHaveBeenCalledWith({ status: 'in_progress' }, expect.any(AbortSignal)))
  await screen.findByText('사업계획서')
  expect(signal.aborted).toBe(true)
  expect(screen.getByLabelText('사업계획서 삭제').props.accessibilityState.disabled).toBe(false)
  await act(async () => finish())
  expect(screen.getByLabelText('사업계획서 삭제').props.accessibilityState.busy).toBe(false)
})

test('missing result documents retain the recovery action and return to the list after clearing', async () => {
  const pending = { kind: 'document' as const, preparationId: 9, expectedRevision: 1, requestKey: '11111111-1111-4111-8111-111111111111' }
  jest.mocked(readPendingPreparation).mockResolvedValue(pending)
  api.get.mockRejectedValue(new ApplicationPreparationError(404, 'APPLICATION_PREPARATION_NOT_FOUND'))
  render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText('보관 요청 대상 확인'))
  await screen.findByText('대상 문서가 없어 보관 요청을 정리했어요. 목록에서 새 신청문서를 작성할 수 있어요.')
  expect(discardDeletedPendingPreparation).toHaveBeenCalledWith('owned-token', 'first@test.com', pending, expect.any(AbortSignal))
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('보관 요청 대상 확인')).toBeNull()
  fireEvent.press(screen.getByLabelText('목록으로 돌아가기'))
  expect(docProps.onList).toHaveBeenCalled()
})

test('list recovery preserves a failed check and clears only after confirmed success', async () => {
  const pending = { kind: 'document' as const, preparationId: 9, expectedRevision: 1, requestKey: '11111111-1111-4111-8111-111111111111' }
  jest.mocked(readPendingPreparation).mockResolvedValue(pending)
  jest.mocked(discardDeletedPendingPreparation).mockRejectedValueOnce(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  render(<ApplicationDocumentsListScreen {...listProps} />)
  fireEvent.press(await screen.findByLabelText('보관 요청 대상 확인'))
  await screen.findByText('서버에서 신청문서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  expect(screen.getByLabelText('미확인 요청 이어서 확인')).toBeTruthy()
  jest.mocked(readPendingPreparation).mockResolvedValue(null)
  fireEvent.press(screen.getByLabelText('보관 요청 대상 확인'))
  await screen.findByText('대상 문서가 없어 보관 요청을 정리했어요. 새 신청문서를 작성할 수 있어요.')
  await waitFor(() => expect(screen.queryByLabelText('미확인 요청 이어서 확인')).toBeNull())
  expect(api.submitDocumentJob).not.toHaveBeenCalled(); expect(api.discover).not.toHaveBeenCalled()
})

test.each(['documents', 'list', 'discovery'] as const)('%s polling waits for foreground, aborts on background and resumes with reads', async mode => {
  const previous = AppState.currentState; AppState.currentState = 'background'
  let change!: (state: AppStateStatus) => void
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { change = listener; return { remove: jest.fn() } })
  const timers = captureTimeouts()
  const cancel = jest.spyOn(globalThis, 'clearTimeout')
  const runningJob = { ...documentJob, status: 'RUNNING', fileIds: [], finishedAt: null }
  api.documentJobs.mockResolvedValue([runningJob]); api.documentJob.mockResolvedValue(runningJob)
  api.recentDocumentJobs.mockResolvedValue([runningJob])
  const discovery = { id: 5, sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123', status: 'RUNNING', result: null }
  if (mode === 'discovery') {
    api.discoveryJobs.mockResolvedValue([discovery])
    jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue(documentProgram), browseCatalog: jest.fn().mockResolvedValue({ programs: [], total: 0, totalPages: 0 }) } as unknown as ReturnType<typeof programClient>)
  }
  try {
    const view = render(mode === 'documents' ? <ApplicationDocumentScreen {...docProps} /> : mode === 'list' ? <ApplicationDocumentsListScreen {...listProps} />
      : <ApplicationPreparationNewScreen {...newProps} initialProgram={{ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123' }} />)
    await act(async () => { await Promise.resolve() })
    const read = mode === 'documents' ? api.documentJob : mode === 'list' ? api.recentDocumentJobs : api.availability
    expect(read).not.toHaveBeenCalled()
    await act(async () => change('active'))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    const delay = mode === 'list' ? 5000 : 2000
    await waitFor(() => expect(timers.calls.some(call => call[1] === delay)).toBe(true))
    const timerIndex = timers.calls.findIndex(call => call[1] === delay)
    const signal = read.mock.calls[0].at(-1) as AbortSignal
    await act(async () => change('background'))
    expect(signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledWith(timers.results[timerIndex])
    await act(async () => change('active'))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(api.submitDocumentJob).not.toHaveBeenCalled(); expect(api.discover).not.toHaveBeenCalled()
    view.unmount()
  } finally { AppState.currentState = previous; timers.restore() }
})

test('foreground refresh preserves the selected form for the same program', async () => {
  let change!: (state: AppStateStatus) => void
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { change = listener; return { remove: jest.fn() } })
  api.availability.mockResolvedValue({ state: { status: 'AVAILABLE' }, forms: { items: [documentForm, { ...documentForm, formVersionId: 'second-form', formTitle: '다른 양식', attachmentFileName: '다른양식.hwpx' }] } })
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue(documentProgram), browseCatalog: jest.fn().mockResolvedValue({ programs: [], total: 0, totalPages: 0 }) } as unknown as ReturnType<typeof programClient>)
  render(<ApplicationPreparationNewScreen {...newProps} initialProgram={{ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123' }} />)
  fireEvent.press(await screen.findByLabelText('이 양식 선택'))
  await act(async () => change('background'))
  await act(async () => change('active'))
  await waitFor(() => expect(api.availability).toHaveBeenCalledTimes(2))
  fireEvent.press(screen.getByLabelText('이 양식으로 작성 시작'))
  await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ formVersionId: 'second-form' }), expect.any(AbortSignal)))
})
