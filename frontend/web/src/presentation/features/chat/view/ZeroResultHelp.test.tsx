// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ZeroResultHelp } from './ZeroResultHelp'

afterEach(cleanup)

describe('결과가 없을 때 다시 찾기 도움', () => {
  it('센 사유와 뺀 공고 수를 붙인 조건 빼기를 보이고, 누르면 고른 빼기와 다른 표현 입력을 알린다', () => {
    const onRelax = vi.fn()
    const onRephrase = vi.fn()
    const region = { kind: 'REGION' as const, label: '지역 조건 빼고 찾기', excludedCount: 4 }
    const closed = { kind: 'ACCEPTING_ONLY' as const, label: '마감·예정 공고도 찾기', excludedCount: null }
    render(<ZeroResultHelp explanation="관련 후보 20건을 살펴봤지만 회사 지역과 맞지 않는 공고 4건이라 추천하지 않았어요."
      relaxations={[region, closed]} disabled={false} onRelax={onRelax} onRephrase={onRephrase} />)

    expect(screen.getByText(/회사 지역과 맞지 않는 공고 4건/)).toBeTruthy()
    const actions = within(screen.getByRole('group', { name: '조건을 바꿔 다시 찾기' }))
    expect(actions.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '지역 조건 빼고 찾기 · 뺀 공고 4건', '마감·예정 공고도 찾기', '다른 표현으로 다시 말하기',
    ])
    fireEvent.click(actions.getByRole('button', { name: /지역 조건 빼고 찾기/ }))
    expect(onRelax).toHaveBeenCalledWith(region)
    fireEvent.click(actions.getByRole('button', { name: '다른 표현으로 다시 말하기' }))
    expect(onRephrase).toHaveBeenCalledTimes(1)
    expect(screen.getByText('고른 조건은 확인 카드에서 한 번 더 확인한 뒤 검색해요.')).toBeTruthy()
  })

  it('요청을 처리하는 동안에는 누를 수 없고, 수를 모르면 사유 문장 없이 다른 표현 입력만 남는다', () => {
    const { rerender } = render(<ZeroResultHelp explanation={null} relaxations={[{ kind: 'REGION', label: '지역 조건 빼고 찾기', excludedCount: null }]}
      disabled onRelax={vi.fn()} onRephrase={vi.fn()} />)
    expect(screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getByRole('button', { name: '지역 조건 빼고 찾기' })).toBeTruthy()

    rerender(<ZeroResultHelp explanation={null} relaxations={[]} disabled={false} onRelax={vi.fn()} onRephrase={vi.fn()} />)
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['다른 표현으로 다시 말하기'])
    expect(screen.queryByText(/확인 카드에서/)).toBeNull()
  })
})
