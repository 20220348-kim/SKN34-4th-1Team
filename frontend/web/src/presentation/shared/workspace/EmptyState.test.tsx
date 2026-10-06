// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EmptyState } from './EmptyState'

afterEach(cleanup)

describe('EmptyState', () => {
  it('지금 상태 · 한 줄 설명 · 다음 행동 링크 하나를 제목으로 묶인 구역에 보여 준다', () => {
    render(<MemoryRouter><EmptyState icon={<svg data-testid="icon" />} title="관심 공고가 없어요"
      description="공고 상세에서 담으면 여기에 모여요." action={{ label: '공고 찾기', to: '/app/chat' }} /></MemoryRouter>)

    const region = screen.getByRole('region', { name: '관심 공고가 없어요' })
    expect(screen.getByRole('heading', { level: 2, name: '관심 공고가 없어요' })).toBeTruthy()
    expect(region.textContent).toContain('공고 상세에서 담으면 여기에 모여요.')
    expect(screen.getByRole('link', { name: '공고 찾기' }).getAttribute('href')).toBe('/app/chat')
    // 아이콘은 장식이라 낭독하지 않습니다.
    expect(screen.getByTestId('icon').parentElement?.getAttribute('aria-hidden')).toBe('true')
    // 점선 테두리는 빈 화면에만 씁니다.
    expect(region.className).toContain('border-dashed')
  })

  it('화면 안의 행동은 버튼으로 두고, 설명·아이콘·행동 없이도 제목만으로 그린다', () => {
    const onClick = vi.fn()
    const { rerender } = render(<EmptyState title="조건에 맞는 공고가 없어요" headingLevel={3} action={{ label: '필터 초기화', onClick }} />)
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { level: 3, name: '조건에 맞는 공고가 없어요' })).toBeTruthy()

    rerender(<EmptyState title="아직 기록이 없어요" />)
    expect(screen.getByRole('region', { name: '아직 기록이 없어요' }).querySelectorAll('p, a, button, [aria-hidden]')).toHaveLength(0)
  })
})
