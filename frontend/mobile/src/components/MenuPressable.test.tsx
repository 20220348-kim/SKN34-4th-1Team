import { AccessibilityInfo, Animated, Text } from 'react-native'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { MenuPressable } from './MenuPressable'

afterEach(() => jest.restoreAllMocks())

test('press and release animate without duplicating navigation or swallowing press callbacks', async () => {
  const animate = jest.spyOn(Animated, 'timing').mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() })
  const navigate = jest.fn(), pressIn = jest.fn(), pressOut = jest.fn()
  render(<MenuPressable accessibilityRole="button" accessibilityLabel="메뉴 항목" onPress={navigate} onPressIn={pressIn} onPressOut={pressOut}><Text>메뉴</Text></MenuPressable>)
  await act(async () => { await Promise.resolve() })
  const button = screen.getByLabelText('메뉴 항목')
  fireEvent(button, 'pressIn', { nativeEvent: {} })
  fireEvent(button, 'pressOut', { nativeEvent: {} })
  fireEvent.press(button)
  expect(animate).toHaveBeenCalledTimes(2)
  expect(navigate).toHaveBeenCalledTimes(1)
  expect(pressIn).toHaveBeenCalledTimes(1)
  expect(pressOut).toHaveBeenCalledTimes(1)
})

test('reduce motion retains navigation while removing movement', async () => {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true)
  const animate = jest.spyOn(Animated, 'timing')
  const navigate = jest.fn()
  render(<MenuPressable accessibilityLabel="메뉴 항목" onPress={navigate}><Text>메뉴</Text></MenuPressable>)
  await act(async () => { await Promise.resolve() })
  fireEvent(screen.getByLabelText('메뉴 항목'), 'pressIn', { nativeEvent: {} })
  fireEvent(screen.getByLabelText('메뉴 항목'), 'pressOut', { nativeEvent: {} })
  fireEvent.press(screen.getByLabelText('메뉴 항목'))
  expect(animate).not.toHaveBeenCalled()
  expect(navigate).toHaveBeenCalledTimes(1)
})

test('a live reduce-motion change takes precedence over a late initial preference read', async () => {
  let readPreference!: (enabled: boolean) => void
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockReturnValue(new Promise(resolve => { readPreference = resolve }))
  const subscribe = jest.spyOn(AccessibilityInfo, 'addEventListener')
  const animate = jest.spyOn(Animated, 'timing')
  const view = render(<MenuPressable accessibilityLabel="메뉴 항목"><Text>메뉴</Text></MenuPressable>)
  const changed = subscribe.mock.calls[0][1] as unknown as (enabled: boolean) => void
  const remove = jest.spyOn(subscribe.mock.results[0].value, 'remove')
  act(() => changed(true))
  await act(async () => readPreference(false))
  fireEvent(screen.getByLabelText('메뉴 항목'), 'pressIn', { nativeEvent: {} })
  expect(animate).not.toHaveBeenCalled()
  view.unmount()
  expect(remove).toHaveBeenCalledTimes(1)
})
