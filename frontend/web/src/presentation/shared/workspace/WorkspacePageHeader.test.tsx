// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import { WorkspacePageHeader } from './WorkspacePageHeader'

afterEach(cleanup)

it('renders the current crumb as plain text after the parent link and the subtitle under the title', () => {
  render(<MemoryRouter><WorkspacePageHeader parent={{ to: '/app/docs', label: '신청 문서 작성' }} current="혁신바우처 지원사업"
    title="답변 입력" subtitle="사업계획서 · 일반 신청" /></MemoryRouter>)
  const crumbs = screen.getByRole('navigation', { name: '상위 화면' })
  expect(within(crumbs).getByRole('link', { name: '신청 문서 작성' }).getAttribute('href')).toBe('/app/docs')
  expect(within(crumbs).getByText('혁신바우처 지원사업').tagName).toBe('SPAN')
  expect(within(crumbs).getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('heading', { level: 1, name: '답변 입력' })).toBeTruthy()
  expect(screen.getByText('사업계획서 · 일반 신청')).toBeTruthy()
})

it('keeps the plain title layout for callers without a subtitle or current crumb', () => {
  render(<MemoryRouter><WorkspacePageHeader parent={{ to: '/app/docs', label: '신청 문서 작성' }} title="답변 입력" /></MemoryRouter>)
  expect(within(screen.getByRole('navigation', { name: '상위 화면' })).getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('banner').querySelector('p')).toBeNull()
})

it('offers a compact back link and title row for narrow screens while hiding the crumb and subtitle there', () => {
  render(<MemoryRouter><WorkspacePageHeader parent={[{ to: '/app', label: '작업' }, { to: '/app/docs', label: '신청 문서 작성' }]}
    current="혁신바우처 지원사업" title="답변 입력" subtitle="사업계획서 · 일반 신청" /></MemoryRouter>)
  // 바로 위 화면으로 가는 [←]은 600px 미만에서만 보이고, 경로·현재 위치·부제는 600px 미만에서 숨습니다.
  const back = screen.getByRole('link', { name: '신청 문서 작성으로 돌아가기' })
  expect(back.getAttribute('href')).toBe('/app/docs')
  expect(back.className).toContain('hidden')
  expect(back.className).toContain('max-[599px]:grid')
  expect(screen.getByRole('navigation', { name: '상위 화면' }).className).toContain('max-[599px]:hidden')
  expect(screen.getByText('사업계획서 · 일반 신청').className).toContain('max-[599px]:hidden')
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
