// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SearchIntroTitle } from './SearchIntroTitle'

const title = '우리 회사에 맞는 지원사업, AI와 함께 무료로 찾아보세요.'
let onIntersection: IntersectionObserverCallback
let reducedMotion: MediaQueryList
let disconnect: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  reducedMotion = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => reducedMotion))
  disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { onIntersection = callback }
    observe = vi.fn()
    disconnect = disconnect
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function intersect(isVisible: boolean) {
  act(() => onIntersection([{ isIntersecting: isVisible, intersectionRatio: isVisible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver))
}

function firstCharacter() {
  return screen.getByRole('heading', { name: title }).querySelector('[data-title-character]') as HTMLElement
}

describe('홈 제목의 드문 글자별 등장', () => {
  it('완성된 제목을 접근 가능한 이름으로 유지하고 무료로를 강조하며 글자 공간을 미리 확보한다', () => {
    render(<SearchIntroTitle />)
    const heading = screen.getByRole('heading', { level: 1, name: title })
    expect(heading.textContent?.replace(/\s+/g, ' ').trim()).toBe(title)
    expect(heading.querySelectorAll('[data-title-line][aria-hidden="true"]')).toHaveLength(2)
    const freeWord = Array.from(heading.querySelectorAll('span')).find((node) => node.textContent === '무료로')!
    expect(freeWord.className).toContain('font-black')
    expect(freeWord.className).toContain('underline')
    const characters = Array.from(heading.querySelectorAll<HTMLElement>('[data-title-character]'))
    expect(characters.map((node) => node.textContent).join('')).toBe(title.replaceAll(' ', ''))
    expect(characters.every((node, index) => index === 0 || parseInt(node.style.animationDelay) > parseInt(characters[index - 1].style.animationDelay))).toBe(true)
  })

  it('보이는 동안 40초마다 글자만 다시 표시하고 기존 행 등장·색상 요소는 재생성하지 않는다', () => {
    render(<SearchIntroTitle />)
    intersect(true)
    const heading = screen.getByRole('heading', { name: title })
    const line = heading.querySelector('[data-title-line]')
    const highlight = heading.querySelector('[data-title-highlight]')
    const initialCharacter = firstCharacter()
    act(() => vi.advanceTimersByTime(39_999))
    expect(firstCharacter()).toBe(initialCharacter)
    act(() => vi.advanceTimersByTime(1))
    expect(firstCharacter()).not.toBe(initialCharacter)
    expect(heading.querySelector('[data-title-line]')).toBe(line)
    expect(heading.querySelector('[data-title-highlight]')).toBe(highlight)
    const secondCharacter = firstCharacter()
    act(() => vi.advanceTimersByTime(40_000))
    expect(firstCharacter()).not.toBe(secondCharacter)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('제목이 화면 밖이면 진행 중 글자를 전부 표시하고 복귀 직후 재생하지 않는다', () => {
    render(<SearchIntroTitle />)
    intersect(true)
    const initialCharacter = firstCharacter()
    intersect(false)
    expect(firstCharacter().className).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(80_000))
    expect(firstCharacter()).toBe(initialCharacter)
    intersect(true)
    act(() => vi.advanceTimersByTime(39_999))
    expect(firstCharacter()).toBe(initialCharacter)
    act(() => vi.advanceTimersByTime(1))
    expect(firstCharacter()).not.toBe(initialCharacter)
  })

  it('브라우저 탭이 숨겨지면 재생을 멈추고 타이머를 제거한다', () => {
    render(<SearchIntroTitle />)
    intersect(true)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(firstCharacter().className).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(vi.getTimerCount()).toBe(1)
    expect(firstCharacter().className).toBe('')
  })

  it('동작 줄이기를 켜면 즉시 정적으로 표시하고 끈 뒤에도 40초를 기다린다', () => {
    render(<SearchIntroTitle />)
    intersect(true)
    Object.assign(reducedMotion, { matches: true })
    act(() => reducedMotion.dispatchEvent(new Event('change')))
    expect(firstCharacter().className).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    Object.assign(reducedMotion, { matches: false })
    act(() => reducedMotion.dispatchEvent(new Event('change')))
    const current = firstCharacter()
    act(() => vi.advanceTimersByTime(39_999))
    expect(firstCharacter()).toBe(current)
    act(() => vi.advanceTimersByTime(1))
    expect(firstCharacter()).not.toBe(current)
  })

  it('처음부터 동작 줄이기 설정이면 반복 타이머를 만들지 않는다', () => {
    Object.assign(reducedMotion, { matches: true })
    render(<SearchIntroTitle />)
    intersect(true)
    expect(firstCharacter().className).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('상위 화면 렌더링만으로 글자 효과를 처음부터 다시 시작하지 않는다', () => {
    const { rerender } = render(<SearchIntroTitle />)
    intersect(true)
    const initialCharacter = firstCharacter()
    rerender(<SearchIntroTitle />)
    expect(firstCharacter()).toBe(initialCharacter)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('제목이 사라질 때 타이머와 이벤트 구독을 해제한다', () => {
    const { unmount } = render(<SearchIntroTitle />)
    intersect(true)
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      reducedMotion.dispatchEvent(new Event('change'))
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
