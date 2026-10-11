import { act, renderHook } from '@testing-library/react-native'
import { AppState, type AppStateStatus } from 'react-native'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { planUsageUseCase } from '../api/planUsage'
import { usePlanUsage } from './PlanUsage'

jest.mock('../api/planUsage', () => ({ planUsageUseCase: jest.fn() }))
const read = jest.fn<Promise<PlanUsage>, [AbortSignal?]>()
const now = Date.parse('2026-10-11T12:00:00+09:00')
const free: PlanUsage = { plan: 'FREE', items: [] }
const at = (delay: number) => new Date(now + delay).toISOString()
const trial: PlanUsage = { plan: 'PLUS', planSource: 'TRIAL', planEndsAt: at(1_000), items: [
  { feature: 'AI_SEARCH', period: 'PLAN', used: 2, limit: 500, resetsAt: at(1_000) },
] }
let changeState: (state: AppStateStatus) => void
const previousState = AppState.currentState

beforeEach(() => {
  jest.useFakeTimers({ now })
  AppState.currentState = 'active'
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    changeState = listener
    return { remove: jest.fn() }
  })
  read.mockReset().mockResolvedValue(free)
  jest.mocked(planUsageUseCase).mockImplementation(() => ({ usage: read }) as unknown as ReturnType<typeof planUsageUseCase>)
})
afterEach(() => { AppState.currentState = previousState; jest.useRealTimers(); jest.restoreAllMocks() })
const settle = () => act(async () => { await Promise.resolve() })

test('guest usage is read without credentials and its first response is not confused with missing state', async () => {
  const guest = { plan: null, items: [{ ...trial.items[0]!, period: 'DAY' as const, limit: 2 }] }
  read.mockResolvedValueOnce(guest)
  const view = renderHook(() => usePlanUsage(undefined, true))
  await settle()
  expect(view.result.current).toMatchObject({ usage: guest, loading: false, failed: false })
  expect(planUsageUseCase).toHaveBeenCalledWith(undefined)
})

test('loading, a refused read and a manual retry are distinct from a free plan', async () => {
  read.mockRejectedValueOnce(new Error('offline'))
  const view = renderHook(() => usePlanUsage('owner', true))
  expect(view.result.current).toMatchObject({ usage: null, loading: true, failed: false })
  await settle()
  expect(view.result.current).toMatchObject({ usage: null, loading: false, failed: true })
  act(() => view.result.current.reload())
  await settle()
  expect(view.result.current).toMatchObject({ usage: free, loading: false, failed: false })
  expect(read).toHaveBeenCalledTimes(2)
})

test('a recheck exposes its loading state with the previous value and discards it on failure', async () => {
  read.mockResolvedValueOnce(trial)
  const view = renderHook(() => usePlanUsage('owner', true))
  await settle()
  let reject!: (cause: Error) => void
  read.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
  act(() => view.result.current.reload())
  expect(view.result.current).toMatchObject({ usage: trial, loading: true, failed: false })
  await act(async () => reject(new Error('offline')))
  expect(view.result.current).toMatchObject({ usage: null, loading: false, failed: true })
  await act(async () => { jest.advanceTimersByTime(60_000) })
  expect(read).toHaveBeenCalledTimes(2)
})

test('trial expiry triggers one server read and uses the returned free plan', async () => {
  read.mockResolvedValueOnce(trial)
  const view = renderHook(() => usePlanUsage('owner', true))
  await settle()
  await act(async () => { jest.advanceTimersByTime(999) })
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => { jest.advanceTimersByTime(1) })
  expect(view.result.current.usage).toEqual(free)
  expect(read).toHaveBeenCalledTimes(2)
})

test('the earliest feature period is rechecked without changing the stored pass end', async () => {
  const pass = { ...trial, planSource: 'OPERATOR' as const, planEndsAt: at(3_000), items: [
    { ...trial.items[0]!, resetsAt: at(1_000) },
  ] }
  const nextPeriod = { ...pass, items: [{ ...pass.items[0]!, used: 0, resetsAt: at(3_000) }] }
  read.mockResolvedValueOnce(pass).mockResolvedValueOnce(nextPeriod)
  const view = renderHook(() => usePlanUsage('owner', true))
  await settle()
  await act(async () => { jest.advanceTimersByTime(1_000) })
  expect(view.result.current.usage).toEqual(nextPeriod)
  expect(view.result.current.usage?.planEndsAt).toBe(pass.planEndsAt)
  await act(async () => { jest.advanceTimersByTime(2_000) })
  expect(view.result.current.usage).toEqual(free)
  expect(read).toHaveBeenCalledTimes(3)
})

test.each(['DAY', 'MONTH'] as const)('a free %s counter is refreshed at its reset time', async period => {
  const usage = { ...free, items: [{ ...trial.items[0]!, period, resetsAt: at(1_000) }] }
  read.mockResolvedValueOnce(usage).mockResolvedValueOnce({ ...usage, items: [{ ...usage.items[0]!, used: 0, resetsAt: at(2_000) }] })
  const view = renderHook(() => usePlanUsage('owner', true))
  await settle()
  await act(async () => { jest.advanceTimersByTime(1_000) })
  expect(view.result.current.usage?.items[0]?.used).toBe(0)
  expect(read).toHaveBeenCalledTimes(2)
})

test('a thirty-day timer waits in safe chunks without querying before the actual end', async () => {
  const duration = 30 * 86_400_000
  read.mockResolvedValueOnce({ ...trial, planEndsAt: at(duration), items: [] })
  renderHook(() => usePlanUsage('owner', true))
  await settle()
  await act(async () => { jest.advanceTimersByTime(2_147_483_647) })
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => { jest.advanceTimersByTime(duration - 2_147_483_647) })
  expect(read).toHaveBeenCalledTimes(2)
})

test('a repeated expired timestamp does not create a request loop or locally replace the server plan', async () => {
  read.mockResolvedValue(trial)
  const view = renderHook(() => usePlanUsage('owner', true))
  await settle()
  await act(async () => { jest.advanceTimersByTime(1_000) })
  expect(read).toHaveBeenCalledTimes(2)
  expect(view.result.current.usage).toEqual(trial)
  await act(async () => { jest.advanceTimersByTime(60_000) })
  expect(read).toHaveBeenCalledTimes(2)
})

test('expired dates in a fresh response do not cause retries based only on the device clock', async () => {
  read.mockResolvedValue({ ...trial, planEndsAt: at(-1_000), items: [] })
  renderHook(() => usePlanUsage('owner', true))
  await settle()
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => { jest.advanceTimersByTime(60_000) })
  expect(read).toHaveBeenCalledTimes(1)
})

test('background cancels a pending request and deadline, and foreground reads again', async () => {
  read.mockResolvedValueOnce(trial)
  const view = renderHook(() => usePlanUsage('owner', true))
  await settle()
  const signal = read.mock.calls[0][0]!
  await act(async () => changeState('background'))
  expect(signal.aborted).toBe(true)
  await act(async () => { jest.advanceTimersByTime(2_000) })
  expect(read).toHaveBeenCalledTimes(1)
  let finish!: (usage: PlanUsage) => void
  read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await act(async () => changeState('active'))
  const pending = read.mock.calls[1][0]!
  await act(async () => changeState('inactive'))
  await act(async () => finish({ plan: 'PREMIUM', items: [] }))
  expect(pending.aborted).toBe(true)
  expect(view.result.current.usage).toEqual(trial)
  await act(async () => changeState('active'))
  expect(view.result.current.usage).toEqual(free)
  expect(read).toHaveBeenCalledTimes(3)
})

test('an inactive screen pauses requests and deadlines until it is opened again', async () => {
  const view = renderHook(({ enabled }: { enabled: boolean }) => usePlanUsage('owner', enabled), { initialProps: { enabled: false } })
  expect(read).not.toHaveBeenCalled()
  read.mockResolvedValueOnce(trial)
  view.rerender({ enabled: true })
  await settle()
  const signal = read.mock.calls[0][0]!
  view.rerender({ enabled: false })
  expect(signal.aborted).toBe(true)
  await act(async () => { jest.advanceTimersByTime(2_000) })
  expect(read).toHaveBeenCalledTimes(1)
  view.rerender({ enabled: true })
  await settle()
  expect(view.result.current.usage).toEqual(free)
  expect(read).toHaveBeenCalledTimes(2)
})

test('account changes and logout hide old data, abort previous reads and ignore their late responses', async () => {
  read.mockResolvedValueOnce(trial)
  const view = renderHook(({ token, enabled }: { token: string | undefined; enabled: boolean }) => usePlanUsage(token, enabled), { initialProps: { token: 'first' as string | undefined, enabled: true } })
  await settle()
  let finish!: (usage: PlanUsage) => void
  read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  view.rerender({ token: 'second', enabled: true })
  expect(view.result.current.usage).toBeNull()
  const signal = read.mock.calls[1][0]!
  view.rerender({ token: undefined, enabled: false })
  await act(async () => finish({ plan: 'PREMIUM', items: [] }))
  expect(signal.aborted).toBe(true)
  expect(view.result.current).toMatchObject({ usage: null, failed: false, loading: false })
  await act(async () => { jest.advanceTimersByTime(2_000) })
  expect(read).toHaveBeenCalledTimes(2)
})

test('unmount cancels the active request and timer', async () => {
  const schedule = jest.spyOn(globalThis, 'setTimeout')
  const cancel = jest.spyOn(globalThis, 'clearTimeout')
  read.mockResolvedValueOnce(trial)
  const view = renderHook(() => usePlanUsage('owner', true))
  await settle()
  const signal = read.mock.calls[0][0]!
  const timerIndex = schedule.mock.calls.findIndex(call => call[1] === 1_000)
  expect(timerIndex).toBeGreaterThanOrEqual(0)
  const deadlineTimer = schedule.mock.results[timerIndex]!.value
  view.unmount()
  expect(signal.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledWith(deadlineTimer)
})
