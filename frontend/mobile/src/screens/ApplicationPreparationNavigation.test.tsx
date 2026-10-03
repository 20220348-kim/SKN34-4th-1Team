import { act, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert, Text } from 'react-native'
import { Stack, router } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { useAuth } from '../auth/session'
import { documentPreparation } from '../test/applicationDocumentFixtures'
import { Button } from '../ui'
import { ApplicationPreparationEditorScreen } from './ApplicationPreparationEditorScreen'

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
