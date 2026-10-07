import { act, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert, Text } from 'react-native'
import { Stack, Tabs, router, useLocalSearchParams } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { useAuth } from '../auth/session'
import { documentPreparation } from '../test/applicationDocumentFixtures'
import { Button } from '../ui'
import { ApplicationPreparationEditorScreen } from './ApplicationPreparationEditorScreen'
import { ProgramReturnHeader } from '../components/ProgramReturnHeader'

jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
const api = { get: jest.fn(), replaceInputs: jest.fn() }
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
  index: () => <Button label="작성 화면 열기" onPress={() => router.push('/editor')} />,
  editor: () => <ApplicationPreparationEditorScreen id={9} onLogin={jest.fn()} onReview={() => router.push('/review')}
    onEditor={jest.fn()} onDocuments={jest.fn()} onReanalyze={jest.fn()} />,
  review: () => <Text>답변 검토 화면</Text>,
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  api.get.mockReset().mockResolvedValue(documentPreparation)
  api.replaceInputs.mockReset()
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owned', account: { email: 'owner@test.com' } },
    invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.restoreAllMocks() })

test('actual Expo Router context renders the editor and saves pending answers before going back', async () => {
  let finish!: (value: unknown) => void
  api.replaceInputs.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText('작성 화면 열기'))
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '돌아가기 전에 저장할 기업')
  await act(async () => router.back())
  await waitFor(() => expect(api.replaceInputs).toHaveBeenCalledTimes(1))
  expect(view.getPathname()).toBe('/editor')
  expect(api.replaceInputs).toHaveBeenCalledWith(9, 'company', expect.objectContaining({ expectedRevision: 1,
    facts: expect.arrayContaining([expect.objectContaining({ fieldKey: 'name', value: '돌아가기 전에 저장할 기업' })]) }), expect.any(AbortSignal))
  await act(async () => finish({ ...documentPreparation, inputRevision: 2 }))
  await waitFor(() => expect(view.getPathname()).toBe('/'))
})

test('failed saving in the actual navigator keeps the editor and its pending answer', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  api.replaceInputs.mockRejectedValue(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText('작성 화면 열기'))
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '저장 실패에도 유지할 기업')
  await act(async () => router.back())
  await waitFor(() => expect(alert).toHaveBeenCalledWith('답변을 먼저 저장해 주세요', expect.any(String)))
  expect(view.getPathname()).toBe('/editor')
  expect(screen.getByLabelText('내 답변').props.value).toBe('저장 실패에도 유지할 기업')
})


test('intermediate review waits for the current answer to save and never invokes document generation', async () => {
  let finish!: (value: unknown) => void
  api.replaceInputs.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText('작성 화면 열기'))
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '중간 검토 전에 저장할 기업')
  fireEvent.press(screen.getByLabelText('여기까지 작성하고 검토'))
  await waitFor(() => expect(api.replaceInputs).toHaveBeenCalledTimes(1))
  expect(view.getPathname()).toBe('/editor')
  expect(api.replaceInputs).toHaveBeenCalledWith(9, 'company', expect.objectContaining({ facts: expect.arrayContaining([
    expect.objectContaining({ fieldKey: 'name', value: '중간 검토 전에 저장할 기업' }),
  ]) }), expect.any(AbortSignal))
  await act(async () => finish({ ...documentPreparation, inputRevision: 2 }))
  await screen.findByText('답변 검토 화면')
  expect(view.getPathname()).toBe('/review')
})

test.each([503, 409])('failed intermediate-review save %i preserves the editor and pending answer', async status => {
  api.replaceInputs.mockRejectedValue(new ApplicationPreparationError(status, status === 409 ? 'APPLICATION_PREPARATION_REVISION_CONFLICT' : 'REQUEST_FAILED'))
  const view = renderRouter(routes, { initialUrl: '/editor' })
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '실패한 중간 저장 입력')
  fireEvent.press(screen.getByLabelText('여기까지 작성하고 검토'))
  await waitFor(() => expect(api.replaceInputs).toHaveBeenCalledTimes(1))
  expect(view.getPathname()).toBe('/editor')
  expect(screen.getByLabelText('내 답변').props.value).toBe('실패한 중간 저장 입력')
  expect(screen.queryByText('답변 검토 화면')).toBeNull()
})


const returnIdentity = { sourceCode: documentPreparation.form.sourceCode, sourceProgramId: documentPreparation.form.sourceProgramId }
function ReturningEditor() {
  const params = useLocalSearchParams()
  return <><ProgramReturnHeader params={params} /><ApplicationPreparationEditorScreen id={9} onLogin={jest.fn()}
    onReview={jest.fn()} onEditor={jest.fn()} onDocuments={jest.fn()} onReanalyze={jest.fn()} /></>
}
const returnRoutes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack>,
  '(tabs)/_layout': () => <Tabs screenOptions={{ headerShown: false }} />,
  '(tabs)/index': () => <Text>검색 화면</Text>,
  '(tabs)/all/_layout': { default: () => <Stack screenOptions={{ animation: 'none' }} />, unstable_settings: { anchor: 'index' } },
  '(tabs)/all/index': () => <Text>전체 메뉴</Text>,
  '(tabs)/all/preparation/[id]': ReturningEditor,
  program: () => <><Text>출발한 공고 상세</Text><Button label="공고에서 작성 열기" onPress={() => router.push({
    pathname: '/all/preparation/[id]', params: { ...returnIdentity, from: 'program', id: '9' },
  })} /></>,
}

test('the program return header waits for pending answers to save before removing the nested editor', async () => {
  let finish!: (value: unknown) => void
  api.replaceInputs.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = renderRouter(returnRoutes, { initialUrl: '/program?' + new URLSearchParams(returnIdentity) })
  fireEvent.press(await screen.findByLabelText('공고에서 작성 열기'))
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '공고로 돌아가기 전에 저장할 기업')
  fireEvent.press(screen.getByLabelText('공고 상세로 돌아가기'))
  await waitFor(() => expect(api.replaceInputs).toHaveBeenCalledTimes(1))
  expect(view.getPathname()).toBe('/all/preparation/9')
  expect(api.replaceInputs).toHaveBeenCalledWith(9, 'company', expect.objectContaining({ facts: expect.arrayContaining([
    expect.objectContaining({ fieldKey: 'name', value: '공고로 돌아가기 전에 저장할 기업' }),
  ]) }), expect.any(AbortSignal))
  await act(async () => finish({ ...documentPreparation, inputRevision: 2 }))
  await waitFor(() => expect(view.getPathname()).toBe('/program'))
  expect(view.getSearchParams()).toMatchObject(returnIdentity)
})

test('a failed program-header return save preserves the nested editor and its pending answer', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  api.replaceInputs.mockRejectedValue(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  const view = renderRouter(returnRoutes, { initialUrl: '/program?' + new URLSearchParams(returnIdentity) })
  fireEvent.press(await screen.findByLabelText('공고에서 작성 열기'))
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '복귀 실패에도 유지할 기업')
  fireEvent.press(screen.getByLabelText('공고 상세로 돌아가기'))
  await waitFor(() => expect(alert).toHaveBeenCalledWith('답변을 먼저 저장해 주세요', expect.any(String)))
  expect(view.getPathname()).toBe('/all/preparation/9')
  expect(screen.getByLabelText('내 답변').props.value).toBe('복귀 실패에도 유지할 기업')
})
