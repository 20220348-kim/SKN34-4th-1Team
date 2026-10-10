import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert, AppState, Linking, type AppStateStatus } from 'react-native'
import { useAuth } from '../auth/session'
import { applicationPreparationUseCase, discardDeletedPendingPreparation, prepareApplicationDocumentDownload } from '../api/applicationPreparation'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { programClient } from '../api/client'
import { listReviewSavedPrograms } from '../api/combinationReviews'
import { shareApplicationFile } from '../api/applicationDocumentFiles'
import { readPendingPreparation, savePendingPreparation, clearPendingPreparation } from '../auth/preparationPending'
import { ApplicationDocumentsListScreen } from './ApplicationDocumentsListScreen'
import { ApplicationPreparationNewScreen } from './ApplicationPreparationNewScreen'
import { ApplicationDocumentScreen } from './ApplicationDocumentScreen'
import { documentFile, documentForm, documentJob, documentPreparation, documentProgram, documentSummary } from '../test/applicationDocumentFixtures'

jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }))

jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => () => void) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(callback, [callback])
} }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn(), discardDeletedPendingPreparation: jest.fn(), prepareApplicationDocumentDownload: jest.fn() }))
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
const browserUrl = (fileId = 11) => `https://api.example.test/api/v1/application-preparations/9/documents/${fileId}/download?ticket=${'a'.repeat(43)}`
const downloadNotice = (fileName: string) => `${fileName} 다운로드를 브라우저에서 열었어요. 브라우저의 다운로드 목록에서 확인해 주세요.`
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
  auth.invalidateSession.mockReset().mockResolvedValue(undefined)
  jest.mocked(useAuth).mockReturnValue(auth as unknown as ReturnType<typeof useAuth>)
  Object.values(api).forEach(fn => fn.mockReset())
  Object.values(listProps).forEach(fn => fn.mockClear()); Object.values(newProps).forEach(fn => fn.mockClear())
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
  jest.mocked(readPendingPreparation).mockReset().mockResolvedValue(null)
  jest.mocked(discardDeletedPendingPreparation).mockReset().mockResolvedValue(undefined)
  api.list.mockResolvedValue({ items: [documentSummary], nextBeforeId: null }); api.recentDocumentJobs.mockResolvedValue([]); api.discoveryJobs.mockResolvedValue([]); api.delete.mockResolvedValue(undefined)
  api.availability.mockResolvedValue({ state: { status: 'AVAILABLE' }, forms: { items: [documentForm] } }); api.markDiscoveryJobsSeen.mockResolvedValue(undefined); api.create.mockResolvedValue(documentPreparation)
  api.get.mockResolvedValue(documentPreparation); api.documents.mockResolvedValue([documentFile]); api.documentJobs.mockResolvedValue([documentJob]); api.documentJob.mockResolvedValue(documentJob); api.markDocumentJobsSeen.mockResolvedValue(undefined)
  jest.mocked(shareApplicationFile).mockReset()
  jest.mocked(prepareApplicationDocumentDownload).mockReset().mockImplementation(async (_token, _id, fileId) => browserUrl(fileId))
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  jest.mocked(listReviewSavedPrograms).mockResolvedValue([documentProgram])
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({ ...documentProgram, applicationRoute: { type: 'UNKNOWN', method: null, url: null } }), browseCatalog: jest.fn().mockResolvedValue({ programs: [documentProgram], total: 1, page: 1, pageSize: 12, totalPages: 1,
    regions: ['서울'], categories: ['기술'], startupStages: [], applicantTypes: [], founderAges: [] }) } as unknown as ReturnType<typeof programClient>)
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.restoreAllMocks() })

test.each(['GOOGLE_FORMS', 'EXTERNAL_SITE', 'UNKNOWN'] as const)('document results offer an input helper only for %s', async type => {
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({ ...documentProgram,
    applicationRoute: { type, method: null, url: type === 'GOOGLE_FORMS' ? 'https://docs.google.com/forms/d/e/example/viewform' : null } }) } as unknown as ReturnType<typeof programClient>)
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 완료')
  await waitFor(() => expect(programClient).toHaveBeenCalledWith('owned-token'))
  if (type === 'GOOGLE_FORMS') expect(await screen.findByLabelText('구글폼 입력 도우미')).toBeTruthy()
  else expect(screen.queryByLabelText('구글폼 입력 도우미')).toBeNull()
  expect(screen.queryByLabelText('목록으로 돌아가기')).toBeNull()
  fireEvent.press(screen.getByLabelText('답변 수정하기'))
  expect(docProps.onEditor).toHaveBeenCalled()
})

test('a failed application route lookup is explicit and keeps the generated documents usable', async () => {
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockRejectedValue(new Error('offline')) } as unknown as ReturnType<typeof programClient>)
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('구글폼 신청 여부를 확인하지 못했어요. 다시 확인해 주세요.')
  expect(screen.getByLabelText('초안 다운로드: 사업계획서.hwpx')).toBeTruthy()
  expect(screen.queryByLabelText('구글폼 입력 도우미')).toBeNull()
})

test('download opens the authenticated file link in the browser without a folder picker or saved claim', async () => {
  render(<ApplicationDocumentScreen {...docProps} />)
  // 이 파일의 첫 테스트라 첫 렌더가 모듈을 처음 읽는 시간까지 떠안습니다. 느린 CI에서 기본 1초를 넘겨 실패하지 않게 첫 화면만 넉넉히 기다립니다.
  await screen.findByText('초안 완료', {}, { timeout: 5000 })
  fireEvent.press(screen.getByLabelText('초안 다운로드: 사업계획서.hwpx'))
  await screen.findByText(downloadNotice(documentFile.fileName))
  expect(prepareApplicationDocumentDownload).toHaveBeenCalledWith('owned-token', 9, documentFile.id, expect.any(AbortSignal))
  expect(Linking.openURL).toHaveBeenCalledWith(browserUrl())
  expect(shareApplicationFile).not.toHaveBeenCalled()
  expect(api.downloadDocument).not.toHaveBeenCalled()
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('a failed retry clears the previous browser notice and exposes the link error', async () => {
  jest.mocked(prepareApplicationDocumentDownload).mockResolvedValueOnce(browserUrl())
    .mockRejectedValueOnce(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 완료')
  fireEvent.press(screen.getByLabelText('초안 다운로드: 사업계획서.hwpx'))
  await screen.findByText(downloadNotice(documentFile.fileName))
  fireEvent.press(screen.getByLabelText('초안 다운로드: 사업계획서.hwpx'))
  await screen.findByText(/서버에서 신청문서 요청을 처리하지 못했습니다/)
  await waitFor(() => expect(screen.getByLabelText('초안 다운로드: 사업계획서.hwpx').props.accessibilityState.disabled).toBe(false))
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
  expect(screen.queryByText(downloadNotice(documentFile.fileName))).toBeNull()
  expect(Linking.openURL).toHaveBeenCalledTimes(1)
})

test('a browser launch failure shows an error and never reports saved or opened', async () => {
  jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('OS refused'))
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 완료')
  fireEvent.press(screen.getByLabelText('초안 다운로드: 사업계획서.hwpx'))
  await screen.findByText('다운로드 브라우저를 열지 못했어요. 다시 시도해 주세요.')
  expect(screen.queryByText(downloadNotice(documentFile.fileName))).toBeNull()
  expect(screen.queryByText(/파일을 저장했어요/)).toBeNull()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test.each([
  ['pdf', 'application/pdf'], ['hwp', 'application/x-hwp'], ['hwpx', 'application/hwp+zip'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])('one draft download opens the original %s file without a duplicate or ZIP action', async (extension, mediaType) => {
  const file = { ...documentFile, fileName: `신청서-초안.${extension}`, mediaType }
  api.documents.mockResolvedValue([file])
  render(<ApplicationDocumentScreen {...docProps} />)
  const button = await screen.findByLabelText(`초안 다운로드: ${file.fileName}`)
  expect(screen.getAllByText('초안 다운로드')).toHaveLength(1)
  expect(screen.queryByLabelText('내려받기')).toBeNull()
  expect(screen.queryByLabelText('전체 내려받기')).toBeNull()
  expect(screen.queryByText('다른 앱으로 공유')).toBeNull()
  fireEvent.press(button)
  await screen.findByText(downloadNotice(file.fileName))
  expect(prepareApplicationDocumentDownload).toHaveBeenCalledWith('owned-token', 9, file.id, expect.any(AbortSignal))
  expect(Linking.openURL).toHaveBeenCalledWith(browserUrl(file.id))
  expect(shareApplicationFile).not.toHaveBeenCalled()
  expect(api.downloadDocument).not.toHaveBeenCalled()
  expect(api.downloadDocumentArchive).not.toHaveBeenCalled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('a background transition aborts the pending link and returning cannot launch its late response', async () => {
  let change!: (state: AppStateStatus) => void
  change = broadcastAppState()
  let finish!: (value: string) => void
  jest.mocked(prepareApplicationDocumentDownload).mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve }))
  render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText(`초안 다운로드: ${documentFile.fileName}`))
  await waitFor(() => expect(prepareApplicationDocumentDownload).toHaveBeenCalledTimes(1))
  const signal = jest.mocked(prepareApplicationDocumentDownload).mock.calls[0][3]!
  const previous = AppState.currentState
  try {
    AppState.currentState = 'background'
    await act(async () => change('background'))
    expect(signal.aborted).toBe(true)
    AppState.currentState = 'active'
    await act(async () => change('active'))
    await act(async () => finish(browserUrl()))
    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(screen.queryByText(downloadNotice(documentFile.fileName))).toBeNull()
    fireEvent.press(screen.getByLabelText(`초안 다운로드: ${documentFile.fileName}`))
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledTimes(1))
  } finally { AppState.currentState = previous }
})

test('account replacement invalidates a pending link while the new account can start its own download', async () => {
  let finish!: (value: string) => void
  jest.mocked(prepareApplicationDocumentDownload).mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve }))
  const view = render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText(`초안 다운로드: ${documentFile.fileName}`))
  await waitFor(() => expect(prepareApplicationDocumentDownload).toHaveBeenCalledTimes(1))
  const oldSignal = jest.mocked(prepareApplicationDocumentDownload).mock.calls[0][3]!
  jest.mocked(useAuth).mockReturnValue({ ...auth, session: { accessToken: 'new-account-token', account: { email: 'second@test.com' } } } as unknown as ReturnType<typeof useAuth>)
  view.rerender(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByLabelText(`초안 다운로드: ${documentFile.fileName}`)
  await act(async () => finish(browserUrl()))
  expect(oldSignal.aborted).toBe(true)
  expect(Linking.openURL).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText(`초안 다운로드: ${documentFile.fileName}`))
  await waitFor(() => expect(Linking.openURL).toHaveBeenCalledTimes(1))
  expect(prepareApplicationDocumentDownload).toHaveBeenLastCalledWith('new-account-token', 9, 11, expect.any(AbortSignal))
})

test('expired authentication prevents browser handoff and invalidates the app session', async () => {
  auth.invalidateSession.mockClear()
  jest.mocked(prepareApplicationDocumentDownload).mockRejectedValueOnce(new ApplicationPreparationError(401, 'AUTHENTICATION_REQUIRED'))
  render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText(`초안 다운로드: ${documentFile.fileName}`))
  await waitFor(() => expect(auth.invalidateSession).toHaveBeenCalledTimes(1))
  expect(Linking.openURL).not.toHaveBeenCalled()
  expect(shareApplicationFile).not.toHaveBeenCalled()
})

test('a single latest file downloads directly while older files stay folded', async () => {
  const latest = { ...documentFile, inputRevision: 2 }
  api.get.mockResolvedValue({ ...documentPreparation, inputRevision: 2 })
  api.documents.mockResolvedValue([{ ...documentFile, id: 80, fileName: '이전-신청서.hwpx' }, latest])
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByLabelText(`초안 다운로드: ${latest.fileName}`)
  expect(screen.getAllByText('초안 다운로드')).toHaveLength(1)
  expect(screen.queryByLabelText('전체 내려받기')).toBeNull()
  expect(screen.queryByText('이전-신청서.hwpx')).toBeNull()
  expect(screen.getByText('HWPX · 1 KB · 답변 버전 2')).toBeTruthy()
  fireEvent.press(screen.getByLabelText(`초안 다운로드: ${latest.fileName}`))
  await screen.findByText(downloadNotice(latest.fileName))
  expect(prepareApplicationDocumentDownload).toHaveBeenCalledWith('owned-token', 9, latest.id, expect.any(AbortSignal))
  expect(Linking.openURL).toHaveBeenCalledWith(browserUrl(latest.id))
  expect(api.downloadDocumentArchive).not.toHaveBeenCalled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('several drafts each have their own direct download without a combined ZIP action', async () => {
  const pdf = { ...documentFile, id: 82, fileName: '별첨.pdf', mediaType: 'application/pdf' }
  api.documents.mockResolvedValue([documentFile, pdf])
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByLabelText(`초안 다운로드: ${pdf.fileName}`)
  expect(screen.getAllByText('초안 다운로드')).toHaveLength(2)
  expect(screen.queryByLabelText('전체 내려받기')).toBeNull()
  expect(screen.getByText('PDF · 1 KB · 답변 버전 1')).toBeTruthy()
  fireEvent.press(screen.getByLabelText(`초안 다운로드: ${pdf.fileName}`))
  await screen.findByText(downloadNotice(pdf.fileName))
  expect(prepareApplicationDocumentDownload).toHaveBeenCalledWith('owned-token', 9, pdf.id, expect.any(AbortSignal))
  expect(Linking.openURL).toHaveBeenCalledWith(browserUrl(pdf.id))
  expect(api.downloadDocumentArchive).not.toHaveBeenCalled()
})

test('changed answers show the latest generated drafts and download the selected original file', async () => {
  const older = { ...documentFile, id: 70, inputRevision: 2, fileName: '이전-답변.hwpx' }
  const latest = { ...documentFile, id: 83, inputRevision: 3, fileName: '최신-신청서.hwpx' }
  api.get.mockResolvedValue({ ...documentPreparation, inputRevision: 4 })
  api.documents.mockResolvedValue([older, latest, { ...latest, id: 84, fileName: '최신-계획서.hwpx' }])
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('답변이 바뀜')
  expect(screen.getByText('답변 버전 3 문서 · 2개')).toBeTruthy()
  expect(screen.queryByText(older.fileName)).toBeNull()
  expect(screen.getByLabelText('수정 답변으로 다시 만들기')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('이전 버전 문서 1개 보기'))
  expect(screen.getByText('답변 버전 2 문서')).toBeTruthy()
  expect(screen.getByLabelText(`초안 다운로드: ${older.fileName}`)).toBeTruthy()
  fireEvent.press(screen.getByLabelText('이전 버전 문서 1개 접기'))
  expect(screen.queryByText(older.fileName)).toBeNull()
  fireEvent.press(screen.getByLabelText(`초안 다운로드: ${latest.fileName}`))
  await screen.findByText(downloadNotice(latest.fileName))
  expect(prepareApplicationDocumentDownload).toHaveBeenCalledWith('owned-token', 9, latest.id, expect.any(AbortSignal))
  expect(Linking.openURL).toHaveBeenCalledWith(browserUrl(latest.id))
  expect(api.downloadDocumentArchive).not.toHaveBeenCalled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('a result without generated files has no download action and never requests a binary on entry', async () => {
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([])
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByLabelText('초안 만들기')
  expect(screen.queryByLabelText('내려받기')).toBeNull()
  expect(screen.queryByLabelText('전체 내려받기')).toBeNull()
  expect(screen.queryByText('초안 다운로드')).toBeNull()
  expect(api.downloadDocument).not.toHaveBeenCalled()
  expect(prepareApplicationDocumentDownload).not.toHaveBeenCalled()
  expect(api.downloadDocumentArchive).not.toHaveBeenCalled()
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
  fireEvent.press(screen.getByLabelText(`초안 다운로드: ${documentFile.fileName}`))
  await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith(browserUrl()))
  expect(prepareApplicationDocumentDownload).toHaveBeenCalledWith('owned-token', 9, 11, expect.any(AbortSignal))
})
test('unknown generation offers a read-only recovery and never automatic paid retries', async () => {
  const unknown = { ...documentJob, status: 'UNKNOWN', fileIds: [], failureCode: 'APPLICATION_DOCUMENT_OUTCOME_UNKNOWN', finishedAt: documentJob.finishedAt }
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([unknown]); api.documentJob.mockResolvedValue(unknown)
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('초안 결과를 확인하고 있어요')
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('초안 만들기')).toBeNull()
  expect(screen.getByText(/새 생성을 반복하지 말고 기존 요청의 상태를 확인/)).toBeTruthy()
  api.documents.mockResolvedValue([documentFile]); api.documentJob.mockResolvedValue(documentJob)
  fireEvent.press(screen.getByLabelText('기존 생성 요청 상태 확인'))
  await screen.findByText('초안 완료')
  expect(api.documentJob).toHaveBeenNthCalledWith(2, 9, documentJob.id, expect.any(AbortSignal))
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test.each(['initial', 'refresh'] as const)('a failed %s status read retains known UNKNOWN state and cannot offer new generation', async phase => {
  const unknown = { ...documentJob, status: 'UNKNOWN', fileIds: [], failureCode: 'APPLICATION_DOCUMENT_OUTCOME_UNKNOWN' }
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([unknown])
  if (phase === 'initial') api.documentJob.mockRejectedValue(new Error('작업 상태 조회 실패'))
  else api.documentJob.mockResolvedValueOnce(unknown).mockRejectedValue(new Error('작업 상태 조회 실패'))
  render(<ApplicationDocumentScreen {...docProps} />)
  if (phase === 'refresh') fireEvent.press(await screen.findByLabelText('기존 생성 요청 상태 확인'))
  await screen.findByText('작업 상태 조회 실패')
  expect(screen.getByText('초안 결과를 확인하고 있어요')).toBeTruthy()
  expect(screen.getByLabelText('기존 생성 요청 상태 확인')).toBeTruthy()
  expect(screen.queryByLabelText('초안 만들기')).toBeNull()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('a pending generation request remains visible and disabled until its response arrives', async () => {
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([])
  let finish!: (value: typeof documentJob) => void
  api.submitDocumentJob.mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText('초안 만들기'))
  await waitFor(() => expect(api.submitDocumentJob).toHaveBeenCalledTimes(1))
  const processing = screen.getByLabelText('생성 요청 처리 중…')
  expect(processing.props.accessibilityState).toEqual({ busy: true, disabled: true })
  fireEvent.press(processing)
  expect(api.submitDocumentJob).toHaveBeenCalledTimes(1)
  api.documents.mockResolvedValue([documentFile]); api.documentJobs.mockResolvedValue([documentJob])
  await act(async () => finish(documentJob))
  await screen.findByText('초안 완료')
})

test('an unconfirmed generation preserves the saved key and reuses it only after manual confirmation', async () => {
  const requestKey = '11111111-1111-4111-8111-111111111111'
  const pending = { kind: 'document' as const, preparationId: 9, expectedRevision: 1, requestKey }
  const clearsBefore = jest.mocked(clearPendingPreparation).mock.calls.length
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([])
  api.submitDocumentJob.mockRejectedValueOnce(new ApplicationPreparationError(0, 'REQUEST_FAILED')).mockResolvedValue(documentJob)
  render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText('초안 만들기'))
  await screen.findByLabelText('같은 생성 요청으로 확인')
  expect(screen.getByText('접수 결과를 아직 확인하지 못한 요청이 있어요. 새 요청을 만들지 않고 같은 요청으로 확인해요.')).toBeTruthy()
  expect(savePendingPreparation).toHaveBeenCalledWith('https://api.example.test', 'first@test.com', pending)
  expect(jest.mocked(clearPendingPreparation).mock.calls.length).toBe(clearsBefore)
  expect(api.submitDocumentJob).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('같은 생성 요청으로 확인'))
  await waitFor(() => expect(api.submitDocumentJob).toHaveBeenCalledTimes(2))
  expect(api.submitDocumentJob.mock.calls.map(call => call.slice(0, 2).concat(call[3]))).toEqual([[9, 1, requestKey], [9, 1, requestKey]])
})

test.each(['empty', 'undecided', 'partial'] as const)('the document page allows explicit generation for %s answers', async kind => {
  const preparation = { ...documentPreparation, form: { ...documentForm, sections: documentForm.sections.map(section => ({ ...section,
    facts: kind === 'empty' ? [] : kind === 'partial' ? section.facts.slice(0, 1) : section.facts.map(fact => ({ ...fact, status: 'UNKNOWN', value: null })),
  })) } }
  api.get.mockResolvedValue(preparation); api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([])
  api.submitDocumentJob.mockResolvedValue(documentJob)
  render(<ApplicationDocumentScreen {...docProps} />)
  const generate = await screen.findByRole('button', { name: '초안 만들기' })
  if (kind === 'partial') expect(screen.getByText(/필수 답변 1개가 비어 있어요/)).toBeTruthy()
  else expect(screen.getByText(/AI를 호출하지 않아요/)).toBeTruthy()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  fireEvent.press(generate)
  await waitFor(() => expect(api.submitDocumentJob).toHaveBeenCalledWith(9, 1, expect.any(AbortSignal), '11111111-1111-4111-8111-111111111111'))
  expect(api.submitDocumentJob).toHaveBeenCalledTimes(1)
})

test('manual-only provided answers keep the explicit server failure instead of offering an original fallback', async () => {
  api.get.mockResolvedValue({ ...documentPreparation, form: { ...documentForm, sections: documentForm.sections.map(section => ({ ...section,
    fields: section.fields.map(field => ({ ...field, required: false, documentWritable: false })),
  })) } })
  const failed = { ...documentJob, status: 'FAILED', fileIds: [], failureCode: 'APPLICATION_DOCUMENT_NO_WRITABLE_INPUT' }
  api.documents.mockResolvedValue([]); api.documentJobs.mockResolvedValue([failed]); api.documentJob.mockResolvedValue(failed)
  render(<ApplicationDocumentScreen {...docProps} />)
  await screen.findByText('이 양식은 자동으로 채우기 어려워요')
  expect(screen.queryByText(/AI를 호출하지 않아요/)).toBeNull()
  expect(screen.queryByRole('button', { name: '초안 만들기' })).toBeNull()
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
  expect(screen.queryByText(/AI를 호출하지 않아요/)).toBeNull()
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

test('missing result documents retain the recovery action without a redundant list button', async () => {
  const pending = { kind: 'document' as const, preparationId: 9, expectedRevision: 1, requestKey: '11111111-1111-4111-8111-111111111111' }
  jest.mocked(readPendingPreparation).mockResolvedValue(pending)
  api.get.mockRejectedValue(new ApplicationPreparationError(404, 'APPLICATION_PREPARATION_NOT_FOUND'))
  render(<ApplicationDocumentScreen {...docProps} />)
  fireEvent.press(await screen.findByLabelText('보관 요청 대상 확인'))
  await screen.findByText('대상 문서가 없어 보관 요청을 정리했어요. 목록에서 새 신청문서를 작성할 수 있어요.')
  expect(discardDeletedPendingPreparation).toHaveBeenCalledWith('owned-token', 'first@test.com', pending, expect.any(AbortSignal))
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('보관 요청 대상 확인')).toBeNull()
  expect(screen.queryByLabelText('목록으로 돌아가기')).toBeNull()
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

/**
 * 앱 전경·배경 전환을 흉내 냅니다. 실제 AppState처럼 등록된 모든 구독에 알립니다(화면과 이용량 줄이 각자 구독합니다).
 */
function broadcastAppState(): (state: AppStateStatus) => void {
  const listeners: ((state: AppStateStatus) => void)[] = []
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    listeners.push(listener)
    return { remove: () => { listeners.splice(listeners.indexOf(listener), 1) } }
  })
  // 알리는 도중 구독을 해제해도 이번 알림은 끝까지 돌도록 사본을 씁니다.
  return state => { listeners.slice().forEach(listener => listener(state)) }
}

test.each(['documents', 'list', 'discovery'] as const)('%s polling waits for foreground, aborts on background and resumes with reads', async mode => {
  const previous = AppState.currentState; AppState.currentState = 'background'
  let change!: (state: AppStateStatus) => void
  change = broadcastAppState()
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
  change = broadcastAppState()
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


test('document list distinguishes upcoming deadlines, today, expired and missing dates with Seoul dates', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-07T00:00:00Z'))
  api.list.mockResolvedValue({ items: [
    { ...documentSummary, id: 1, formTitle: '내일 마감 문서', applicationEndDate: '2026-10-08' },
    { ...documentSummary, id: 2, formTitle: '오늘 마감 문서', applicationEndDate: '2026-10-07' },
    { ...documentSummary, id: 3, formTitle: '지난 마감 문서', applicationEndDate: '2026-10-06' },
    { ...documentSummary, id: 4, formTitle: '마감일 없는 문서', applicationEndDate: null },
  ], nextBeforeId: null })
  try {
    render(<ApplicationDocumentsListScreen {...listProps} />)
    await screen.findByText('내일 마감 문서')
    expect(screen.getByText('D-1')).toBeTruthy()
    expect(screen.getByText('오늘 마감')).toBeTruthy()
    expect(screen.getByText('접수 마감')).toBeTruthy()
    expect(screen.queryByText('D--1')).toBeNull()
    expect(screen.queryByText('D-null')).toBeNull()
  } finally { jest.useRealTimers() }
})
