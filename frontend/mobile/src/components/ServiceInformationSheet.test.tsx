import { act, fireEvent, render, screen } from '@testing-library/react-native'
import Constants from 'expo-constants'
import { Linking } from 'react-native'
import { ServiceInformationSheet } from './ServiceInformationSheet'
import { serviceContact } from '../content/serviceInformation'

jest.mock('expo-constants', () => ({ __esModule: true, default: { nativeAppVersion: '1.4.2', expoConfig: { version: '0.1.0' } } }))
afterEach(() => { serviceContact.email = null; serviceContact.url = null; jest.restoreAllMocks() })

test('unapproved policy content remains visibly a draft and missing contact has no send action', () => {
  const props = { onClose: jest.fn() }
  const view = render(<ServiceInformationSheet section="privacy" {...props} />)
  expect(screen.getByText('문서 초안 · 운영 문서 확정 전')).toBeTruthy()
  view.rerender(<ServiceInformationSheet section="support" {...props} />)
  expect(screen.getByText(/실제 문의처는 아직 정해지지 않았어요/)).toBeTruthy()
  expect(screen.queryByLabelText('문의처 열기')).toBeNull()
})

test('a configured contact replaces preparing guidance and opens only on explicit action', async () => {
  serviceContact.url = 'https://example.test/support'
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  render(<ServiceInformationSheet section="support" onClose={jest.fn()} />)
  expect(screen.queryByText(/실제 문의처는 아직 정해지지 않았어요/)).toBeNull()
  expect(open).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('문의처 열기'))
  expect(open).toHaveBeenCalledWith(serviceContact.url)
})

test('a configured email opens a mail composer only after the contact button is pressed', () => {
  serviceContact.email = 'help@example.test'
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  render(<ServiceInformationSheet section="support" onClose={jest.fn()} />)
  expect(open).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('문의처 열기'))
  expect(open).toHaveBeenCalledWith('mailto:help%40example.test')
})

test('a contact opening failure is visible and retryable', async () => {
  serviceContact.url = 'https://example.test/support'
  const open = jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined)
  render(<ServiceInformationSheet section="support" onClose={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('문의처 열기'))
  await screen.findByText('문의처를 열지 못했어요. 다시 시도해 주세요.')
  fireEvent.press(screen.getByLabelText('문의처 열기'))
  expect(open).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('문의처를 열지 못했어요. 다시 시도해 주세요.')).toBeNull()
})

test('help prefers the installed native app version over the Expo config version', () => {
  render(<ServiceInformationSheet section="support" onClose={jest.fn()} />)
  expect(screen.getByText('앱 버전 · 1.4.2')).toBeTruthy()
  expect(screen.queryByText('앱 버전 · 0.1.0')).toBeNull()
})

test('missing version metadata is explicit', () => {
  jest.replaceProperty(Constants, 'nativeAppVersion', null)
  jest.replaceProperty(Constants, 'expoConfig', null)
  render(<ServiceInformationSheet section="support" onClose={jest.fn()} />)
  expect(screen.getByText('앱 버전 · 버전 정보를 확인할 수 없어요')).toBeTruthy()
})

test('a late contact failure cannot appear on a different policy sheet', async () => {
  serviceContact.url = 'https://example.test/support'
  let fail!: () => void
  jest.spyOn(Linking, 'openURL').mockReturnValue(new Promise((_resolve, reject) => { fail = () => reject(new Error('unavailable')) }))
  const props = { onClose: jest.fn() }
  const view = render(<ServiceInformationSheet section="support" {...props} />)
  fireEvent.press(screen.getByLabelText('문의처 열기'))
  view.rerender(<ServiceInformationSheet section="privacy" {...props} />)
  await act(async () => fail())
  expect(screen.getByText('문서 초안 · 운영 문서 확정 전')).toBeTruthy()
  expect(screen.queryByText('문의처를 열지 못했어요. 다시 시도해 주세요.')).toBeNull()
})
