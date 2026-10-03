// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../app/store'
import type { Account } from '../../../domain/entities/Account'
import { GuestOnly, PublicOnly, RequireAuth } from './RouteGuards'
import { sessionRestored } from './state/authSlice'

const member: Account = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderGuards(path: string) {
  const store = createAppStore()
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<PublicOnly />}><Route path="/" element={<p>공개 화면</p>} /></Route>
          <Route element={<GuestOnly />}><Route path="/login" element={<p>로그인 화면</p>} /></Route>
          <Route element={<RequireAuth />}><Route path="/app/saved-programs" element={<p>작업 화면</p>} /></Route>
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
  return store
}

describe('세션을 확인하는 동안의 라우트 보호', () => {
  it.each(['/', '/login', '/app/saved-programs'])('%s는 빈 화면 대신 확인 중 상태를 알리고, 표시는 잠시 뒤에 보인다', (path) => {
    vi.useFakeTimers()
    renderGuards(path)

    const status = screen.getByRole('status')
    expect(status.textContent).toBe('로그인 상태를 확인하고 있어요.')
    const note = status.querySelector('p')!
    const spinner = status.querySelector('[aria-hidden="true"]')!
    // 금방 끝나는 복원에서 깜빡이지 않도록 처음에는 낭독기에만 알립니다.
    expect(note.classList.contains('sr-only')).toBe(true)
    expect(spinner.classList.contains('invisible')).toBe(true)
    act(() => { vi.advanceTimersByTime(300) })
    expect(note.classList.contains('sr-only')).toBe(false)
    expect(spinner.classList.contains('invisible')).toBe(false)
    expect(spinner.classList.contains('motion-safe:animate-spin')).toBe(true)
  })

  it('세션이 없으면 확인 중 표시를 지우고 지금 주소로 돌아오는 로그인으로 보낸다', () => {
    const store = renderGuards('/app/saved-programs')
    act(() => { store.dispatch(sessionRestored(null)) })

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('로그인 화면')).toBeTruthy()
  })

  it('세션이 확인되면 확인 중 표시 대신 원래 화면을 연다', () => {
    const store = renderGuards('/app/saved-programs')
    act(() => { store.dispatch(sessionRestored(member)) })

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('작업 화면')).toBeTruthy()
  })
})
