import { fireEvent, render, screen } from '@testing-library/react-native'
import { useDailyReportPush } from './DailyReportPushProvider'
import { DailyReportPushSettings } from './DailyReportPushSettings'

jest.mock('./DailyReportPushProvider', () => ({ useDailyReportPush: jest.fn() }))
const toggle = jest.fn(), openSystemSettings = jest.fn()
beforeEach(() => {
  toggle.mockReset().mockResolvedValue(undefined); openSystemSettings.mockReset().mockResolvedValue(undefined)
  jest.mocked(useDailyReportPush).mockReturnValue({ settings: { enabled: false, available: true, schedulerEnabled: true, sendHour: 8 },
    busy: false, error: null, permissionDenied: false, refresh: jest.fn(), toggle, openSystemSettings })
})

test('denied permission blocks enabling and opens settings only after the user selects it', () => {
  jest.mocked(useDailyReportPush).mockReturnValue({ ...jest.mocked(useDailyReportPush)(), permissionDenied: true })
  render(<DailyReportPushSettings hasCompany />)
  expect(screen.getByLabelText('이 기기 앱 알림 켜기').props.disabled).toBe(true)
  expect(openSystemSettings).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('기기 설정 열기'))
  expect(openSystemSettings).toHaveBeenCalledTimes(1)
  expect(toggle).not.toHaveBeenCalled()
})

test('an enabled server subscription can still be switched off after permission is denied', () => {
  const state = jest.mocked(useDailyReportPush)()
  jest.mocked(useDailyReportPush).mockReturnValue({ ...state, settings: { ...state.settings!, enabled: true }, permissionDenied: true })
  render(<DailyReportPushSettings hasCompany />)
  const control = screen.getByLabelText('이 기기 앱 알림 끄기')
  expect(control.props.disabled).toBe(false)
  fireEvent(control, 'valueChange', false)
  expect(toggle).toHaveBeenCalledTimes(1)
})

test('a pending save locks the switch and keeps its server-confirmed value', () => {
  jest.mocked(useDailyReportPush).mockReturnValue({ ...jest.mocked(useDailyReportPush)(), busy: true })
  render(<DailyReportPushSettings hasCompany />)
  const control = screen.getByLabelText('이 기기 앱 알림 켜기')
  expect(control.props.disabled).toBe(true)
  expect(control.props.value).toBe(false)
  fireEvent(control, 'valueChange', true)
  expect(toggle).not.toHaveBeenCalled()
})
