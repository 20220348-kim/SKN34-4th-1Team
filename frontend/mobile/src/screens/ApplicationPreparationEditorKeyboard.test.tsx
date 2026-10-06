import { useState } from 'react'
import { Keyboard, Platform, StyleSheet, type KeyboardEvent, type KeyboardEventName } from 'react-native'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { Stack, Tabs } from 'expo-router'
import { HeaderHeightContext } from 'expo-router/react-navigation'
import { renderRouter } from 'expo-router/testing-library'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { useAuth } from '../auth/session'
import { documentPreparation } from '../test/applicationDocumentFixtures'
import { ApplicationPreparationEditorScreen } from './ApplicationPreparationEditorScreen'

jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
const api = { get: jest.fn(), replaceInputs: jest.fn(), submitDocumentJob: jest.fn() }
let listeners: Map<KeyboardEventName, Set<(event: KeyboardEvent) => void>>
let resizeHeader: (height: number) => void
const answer = '작은 화면에서 입력한 기업명\n다음 질문으로 가도 보존할 답변'

function changed(revision: number, name: string) {
  return { ...documentPreparation, inputRevision: revision, form: { ...documentPreparation.form,
    sections: documentPreparation.form.sections.map(section => ({ ...section, facts: section.facts.map(fact => ({
      ...fact, inputRevision: revision, value: fact.fieldKey === 'name' ? name : fact.value,
    })) })) } }
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  Object.values(api).forEach(method => method.mockReset())
  api.get.mockResolvedValue(documentPreparation)
  api.replaceInputs.mockResolvedValue(changed(2, answer))
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owned', account: { email: 'owner@test.com' } },
    invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  listeners = new Map()
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
  const subscribe = Keyboard.addListener.bind(Keyboard)
  jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
    const subscription = subscribe(name, listener)
    const callbacks = listeners.get(name) ?? new Set<(event: KeyboardEvent) => void>()
    callbacks.add(listener); listeners.set(name, callbacks)
    const remove = subscription.remove.bind(subscription)
    subscription.remove = () => { callbacks.delete(listener); remove() }
    return subscription
  })
})
afterEach(() => { cleanup(); delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.restoreAllMocks() })

async function openEditor() {
  function EditorRoute() {
    const [height, setHeight] = useState(88)
    resizeHeader = setHeight
    return <HeaderHeightContext.Provider value={height}><ApplicationPreparationEditorScreen id={9}
      onLogin={jest.fn()} onReview={jest.fn()} onEditor={jest.fn()} onDocuments={jest.fn()} onReanalyze={jest.fn()} /></HeaderHeightContext.Provider>
  }
  renderRouter({
    _layout: () => <SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 34, left: 0, right: 0 }}>
      <Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack>
    </SafeAreaInsetsContext.Provider>,
    '(tabs)/_layout': () => <Tabs screenOptions={{ animation: 'none', tabBarHideOnKeyboard: true }} />,
    '(tabs)/all/_layout': () => <Stack screenOptions={{ animation: 'none' }} />,
    '(tabs)/all/editor': EditorRoute,
  }, { initialUrl: '/all/editor' })
  await screen.findByDisplayValue('테스트 기업')
  await layout(480)
}

const container = () => screen.getByTestId('application-preparation-keyboard-container')
const containerStyle = () => StyleSheet.flatten(container().props.style)
async function layout(height: number) {
  await act(async () => fireEvent(container(), 'layout', { persist: jest.fn(),
    nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } }))
}
async function keyboard(visible: boolean) {
  const name = Platform.OS === 'ios' ? visible ? 'keyboardWillShow' : 'keyboardWillHide'
    : visible ? 'keyboardDidShow' : 'keyboardDidHide'
  const coordinates = { screenX: 0, screenY: visible ? 360 : 640, width: 320, height: visible ? 280 : 0 }
  const event = { duration: 0, easing: 'keyboard', startCoordinates: coordinates, endCoordinates: coordinates, isEventFromThisApp: true } as KeyboardEvent
  expect(listeners.get(name)?.size).toBeGreaterThan(0)
  await act(async () => { listeners.get(name)?.forEach(callback => callback(event)) })
}

test.each(['ios', 'android'] as const)('%s keeps the answer and saves it before navigating in a small keyboard viewport', async (os) => {
  jest.replaceProperty(Platform, 'OS', os)
  await openEditor()
  fireEvent.changeText(screen.getByLabelText('내 답변'), answer)
  await keyboard(true)
  await waitFor(() => {
    const style = containerStyle()
    if (os === 'android') expect(style).toMatchObject({ height: 272, flex: 0 })
    else expect(style.paddingBottom).toBe(480 - 272)
  })
  expect(screen.getByDisplayValue(answer)).toBeTruthy()
  expect(screen.getByRole('button', { name: '이전' })).toBeDisabled()
  fireEvent.press(screen.getByRole('button', { name: '다음' }))
  await screen.findByDisplayValue('생산 개선')
  expect(api.replaceInputs).toHaveBeenCalledTimes(1)
  expect(api.replaceInputs).toHaveBeenCalledWith(9, 'company', expect.objectContaining({
    expectedRevision: 1, facts: expect.arrayContaining([expect.objectContaining({ fieldKey: 'name', value: answer })]),
  }), expect.any(AbortSignal))
  fireEvent.press(screen.getByRole('button', { name: '이전' }))
  await screen.findByDisplayValue(answer)
  await keyboard(false)
  if (os === 'android') expect(containerStyle().height).toBeUndefined()
  else expect(containerStyle().paddingBottom).toBe(0)
  expect(screen.getByDisplayValue(answer)).toBeTruthy()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
}, 15000)

test('Android resizing does not subtract the keyboard space a second time', async () => {
  jest.replaceProperty(Platform, 'OS', 'android')
  await openEditor()
  await keyboard(true)
  await waitFor(() => expect(containerStyle().height).toBe(272))
  await layout(272)
  expect(containerStyle().height).toBe(272)
  expect(screen.getByRole('button', { name: '다음' })).toBeEnabled()
})

test('a measured header change updates keyboard space without losing the pending answer', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios')
  await openEditor()
  fireEvent.changeText(screen.getByLabelText('내 답변'), answer)
  await keyboard(true)
  await act(async () => resizeHeader(124))
  await keyboard(true)
  await waitFor(() => expect(containerStyle().paddingBottom).toBe(480 - (360 - 124)))
  expect(screen.getByDisplayValue(answer)).toBeTruthy()
  expect(api.replaceInputs).not.toHaveBeenCalled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})

test('a failed next-step save keeps the current question and answer with the keyboard open', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios')
  api.replaceInputs.mockRejectedValue(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  await openEditor()
  fireEvent.changeText(screen.getByLabelText('내 답변'), answer)
  await keyboard(true)
  fireEvent.press(screen.getByRole('button', { name: '다음' }))
  await screen.findByRole('button', { name: '저장 다시 시도' })
  expect(screen.getByDisplayValue(answer)).toBeTruthy()
  expect(screen.getByText('질문 1 / 2')).toBeTruthy()
  expect(screen.getByRole('button', { name: '다음' })).toBeDisabled()
  expect(api.submitDocumentJob).not.toHaveBeenCalled()
})
