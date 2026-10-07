import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import { Platform, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native'
import { Stack, Tabs, router } from 'expo-router'
import { renderRouter } from 'expo-router/testing-library'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { Page } from './ui'

const insets = { top: 24, bottom: 34, left: 0, right: 0 }
function pageScroll(label: string) {
  let node: ReturnType<typeof screen.getByText> | null = screen.getByText(label)
  while (node && node.type !== ScrollView) node = node.parent
  if (!node) throw new Error(`No scroll area for ${label}`)
  return node
}
const scrollEvent = (y: number, contentHeight = 480) => ({ nativeEvent: {
  contentOffset: { x: 0, y }, contentSize: { width: 320, height: contentHeight },
  layoutMeasurement: { width: 320, height: 480 }, contentInset: { top: 0, bottom: 0, left: 0, right: 0 },
} })
afterEach(() => { cleanup(); jest.restoreAllMocks() })

test('a real tab stack owns the bottom safe area, while root pages and fixed footers keep one owner', async () => {
  renderRouter({
    _layout: () => <SafeAreaInsetsContext.Provider value={insets}><Stack screenOptions={{ animation: 'none' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack></SafeAreaInsetsContext.Provider>,
    '(tabs)/_layout': () => <Tabs screenOptions={{ animation: 'none' }} />,
    '(tabs)/all/_layout': () => <Stack screenOptions={{ animation: 'none' }} />,
    '(tabs)/all/index': () => <Page><Text>탭 본문 마지막 내용</Text></Page>,
    root: () => <Page><Text>독립 화면 마지막 내용</Text></Page>,
    detail: () => <><Page bottomSafeArea={false}><Text>상세 본문 마지막 내용</Text></Page>
      <Text style={{ paddingBottom: insets.bottom }}>안전영역을 가진 고정 버튼</Text></>,
  }, { initialUrl: '/all' })
  await screen.findByText('탭 본문 마지막 내용')
  expect(StyleSheet.flatten(pageScroll('탭 본문 마지막 내용').props.contentContainerStyle).paddingBottom).toBe(0)
  await act(async () => router.push('/root'))
  await screen.findByText('독립 화면 마지막 내용')
  expect(StyleSheet.flatten(pageScroll('독립 화면 마지막 내용').props.contentContainerStyle).paddingBottom).toBe(insets.bottom)
  await act(async () => router.push('/detail'))
  await screen.findByText('상세 본문 마지막 내용')
  expect(StyleSheet.flatten(pageScroll('상세 본문 마지막 내용').props.contentContainerStyle).paddingBottom).toBe(0)
  expect(screen.getByText('안전영역을 가진 고정 버튼')).toHaveStyle({ paddingBottom: insets.bottom })
}, 15_000)

test.each(['ios', 'android'] as const)('%s keeps top refresh available and prevents continuing a bottom overscroll on short content', os => {
  jest.replaceProperty(Platform, 'OS', os)
  const refresh = jest.fn()
  render(<Page refreshing={false} onRefresh={refresh}><Text>짧은 결과</Text></Page>)
  const scroll = pageScroll('짧은 결과')
  fireEvent(scroll, 'scrollBeginDrag', scrollEvent(0))
  fireEvent.scroll(scroll, scrollEvent(-40))
  expect(scroll.props.bounces).toBe(os === 'ios')
  act(() => (scroll.props.refreshControl.props as ComponentProps<typeof RefreshControl>).onRefresh!())
  expect(refresh).toHaveBeenCalledTimes(1)
  fireEvent.scroll(scroll, scrollEvent(1))
  expect(scroll.props.bounces).toBe(false)
  fireEvent.scroll(scroll, scrollEvent(0))
  expect(scroll.props.bounces).toBe(false)
  fireEvent(scroll, 'scrollBeginDrag', scrollEvent(0))
  expect(scroll.props.bounces).toBe(os === 'ios')
  expect(scroll.props.overScrollMode).toBe('never')
})

test('scrolling through a long result locks its lower edge and returning to the top allows a new refresh gesture', () => {
  jest.replaceProperty(Platform, 'OS', 'ios')
  render(<Page refreshing={false} onRefresh={jest.fn()}><Text>긴 결과</Text></Page>)
  const scroll = pageScroll('긴 결과')
  fireEvent(scroll, 'scrollBeginDrag', scrollEvent(0, 1080))
  fireEvent.scroll(scroll, scrollEvent(120, 1080))
  expect(scroll.props.bounces).toBe(false)
  fireEvent(scroll, 'scrollBeginDrag', scrollEvent(300, 1080))
  expect(scroll.props.bounces).toBe(false)
  fireEvent.scroll(scroll, scrollEvent(0, 1080))
  fireEvent(scroll, 'scrollBeginDrag', scrollEvent(0, 1080))
  expect(scroll.props.bounces).toBe(true)
})
