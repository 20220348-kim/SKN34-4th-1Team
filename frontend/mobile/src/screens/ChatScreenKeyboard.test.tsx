import { useState } from 'react'
import { Keyboard, Platform, StyleSheet, type KeyboardEvent, type KeyboardEventName } from 'react-native'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Stack, Tabs } from 'expo-router'
import { HeaderHeightContext } from 'expo-router/react-navigation'
import { renderRouter } from 'expo-router/testing-library'
import SearchRoute from '../../app/(tabs)/index'
import { ChatScreen } from './ChatScreen'
import { SearchScreen, type SearchMode } from './SearchScreen'
import { useAuth } from '../auth/session'
import { LoginFlowProvider } from '../auth/loginFlow'
import { programClient } from '../api/client'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))

type KeyboardListener = (event: KeyboardEvent) => void
let listeners: Map<KeyboardEventName, Set<KeyboardListener>>
const client = { interpretConversation: jest.fn(), search: jest.fn(), browseCatalog: jest.fn() }
const emptyPage = { programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [],
  startupStages: [], applicantTypes: [], founderAges: [] }

beforeEach(() => {
  listeners = new Map()
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
  const subscribe = Keyboard.addListener.bind(Keyboard)
  jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
    const subscription = subscribe(name, listener)
    const callbacks = listeners.get(name) ?? new Set<KeyboardListener>()
    callbacks.add(listener); listeners.set(name, callbacks)
    const remove = subscription.remove.bind(subscription)
    subscription.remove = () => { callbacks.delete(listener); remove() }
    return subscription
  })
  Object.values(client).forEach(method => method.mockReset())
  client.browseCatalog.mockResolvedValue(emptyPage)
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
})
afterEach(() => { cleanup(); jest.restoreAllMocks() })

const container = () => screen.getByTestId('ai-search-keyboard-container')
const containerStyle = () => StyleSheet.flatten(container().props.style)
async function layout(testID: string, height: number) {
  await act(async () => {
    fireEvent(screen.getByTestId(testID), 'layout', { persist: jest.fn(),
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height } } })
  })
}
async function keyboard(visible: boolean, screenY = 480) {
  const name = Platform.OS === 'ios' ? visible ? 'keyboardWillShow' : 'keyboardWillHide'
    : visible ? 'keyboardDidShow' : 'keyboardDidHide'
  const coordinates = { screenX: 0, screenY, width: 360, height: visible ? 832 - screenY : 0 }
  const event = { duration: 0, easing: 'keyboard', startCoordinates: coordinates, endCoordinates: coordinates, isEventFromThisApp: true } as KeyboardEvent
  expect(listeners.get(name)?.size).toBeGreaterThan(0)
  await act(async () => { listeners.get(name)?.forEach(callback => callback(event)) })
}
function expectVisibleSpace(os: 'ios' | 'android', availableHeight: number) {
  const style = containerStyle()
  if (os === 'android') expect(style).toMatchObject({ height: availableHeight, flex: 0 })
  else expect(style.paddingBottom).toBe(600 - availableHeight)
}

test.each(['ios', 'android'] as const)('%s reserves visible space for a multiline draft when the keyboard opens and restores it on close', async (os) => {
  jest.replaceProperty(Platform, 'OS', os)
  render(<ChatScreen keyboardOffset={152} onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await layout('ai-search-keyboard-container', 600)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '서울에서 사업을 운영하고 있어요.\n작성 중인 질문을 이어갈게요.')
  await keyboard(true)
  await waitFor(() => expectVisibleSpace(os, 328))
  expect(screen.getByDisplayValue('서울에서 사업을 운영하고 있어요.\n작성 중인 질문을 이어갈게요.')).toBeTruthy()
  expect(screen.getByLabelText('AI에게 보내기')).toBeEnabled()
  expect(client.interpretConversation).not.toHaveBeenCalled()
  expect(client.search).not.toHaveBeenCalled()
  await keyboard(false, 832)
  if (os === 'android') expect(containerStyle().height).toBeUndefined()
  else expect(containerStyle().paddingBottom).toBe(0)
  expect(screen.getByDisplayValue('서울에서 사업을 운영하고 있어요.\n작성 중인 질문을 이어갈게요.')).toBeTruthy()
})

test('Android window resizing does not apply the keyboard height a second time', async () => {
  jest.replaceProperty(Platform, 'OS', 'android')
  render(<ChatScreen keyboardOffset={152} onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await layout('ai-search-keyboard-container', 600)
  await keyboard(true)
  await waitFor(() => expectVisibleSpace('android', 328))
  await layout('ai-search-keyboard-container', 328)
  expectVisibleSpace('android', 328)
})

test.each(['ios', 'android'] as const)('%s ignores a keyboard that does not overlap the AI panel', async (os) => {
  jest.replaceProperty(Platform, 'OS', os)
  render(<ChatScreen keyboardOffset={152} onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await layout('ai-search-keyboard-container', 600)
  await keyboard(true, 800)
  if (os === 'android') expect(containerStyle().height).toBeUndefined()
  else expect(containerStyle().paddingBottom).toBe(0)
})

test.each(['ios', 'android'] as const)('%s disables keyboard avoidance in the hidden AI panel and keeps its draft on return', async (os) => {
  jest.replaceProperty(Platform, 'OS', os)
  function SearchHost() {
    const [mode, setMode] = useState<SearchMode>('ai')
    return <SearchScreen mode={mode} headerHeight={88} onModeChange={setMode} onOpenProgram={jest.fn()} onLogin={jest.fn()} />
  }
  render(<SearchHost />)
  await layout('search-mode-header', 64)
  await layout('ai-search-keyboard-container', 600)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '모드 전환 뒤 이어 쓸 질문')
  fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
  await screen.findByText('검색 결과 0건')
  await keyboard(true)
  const hiddenStyle = StyleSheet.flatten(screen.getByTestId('ai-search-keyboard-container', { includeHiddenElements: true }).props.style)
  if (os === 'android') expect(hiddenStyle.height).toBeUndefined()
  else expect(hiddenStyle.paddingBottom).toBe(0)
  fireEvent.press(screen.getByRole('tab', { name: 'AI 대화 검색' }))
  await layout('ai-search-keyboard-container', 600)
  await waitFor(() => expectVisibleSpace(os, 328))
  expect(screen.getByDisplayValue('모드 전환 뒤 이어 쓸 질문')).toBeTruthy()
  expect(client.interpretConversation).not.toHaveBeenCalled()
  expect(client.search).not.toHaveBeenCalled()
})

test('the actual search route uses measured navigation and search headers and updates the offset without resetting the draft', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios')
  let resizeHeader!: (height: number) => void
  function MeasuredSearchRoute() {
    const [height, setHeight] = useState(88)
    resizeHeader = setHeight
    return <HeaderHeightContext.Provider value={height}><SearchRoute /></HeaderHeightContext.Provider>
  }
  renderRouter({
    _layout: () => <LoginFlowProvider><Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack></LoginFlowProvider>,
    '(tabs)/_layout': () => <Tabs screenOptions={{ animation: 'none' }}><Tabs.Screen name="index" /></Tabs>,
    '(tabs)/index': MeasuredSearchRoute,
  }, { initialUrl: '/' })
  await layout('search-mode-header', 64)
  await layout('ai-search-keyboard-container', 600)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '헤더 크기가 바뀌어도 유지할 질문')
  await keyboard(true)
  await waitFor(() => expectVisibleSpace('ios', 328))
  await act(async () => resizeHeader(124))
  await layout('search-mode-header', 72)
  await keyboard(true)
  await waitFor(() => expectVisibleSpace('ios', 284))
  expect(screen.getByDisplayValue('헤더 크기가 바뀌어도 유지할 질문')).toBeTruthy()
  expect(client.interpretConversation).not.toHaveBeenCalled()
  expect(client.search).not.toHaveBeenCalled()
})
