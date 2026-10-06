// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import { RouteDocumentTitle } from './RouteDocumentTitle'

afterEach(cleanup)

it('화면을 옮기면 브라우저 제목도 그 화면 이름으로 바꾼다', () => {
  render(<MemoryRouter initialEntries={['/app/saved-programs']}>
    <RouteDocumentTitle />
    <Link to="/app/combination-reviews">검토로</Link>
    <Link to="/app/chat?mode=filter">필터 검색으로</Link>
  </MemoryRouter>)
  expect(document.title).toBe('관심 공고함 · GovBiz')

  fireEvent.click(screen.getByRole('link', { name: '검토로' }))
  expect(document.title).toBe('중복 지원·수혜 검토 · GovBiz')

  // 같은 화면에서 검색 방식만 바꿔도 제목이 따라갑니다.
  fireEvent.click(screen.getByRole('link', { name: '필터 검색으로' }))
  expect(document.title).toBe('필터 검색 · GovBiz')
})
