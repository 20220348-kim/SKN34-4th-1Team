// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import { WorkspacePageHeader } from './WorkspacePageHeader'

afterEach(cleanup)

it('renders every parent as a link before the title on one row', () => {
  render(<MemoryRouter><WorkspacePageHeader parent={[{ to: '/app/docs', label: '신청 문서 작성' }, { to: '/app/docs/12', label: '답변 입력' }]}
    title="신청 문서 초안" /></MemoryRouter>)
  const crumbs = screen.getByRole('navigation', { name: '상위 화면' })
  expect(within(crumbs).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]))
    .toEqual([['신청 문서 작성', '/app/docs'], ['답변 입력', '/app/docs/12']])
  expect(screen.getByRole('heading', { level: 1, name: '신청 문서 초안' })).toBeTruthy()
  // 머리글은 한 줄이라 부제 같은 설명 문단이 없습니다.
  expect(screen.getByRole('banner').querySelector('p')).toBeNull()
})

it('offers a compact back link to the nearest parent and a one-line title for narrow screens while hiding the crumbs there', () => {
  render(<MemoryRouter><WorkspacePageHeader parent={[{ to: '/app', label: '작업' }, { to: '/app/docs', label: '신청 문서 작성' }]}
    title="답변 입력" /></MemoryRouter>)
  // 바로 위 화면으로 가는 [←]은 600px 미만에서만 보이고, 경로는 600px 미만에서 숨습니다.
  const back = screen.getByRole('link', { name: '신청 문서 작성으로 돌아가기' })
  expect(back.getAttribute('href')).toBe('/app/docs')
  expect(back.className).toContain('hidden')
  expect(back.className).toContain('max-[599px]:grid')
  expect(screen.getByRole('navigation', { name: '상위 화면' }).className).toContain('max-[599px]:hidden')
  // 뒤로 가기와 제목은 같은 줄에 있고, 제목은 한 줄로 줄어듭니다.
  const heading = screen.getByRole('heading', { level: 1, name: '답변 입력' })
  expect(heading.parentElement).toBe(back.parentElement)
  expect(heading.parentElement!.className).toContain('max-[599px]:flex-nowrap')
  expect(heading.className).toContain('max-[599px]:truncate')
})

it('has no back link without a parent', () => {
  render(<MemoryRouter><WorkspacePageHeader title="관심 공고함" /></MemoryRouter>)
  expect(screen.queryByRole('link')).toBeNull()
})

it('publishes its height to the scroll container so other sticky elements can sit below it', () => {
  const { container, unmount } = render(<MemoryRouter><WorkspacePageHeader title="답변 입력" /></MemoryRouter>)
  expect(container.style.getPropertyValue('--workspace-header-h')).toMatch(/^\d+px$/)
  unmount()
  expect(container.style.getPropertyValue('--workspace-header-h')).toBe('')
})
