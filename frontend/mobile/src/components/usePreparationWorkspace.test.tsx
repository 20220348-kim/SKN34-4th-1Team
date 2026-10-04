import { act, render, screen, waitFor } from '@testing-library/react-native'
import { AppState, Text, type AppStateStatus } from 'react-native'
import { listPreparations, listPreparationReviews } from '../api/preparation'
import { mobileReview, reviewRunFixture } from '../test/reviewFixtures'
import { usePreparationWorkspace } from './usePreparationWorkspace'

jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => () => void) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(callback, [callback])
} }))
const mockInvalidate = jest.fn()
jest.mock('../auth/session', () => ({ useAuth: () => ({ invalidateSession: mockInvalidate }) }))
jest.mock('../api/preparation', () => ({ listPreparations: jest.fn(), listPreparationReviews: jest.fn() }))
const running = [{ review: mobileReview, latestRun: reviewRunFixture('RUNNING') }]
function captureTimeouts() {
  const original = globalThis.setTimeout
  const calls: Parameters<typeof setTimeout>[] = [], results: ReturnType<typeof setTimeout>[] = []
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    calls.push(args); const timer = original(...args); results.push(timer); return timer
  }) as typeof setTimeout
  return { calls, results, restore: () => { globalThis.setTimeout = original } }
}
function Probe() {
  const workspace = usePreparationWorkspace('owned')
  return <Text>{workspace.loading ? 'loading' : workspace.reviewError ? 'failed' : `reviews:${workspace.reviews?.length}`}</Text>
}
beforeEach(() => {
  jest.mocked(listPreparations).mockReset().mockResolvedValue([])
  jest.mocked(listPreparationReviews).mockReset().mockResolvedValue(running)
})
afterEach(() => jest.restoreAllMocks())

test('workspace pauses polling and discards background responses, then reads again on foreground', async () => {
  const previous = AppState.currentState; AppState.currentState = 'background'
  let change!: (state: AppStateStatus) => void
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { change = listener; return { remove: jest.fn() } })
  const timers = captureTimeouts(), cancel = jest.spyOn(globalThis, 'clearTimeout')
  try {
    const view = render(<Probe />)
    expect(listPreparations).not.toHaveBeenCalled()
    await act(async () => change('active'))
    await screen.findByText('reviews:1')
    const timerIndex = timers.calls.findIndex(call => call[1] === 10_000)
    expect(timerIndex).toBeGreaterThanOrEqual(0)
    const signal = jest.mocked(listPreparations).mock.calls[0][1]!
    await act(async () => change('background'))
    expect(signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledWith(timers.results[timerIndex])
    let finish!: (value: typeof running) => void
    jest.mocked(listPreparationReviews).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => change('active'))
    await waitFor(() => expect(listPreparationReviews).toHaveBeenCalledTimes(2))
    await act(async () => change('inactive'))
    await act(async () => finish([]))
    expect(screen.queryByText('reviews:0')).toBeNull()
    await act(async () => change('active'))
    await screen.findByText('reviews:1')
    expect(listPreparationReviews).toHaveBeenCalledTimes(3)
    view.unmount()
  } finally { AppState.currentState = previous; timers.restore() }
})

test('next workspace poll waits for the previous response and stops after failure', async () => {
  const timers = captureTimeouts()
  try {
    const view = render(<Probe />)
    await screen.findByText('reviews:1')
    const polls = () => timers.calls.filter(call => call[1] === 10_000)
    expect(polls()).toHaveLength(1)
    let fail!: (cause: Error) => void
    jest.mocked(listPreparationReviews).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    const callback = polls()[0][0] as () => void
    await act(async () => callback())
    expect(listPreparationReviews).toHaveBeenCalledTimes(2)
    expect(polls()).toHaveLength(1)
    await act(async () => fail(new Error('offline')))
    await screen.findByText('failed')
    expect(polls()).toHaveLength(1)
    view.unmount()
  } finally { timers.restore() }
})
