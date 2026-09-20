// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chooseOption, optionLabels, selectedValue } from '../../../test/selectField'
import { SelectField, selectFieldRowPx, selectFieldVisibleRows } from './SelectField'

afterEach(cleanup)

const options = Array.from({ length: 12 }, (_, index) => ({ value: `v${index + 1}`, label: `항목 ${index + 1}` }))

function Harness({ onChange = () => {}, initial = 'v2' }: { onChange?: (value: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial)
  return <>
    <label htmlFor="pick">고르기</label>
    <SelectField id="pick" value={value} options={options} onChange={(next) => { setValue(next); onChange(next) }} />
  </>
}

describe('공용 드롭다운', () => {
  it('버튼은 combobox로 라벨과 현재 값을 알리고, 목록은 눌러서 열어 항목을 고르면 닫힌다', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const combobox = screen.getByRole('combobox', { name: '고르기' })
    expect(combobox.textContent).toContain('항목 2')
    expect(selectedValue(combobox)).toBe('v2')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(combobox)
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(12)
    expect(within(listbox).getByRole('option', { name: '항목 2' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(within(listbox).getByRole('option', { name: '항목 7' }))
    expect(onChange).toHaveBeenCalledWith('v7')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(combobox.textContent).toContain('항목 7')
    expect(document.activeElement).toBe(combobox)
  })

  it('키보드로 열고 옮기고 고르며 Esc로 닫는다', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const combobox = screen.getByRole('combobox', { name: '고르기' })
    combobox.focus()
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    const listbox = screen.getByRole('listbox')
    // 현재 값(항목 2)에서 시작해 아래로 두 칸 옮기면 항목 4가 활성 줄이 됩니다.
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    const active = document.getElementById(combobox.getAttribute('aria-activedescendant')!)!
    expect(active.textContent).toBe('항목 4')
    expect(listbox.contains(active)).toBe(true)
    fireEvent.keyDown(combobox, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('v4')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(combobox, { key: ' ' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(combobox, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('바깥을 누르면 닫히고, 테스트 도우미로 값과 항목을 읽고 고를 수 있다', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const combobox = screen.getByRole('combobox', { name: '고르기' })
    fireEvent.click(combobox)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()

    expect(optionLabels(combobox)).toEqual(options.map((option) => option.label))
    expect(screen.queryByRole('listbox')).toBeNull()
    chooseOption(combobox, 'v11')
    expect(onChange).toHaveBeenCalledWith('v11')
    expect(selectedValue(combobox)).toBe('v11')
  })

  it('<label>이 감싸고 있어도 항목을 고르면 닫힌 채로 남는다', () => {
    const onChange = vi.fn()
    function Wrapped() {
      const [value, setValue] = useState('v1')
      return <label>정렬 <SelectField label="정렬" value={value} options={options} onChange={(next) => { setValue(next); onChange(next) }} /></label>
    }
    render(<Wrapped />)
    const combobox = screen.getByRole('combobox', { name: '정렬' })
    fireEvent.click(combobox)
    // 실제 브라우저처럼 label 안쪽 클릭이 버튼 클릭으로 이어지는 상황을 흉내 냅니다.
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: '항목 3' })
    fireEvent.mouseDown(option)
    fireEvent.click(option)
    expect(onChange).toHaveBeenCalledWith('v3')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(combobox.getAttribute('aria-expanded')).toBe('false')
  })

  it('목록은 8줄 높이까지만 펼치는 최대 높이를 갖는다', () => {
    expect(selectFieldVisibleRows).toBe(8)
    expect(selectFieldRowPx * selectFieldVisibleRows).toBe(320)
  })
})
