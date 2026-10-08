import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { View } from 'react-native'
import { useAuth } from '../auth/session'
import { listSavedPrograms, removeSavedProgram, saveProgram } from '../api/savedPrograms'
import { ProgramInterestButton, useSearchProgramInterests } from './SearchProgramInterests'
import { programDetail } from '../test/preparationFixtures'

jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => void) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(callback, [callback])
} }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/savedPrograms', () => ({ listSavedPrograms: jest.fn(), removeSavedProgram: jest.fn(), saveProgram: jest.fn() }))
const identity = { sourceCode: programDetail.sourceCode, sourceProgramId: programDetail.id }
const saved = { savedAt: '2026-10-07', program: { ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null } }
const login = jest.fn(), invalidateSession = jest.fn().mockResolvedValue(undefined)
function auth(token: string) { return { status: 'signedIn', session: { accessToken: token }, invalidateSession } as unknown as ReturnType<typeof useAuth> }
function Host() {
  const interests = useSearchProgramInterests()
  return <View>{[identity, { ...identity, sourceCode: 'KSTARTUP' }].map((item, index) => <ProgramInterestButton key={index}
    identity={item} title={`공고 ${index}`} interests={interests} onLogin={login} />)}</View>
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useAuth).mockReturnValue(auth('owner'))
  jest.mocked(listSavedPrograms).mockResolvedValue([])
  jest.mocked(saveProgram).mockResolvedValue(saved)
  jest.mocked(removeSavedProgram).mockResolvedValue(undefined)
})

test('saved results respect the source and ID pair and saving then removing updates the same result', async () => {
  jest.mocked(listSavedPrograms).mockResolvedValue([saved])
  render(<Host />)
  await screen.findByLabelText('공고 0 관심 공고에서 빼기')
  fireEvent.press(screen.getByLabelText('공고 1 관심 공고에 추가'))
  await screen.findByLabelText('공고 1 관심 공고에서 빼기')
  expect(saveProgram).toHaveBeenCalledWith('owner', { ...identity, sourceCode: 'KSTARTUP' }, expect.any(AbortSignal))
  fireEvent.press(screen.getByLabelText('공고 0 관심 공고에서 빼기'))
  await screen.findByLabelText('공고 0 관심 공고에 추가')
  expect(removeSavedProgram).toHaveBeenCalledWith('owner', identity, expect.any(AbortSignal))
  expect(listSavedPrograms).toHaveBeenCalledTimes(1)
})

test('rapid presses cannot duplicate a save and a failed request leaves the unsaved state explicit', async () => {
  let reject!: (cause: Error) => void
  jest.mocked(saveProgram).mockReturnValue(new Promise((_, fail) => { reject = fail }))
  render(<Host />)
  await waitFor(() => expect(screen.getByLabelText('공고 0 관심 공고에 추가').props.accessibilityState.disabled).toBe(false))
  let button = screen.getByLabelText('공고 0 관심 공고에 추가')
  while (!button.props.onPress && button.parent) button = button.parent
  act(() => { button.props.onPress(); button.props.onPress() })
  expect(saveProgram).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('offline')))
  await screen.findByText(/연결하지 못했거나/)
  expect(screen.getByLabelText('공고 0 관심 공고에 추가').props.accessibilityState.disabled).toBe(false)
})

test('guests can request login directly from a result without reading or writing interests', () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
  render(<Host />)
  fireEvent.press(screen.getByLabelText('공고 0 관심 공고에 추가'))
  expect(login).toHaveBeenCalledTimes(1)
  expect(listSavedPrograms).not.toHaveBeenCalled()
  expect(saveProgram).not.toHaveBeenCalled()
})

test('late reads and saves from another account cannot mark the current account result as saved', async () => {
  let finish!: (value: typeof saved) => void
  jest.mocked(saveProgram).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const view = render(<Host />)
  await waitFor(() => expect(screen.getByLabelText('공고 0 관심 공고에 추가').props.accessibilityState.disabled).toBe(false))
  fireEvent.press(screen.getByLabelText('공고 0 관심 공고에 추가'))
  const signal = jest.mocked(saveProgram).mock.calls[0][2]!
  jest.mocked(useAuth).mockReturnValue(auth('another-owner'))
  view.rerender(<Host />)
  await act(async () => finish(saved))
  expect(signal.aborted).toBe(true)
  expect(screen.queryByLabelText('공고 0 관심 공고에서 빼기')).toBeNull()
})
