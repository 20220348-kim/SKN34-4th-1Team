// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { Account } from '../../../../domain/entities/Account'
import type { SavedSupportProgram } from '../../../../domain/entities/SavedSupportProgram'
import type { SaveSupportProgramResult } from '../../../../domain/repositories/SavedSupportProgramRepository'
import { sessionRestored, signedOut } from '../../../shared/auth/state/authSlice'
import { searchResultInterestKey, searchResultInterestMessages, useSearchResultInterests } from './useSearchResultInterests'

const member: Account = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }
const program = supportPrograms[0]!
const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
const key = searchResultInterestKey(identity)
const saved = { savedAt: '2026-09-16T10:00:00', program }

beforeEach(() => {
  vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute').mockResolvedValue([])
  vi.spyOn(appContainer.resolve('saveSupportProgramUseCase'), 'execute').mockResolvedValue({ outcome: 'saved', saved })
  vi.spyOn(appContainer.resolve('removeSavedSupportProgramUseCase'), 'execute').mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup(account: Account | null = member, hasResults = true) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  return { store, ...renderHook(({ active }) => useSearchResultInterests(active), {
    initialProps: { active: hasResults },
    wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>,
  }) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('useSearchResultInterests', () => {
  it('비로그인 또는 결과가 없으면 관심 API를 호출하지 않는다', () => {
    expect(setup(null).result.current).toBeNull()
    expect(setup(member, false).result.current).toBeNull()
    expect(appContainer.resolve('browseSavedSupportProgramsUseCase').execute).not.toHaveBeenCalled()
    expect(appContainer.resolve('saveSupportProgramUseCase').execute).not.toHaveBeenCalled()
  })

  it('관심 공고가 없으면 재시도 오류 없이 미등록 상태로 준비되고 바로 담을 수 있다', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    expect(result.current?.savedKeys.size).toBe(0)
    expect(result.current?.errors).toEqual({})
    expect(appContainer.resolve('browseSavedSupportProgramsUseCase').execute).toHaveBeenCalledOnce()

    await act(async () => { await result.current!.toggle(identity) })
    expect(result.current?.savedKeys.has(key)).toBe(true)
    expect(result.current?.phase).toBe('ready')
    expect(appContainer.resolve('saveSupportProgramUseCase').execute).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
  })

  it('목록은 한 번 조회하고 출처·원본 ID로 저장 여부를 구분하며 담기와 해제를 처리한다', async () => {
    const browse = vi.mocked(appContainer.resolve('browseSavedSupportProgramsUseCase').execute).mockResolvedValue([saved])
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    expect(result.current?.savedKeys.has(key)).toBe(true)
    expect(result.current?.savedKeys.has(searchResultInterestKey({ ...identity, sourceCode: 'MSIT' }))).toBe(false)
    const current = result.current
    rerender({ active: true })
    expect(result.current).toBe(current)
    expect(browse).toHaveBeenCalledOnce()

    await act(async () => { await result.current!.toggle(identity) })
    expect(result.current?.savedKeys.has(key)).toBe(false)
    expect(appContainer.resolve('removeSavedSupportProgramUseCase').execute).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
    await act(async () => { await result.current!.toggle(identity) })
    expect(result.current?.savedKeys.has(key)).toBe(true)
    expect(appContainer.resolve('saveSupportProgramUseCase').execute).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
    expect(searchResultInterestKey({ sourceCode: 'A:B', sourceProgramId: 'C' }))
      .not.toBe(searchResultInterestKey({ sourceCode: 'A', sourceProgramId: 'B:C' }))
  })

  it('조회 완료 전에는 변경하지 않고 조회 실패 후 다시 불러올 수 있다', async () => {
    const browse = vi.mocked(appContainer.resolve('browseSavedSupportProgramsUseCase').execute)
      .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([saved])
    const { result } = setup()
    await act(async () => { await result.current!.toggle(identity) })
    expect(appContainer.resolve('saveSupportProgramUseCase').execute).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current?.phase).toBe('failed'))
    act(() => result.current!.retry())
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    expect(result.current?.savedKeys.has(key)).toBe(true)
    expect(browse).toHaveBeenCalledTimes(2)
  })

  it('저장 중 중복 클릭은 무시하며 성공 전에는 관심 표시를 바꾸지 않는다', async () => {
    const pending = deferred<SaveSupportProgramResult>()
    const save = vi.mocked(appContainer.resolve('saveSupportProgramUseCase').execute).mockReturnValue(pending.promise)
    const { result } = setup()
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    act(() => { void result.current!.toggle(identity); void result.current!.toggle(identity) })
    expect(save).toHaveBeenCalledOnce()
    expect(result.current?.pendingKeys.has(key)).toBe(true)
    expect(result.current?.savedKeys.has(key)).toBe(false)
    await act(async () => pending.resolve({ outcome: 'saved', saved }))
    expect(result.current?.savedKeys.has(key)).toBe(true)
    expect(result.current?.pendingKeys.size).toBe(0)
  })

  it('변경 실패와 사라진 공고는 상태를 유지하고 같은 버튼으로 재시도할 수 있다', async () => {
    vi.mocked(appContainer.resolve('saveSupportProgramUseCase').execute)
      .mockResolvedValueOnce({ outcome: 'not-found' }).mockRejectedValueOnce(new Error('down'))
    const { result } = setup()
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    await act(async () => { await result.current!.toggle(identity) })
    expect(result.current?.errors[key]).toBe(searchResultInterestMessages.notFound)
    expect(result.current?.savedKeys.has(key)).toBe(false)
    await act(async () => { await result.current!.toggle(identity) })
    expect(result.current?.errors[key]).toBe(searchResultInterestMessages.saveFailed)
    expect(result.current?.savedKeys.has(key)).toBe(false)
    await act(async () => { await result.current!.toggle(identity) })
    expect(result.current?.errors[key]).toBe('')
    expect(result.current?.savedKeys.has(key)).toBe(true)
    vi.mocked(appContainer.resolve('removeSavedSupportProgramUseCase').execute).mockRejectedValueOnce(new Error('down'))
    await act(async () => { await result.current!.toggle(identity) })
    expect(result.current?.savedKeys.has(key)).toBe(true)
    expect(result.current?.errors[key]).toBe(searchResultInterestMessages.saveFailed)
  })

  it('계정 변경 시 이전 관심 상태와 늦게 도착한 저장 응답을 남기지 않는다', async () => {
    const pending = deferred<SaveSupportProgramResult>()
    const save = vi.mocked(appContainer.resolve('saveSupportProgramUseCase').execute).mockReturnValue(pending.promise)
    const { result, store } = setup()
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    act(() => { void result.current!.toggle(identity) })
    const signal = save.mock.calls[0]![1]!
    act(() => store.dispatch(sessionRestored({ ...member, email: 'another@example.test' })))
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    await act(async () => pending.resolve({ outcome: 'saved', saved }))
    expect(signal.aborted).toBe(true)
    expect(result.current?.savedKeys.size).toBe(0)
    expect(result.current?.pendingKeys.size).toBe(0)
    expect(result.current?.errors).toEqual({})
  })

  it('로그아웃 후 늦은 조회 결과를 무시하고 다음 로그인에서는 다시 조회한다', async () => {
    const pending = deferred<SavedSupportProgram[]>()
    const browse = vi.mocked(appContainer.resolve('browseSavedSupportProgramsUseCase').execute).mockReturnValueOnce(pending.promise)
    const { result, store } = setup()
    const signal = browse.mock.calls[0]![0]!
    act(() => store.dispatch(signedOut()))
    await act(async () => pending.resolve([saved]))
    expect(signal.aborted).toBe(true)
    expect(result.current).toBeNull()
    act(() => store.dispatch(sessionRestored(member)))
    await waitFor(() => expect(result.current?.phase).toBe('ready'))
    expect(result.current?.savedKeys.size).toBe(0)
    expect(browse).toHaveBeenCalledTimes(2)
  })
})
