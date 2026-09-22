// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore } from '../../../../app/store'
import { useSignupViewModel } from './useSignupViewModel'

afterEach(cleanup)

function setup() {
  const store = createAppStore()
  const send = { execute: vi.fn().mockResolvedValue({ outcome: 'sent' }) }
  const verify = { execute: vi.fn() }
  const signup = { execute: vi.fn() }
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}><MemoryRouter>{children}</MemoryRouter></Provider>
  return { ...renderHook(() => useSignupViewModel(signup, send, verify), { wrapper }), send, verify }
}

describe('회원가입 이메일 인증 요청', () => {
  it('이메일 형식이 잘못되면 인증번호 요청을 시작하지 않는다', async () => {
    const { result, send } = setup()
    act(() => result.current.updateEmail('not-an-email'))
    expect(result.current.canSendCode).toBe(false)
    await act(async () => result.current.sendCode())
    expect(send.execute).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
    expect(result.current.isSendingCode).toBe(false)
  })

  it('이메일을 변경하면 이전 주소의 발송 응답은 새 주소의 인증 단계를 바꾸지 않는다', async () => {
    const pending = deferred<{ outcome: 'sent' }>()
    const { result, send } = setup()
    send.execute.mockReturnValueOnce(pending.promise)
    act(() => result.current.updateEmail('first@example.com'))
    let sending!: Promise<void>
    act(() => { sending = result.current.sendCode() })
    act(() => result.current.updateEmail('second@example.com'))
    await act(async () => { pending.resolve({ outcome: 'sent' }); await sending })
    expect(result.current.emailStep).toBe('idle')
    expect(result.current.codeNotice).toBeNull()
    expect(result.current.isSendingCode).toBe(false)
  })

  it('이메일을 변경하면 이전 주소의 인증 성공을 새 주소에 적용하지 않는다', async () => {
    const pending = deferred<{ outcome: 'verified'; passToken: string }>()
    const { result, verify } = setup()
    verify.execute.mockReturnValueOnce(pending.promise)
    act(() => result.current.updateEmail('first@example.com'))
    await act(async () => result.current.sendCode())
    act(() => result.current.updateCode('123456'))
    let verifying!: Promise<void>
    act(() => { verifying = result.current.verifyCode() })
    const signal = verify.execute.mock.calls[0]?.[2] as AbortSignal | undefined
    act(() => result.current.updateEmail('second@example.com'))
    await act(async () => { pending.resolve({ outcome: 'verified', passToken: 'a'.repeat(43) }); await verifying })
    expect(result.current.emailStep).toBe('idle')
    expect(result.current.codeNotice).toBeNull()
    expect(result.current.isVerifyingCode).toBe(false)
    expect(signal?.aborted).toBe(true)
  })

  it('검증 중에는 재발송 요청으로 서버의 인증번호를 교체하지 않는다', async () => {
    const pending = deferred<{ outcome: 'verified'; passToken: string }>()
    const { result, send, verify } = setup()
    verify.execute.mockReturnValueOnce(pending.promise)
    act(() => result.current.updateEmail('first@example.com'))
    await act(async () => result.current.sendCode())
    act(() => result.current.updateCode('123456'))
    let verifying!: Promise<void>
    act(() => { verifying = result.current.verifyCode() })
    expect(result.current.canSendCode).toBe(false)
    await act(async () => result.current.sendCode())
    await act(async () => { pending.resolve({ outcome: 'verified', passToken: 'a'.repeat(43) }); await verifying })
    expect(send.execute).toHaveBeenCalledTimes(1)
    expect(result.current.emailStep).toBe('verified')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
