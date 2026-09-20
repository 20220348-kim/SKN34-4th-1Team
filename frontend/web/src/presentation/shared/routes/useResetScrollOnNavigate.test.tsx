// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { useResetScrollOnNavigate } from './useResetScrollOnNavigate'

afterEach(cleanup)

function scrollable(element: HTMLElement, top: number) {
  // jsdom은 레이아웃이 없어 scrollTop 대입을 무시하므로, 쓰기 가능한 값으로 바꿔 훅의 대입을 관찰합니다.
  Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: top })
}

function Layout() {
  const ref = useRef<HTMLDivElement>(null)
  useResetScrollOnNavigate(ref)
  return <div ref={ref} data-testid="workspace">
    <Routes>
      <Route path="/a" element={<Link to="/b">b로</Link>} />
      <Route path="/b" element={<Link to="/b?tab=2">같은 화면 탭</Link>} />
    </Routes>
  </div>
}

function DocumentLayout() {
  useResetScrollOnNavigate()
  return <Routes>
    <Route path="/a" element={<Link to="/b">b로</Link>} />
    <Route path="/b" element={<p>b</p>} />
  </Routes>
}

describe('화면 이동 시 스크롤 초기화', () => {
  it('작업 칸을 넘기면 경로가 바뀔 때만 그 요소의 스크롤을 맨 위로 돌리고 쿼리 변경은 그대로 둔다', () => {
    render(<MemoryRouter initialEntries={['/a']}><Layout /></MemoryRouter>)
    const workspace = screen.getByTestId('workspace')
    scrollable(workspace, 480)
    act(() => screen.getByRole('link', { name: 'b로' }).click())
    expect(workspace.scrollTop).toBe(0)

    scrollable(workspace, 320)
    act(() => screen.getByRole('link', { name: '같은 화면 탭' }).click())
    expect(workspace.scrollTop).toBe(320)
  })

  it('넘기지 않으면 문서 스크롤을 돌린다', () => {
    render(<MemoryRouter initialEntries={['/a']}><DocumentLayout /></MemoryRouter>)
    scrollable(document.documentElement, 900)
    act(() => screen.getByRole('link', { name: 'b로' }).click())
    expect(document.documentElement.scrollTop).toBe(0)
  })
})
