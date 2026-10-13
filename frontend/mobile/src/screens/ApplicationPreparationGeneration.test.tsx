import { fireEvent, waitFor } from '@testing-library/react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { readPendingPreparation } from '../auth/preparationPending'
import { useAuth } from '../auth/session'
import { documentJob, documentPreparation } from '../test/applicationDocumentFixtures'
import { ApplicationPreparationEditorScreen } from './ApplicationPreparationEditorScreen'

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }))
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0 }))
jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../components/PlanUsage', () => ({ FeatureUsageLine: () => null }))

const base = 'https://api.example.test'
const email = 'owner@test.com'
const firstKey = '11111111-1111-4111-8111-111111111111'
const nextKey = '22222222-2222-4222-8222-222222222222'
const stored = new Map<string, string>()
const api = { get: jest.fn(), documents: jest.fn(), documentJobs: jest.fn(), submitDocumentJob: jest.fn() }
const onDocuments = jest.fn()
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
  'review/[id]': () => {
    const { id } = useLocalSearchParams<{ id: string }>()
    return <ApplicationPreparationEditorScreen id={Number(id)} reviewing onLogin={jest.fn()} onReview={jest.fn()}
      onEditor={jest.fn()} onDocuments={onDocuments} onReanalyze={jest.fn()} />
  },
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = base
  stored.clear()
  jest.mocked(Crypto.randomUUID).mockReset().mockReturnValueOnce(firstKey).mockReturnValue(nextKey)
  jest.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async key => stored.get(key) ?? null)
  jest.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (key, value) => { stored.set(key, value) })
  jest.mocked(SecureStore.deleteItemAsync).mockReset().mockImplementation(async key => { stored.delete(key) })
  Object.values(api).forEach(method => method.mockReset())
  api.get.mockImplementation(async (id: number) => ({ ...documentPreparation, id }))
  api.documents.mockResolvedValue([])
  api.documentJobs.mockResolvedValue([])
  api.submitDocumentJob.mockImplementation(async (id: number, revision: number) => ({ ...documentJob, preparationId: id, expectedRevision: revision }))
  onDocuments.mockReset()
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owned', account: { email } },
    invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL })

test('a confirmed disabled-generation rejection releases the stored key and another draft can generate after reopening', async () => {
  const failure = new ApplicationPreparationError(503, 'APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE')
  api.submitDocumentJob.mockRejectedValueOnce(failure)
  const first = renderRouter(routes, { initialUrl: '/review/9' })
  fireEvent.press(await screen.findByLabelText('공식 양식으로 초안 만들기'))
  await screen.findByText(failure.message)
  await waitFor(() => expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1))
  expect(await readPendingPreparation(base, email)).toBeNull()
  expect(screen.queryByLabelText('같은 생성 요청으로 확인')).toBeNull()
  expect(api.submitDocumentJob).toHaveBeenCalledWith(9, 1, expect.any(AbortSignal), firstKey)
  first.unmount()

  renderRouter(routes, { initialUrl: '/review/12' })
  fireEvent.press(await screen.findByLabelText('공식 양식으로 초안 만들기'))
  await waitFor(() => expect(onDocuments).toHaveBeenCalledWith(documentJob.id))
  expect(api.submitDocumentJob).toHaveBeenCalledTimes(2)
  expect(api.submitDocumentJob).toHaveBeenLastCalledWith(12, 1, expect.any(AbortSignal), nextKey)
  expect(await readPendingPreparation(base, email)).toBeNull()
})

test.each([
  ['generic 503', () => new ApplicationPreparationError(503, 'REQUEST_FAILED')],
  ['timeout', () => new ApplicationPreparationError(408, 'REQUEST_FAILED')],
  ['lost connection', () => new Error('연결이 끊겼어요')],
] as const)('%s preserves the original key across reopening and blocks another draft until confirmed', async (_name, error) => {
  const failure = error()
  api.submitDocumentJob.mockRejectedValueOnce(failure)
  const first = renderRouter(routes, { initialUrl: '/review/9' })
  fireEvent.press(await screen.findByLabelText('공식 양식으로 초안 만들기'))
  await screen.findByText(failure.message)
  const pending = { kind: 'document', preparationId: 9, expectedRevision: 1, requestKey: firstKey }
  expect(await readPendingPreparation(base, email)).toEqual(pending)
  expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled()
  first.unmount()

  const other = renderRouter(routes, { initialUrl: '/review/12' })
  fireEvent.press(await screen.findByLabelText('공식 양식으로 초안 만들기'))
  await screen.findByText('다른 입력 버전의 미확인 요청이 있어요. 생성 결과 화면에서 기존 요청부터 확인해 주세요.')
  expect(api.submitDocumentJob).toHaveBeenCalledTimes(1)
  expect(await readPendingPreparation(base, email)).toEqual(pending)
  other.unmount()

  renderRouter(routes, { initialUrl: '/review/9' })
  fireEvent.press(await screen.findByLabelText('공식 양식으로 초안 만들기'))
  await waitFor(() => expect(onDocuments).toHaveBeenCalledWith(documentJob.id))
  expect(api.submitDocumentJob).toHaveBeenLastCalledWith(9, 1, expect.any(AbortSignal), firstKey)
  expect(Crypto.randomUUID).toHaveBeenCalledTimes(1)
  expect(await readPendingPreparation(base, email)).toBeNull()
})
