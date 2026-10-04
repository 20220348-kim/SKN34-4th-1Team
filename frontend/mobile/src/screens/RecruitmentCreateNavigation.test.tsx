import { act, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert, Text } from 'react-native'
import { Stack, router } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import type { PartnerRecruitment } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { useAuth } from '../auth/session'
import { createRecruitment } from '../api/partners'
import { listSavedPrograms } from '../api/savedPrograms'
import { documentProgram } from '../test/applicationDocumentFixtures'
import { Button } from '../ui'
import { RecruitmentCreateScreen } from './RecruitmentCreateScreen'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), createRecruitment: jest.fn() }))
jest.mock('../api/savedPrograms', () => ({ listSavedPrograms: jest.fn() }))
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
  index: () => <Button label="모집글 작성 열기" onPress={() => router.push('/new')} />,
  new: () => <RecruitmentCreateScreen onLogin={jest.fn()} onCompany={jest.fn()} onSavedPrograms={() => router.push('/saved')}
    onCreated={() => router.replace('/result')} onCancel={() => router.back()} />,
  result: () => <Text>등록한 모집글 상세</Text>,
  saved: () => <Text>관심 공고함</Text>,
}
beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: { email: 'owner@test.com',
    company: { companyName: '등록 기업', businessStatusCode: '01' } } }, invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(listSavedPrograms).mockReset().mockResolvedValue([{ program: documentProgram, savedAt: '2026-10-04T09:00:00+09:00' }])
  jest.mocked(createRecruitment).mockReset()
})
afterEach(() => jest.restoreAllMocks())

test('actual router cancellation confirms once and keeps the draft when the user continues editing', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText('모집글 작성 열기'))
  await screen.findByLabelText('모집글 제목 *')
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '보존할 모집글 제목')
  fireEvent.press(screen.getByLabelText('취소'))
  expect(view.getPathname()).toBe('/new')
  expect(screen.getByLabelText('모집글 제목 *').props.value).toBe('보존할 모집글 제목')
  fireEvent.press(screen.getByLabelText('취소'))
  await act(async () => alert.mock.calls[1][2]?.find(button => button.text === '나가기')?.onPress?.())
  await waitFor(() => expect(view.getPathname()).toBe('/'))
  expect(alert).toHaveBeenCalledTimes(2)
})

test('a navigator back action keeps a dirty draft until discard is confirmed', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText('모집글 작성 열기'))
  await screen.findByLabelText('협업 소개 *')
  fireEvent.changeText(screen.getByLabelText('협업 소개 *'), '뒤로 가기에도 유지할 소개')
  await act(async () => router.back())
  await waitFor(() => expect(alert).toHaveBeenCalledWith('작성 중인 모집글을 나갈까요?', expect.any(String), expect.any(Array)))
  expect(view.getPathname()).toBe('/new')
  expect(screen.getByLabelText('협업 소개 *').props.value).toBe('뒤로 가기에도 유지할 소개')
  await act(async () => alert.mock.calls[0][2]?.find(button => button.text === '나가기')?.onPress?.())
  await waitFor(() => expect(view.getPathname()).toBe('/'))
  expect(alert).toHaveBeenCalledTimes(1)
})

test('a pending registration blocks back navigation and success replaces the form without a discard warning', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  let finish!: (result: Awaited<ReturnType<typeof createRecruitment>>) => void
  jest.mocked(createRecruitment).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText('모집글 작성 열기'))
  fireEvent.press(await screen.findByLabelText('관심 공고함에서 선택'))
  fireEvent.press(await screen.findByLabelText(`공고 선택: 기업마당 ${documentProgram.title}`))
  fireEvent.press(screen.getByLabelText('모집 마감일 선택'))
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
  fireEvent.press(screen.getByLabelText(`마감일 ${today}`))
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '등록할 모집글')
  fireEvent.changeText(screen.getByLabelText('협업 소개 *'), '함께할 기업을 모집합니다.')
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  await waitFor(() => expect(createRecruitment).toHaveBeenCalledTimes(1))
  await act(async () => router.back())
  expect(view.getPathname()).toBe('/new')
  expect(alert).toHaveBeenCalledWith('모집글 등록을 확인 중이에요', expect.any(String))
  alert.mockClear()
  await act(async () => finish({ outcome: 'created', recruitment: { id: 19 } as PartnerRecruitment }))
  await waitFor(() => expect(view.getPathname()).toBe('/result'))
  expect(screen.getByText('등록한 모집글 상세')).toBeTruthy()
  expect(alert).not.toHaveBeenCalled()
})
