import { fireEvent, render } from '@testing-library/react-native'
import { useState } from 'react'
import { ChoiceField } from './ChoiceField'
import { colors } from '../ui'

const options = [{ value: 'first', label: '첫 번째' }, { value: 'second', label: '두 번째' }]

test('an empty choice displays its placeholder and commits only the selected option', () => {
  const change = jest.fn()
  const view = render(<ChoiceField label="선택" value="" placeholder="항목을 골라 주세요" options={options} onChange={change} compact />)
  expect(view.getByText('항목을 골라 주세요 ▾')).toHaveStyle({ color: colors.placeholder })
  fireEvent.press(view.getByLabelText('선택: 항목을 골라 주세요'))
  expect(view.getAllByRole('radio').every(option => option.props.accessibilityState.checked === false)).toBe(true)
  fireEvent.press(view.getByRole('radio', { name: '두 번째' }))
  expect(change).toHaveBeenCalledTimes(1)
  expect(change).toHaveBeenCalledWith('second')
  expect(view.queryAllByRole('radio')).toHaveLength(0)
})

test('an empty-valued existing option keeps its label and body color rather than showing the placeholder', () => {
  const view = render(<ChoiceField label="조건" value="" placeholder="항목을 골라 주세요"
    options={[{ value: '', label: '전체' }, ...options]} onChange={jest.fn()} compact />)
  expect(view.getByLabelText('조건: 전체')).toBeTruthy()
  expect(view.getByText('전체 ▾')).toHaveStyle({ color: colors.text })
  expect(view.queryByText('항목을 골라 주세요 ▾')).toBeNull()
})

test('disabling an open picker closes it and does not reopen it when work finishes', () => {
  const change = jest.fn()
  const view = render(<ChoiceField label="선택" value="first" options={options} onChange={change} compact />)
  fireEvent.press(view.getByLabelText('선택: 첫 번째'))
  expect(view.getByRole('radio', { name: '첫 번째', checked: true })).toBeTruthy()
  view.rerender(<ChoiceField label="선택" value="first" options={options} onChange={change} disabled compact />)
  expect(view.getByLabelText('선택: 첫 번째')).toBeDisabled()
  expect(view.queryAllByRole('radio')).toHaveLength(0)
  view.rerender(<ChoiceField label="선택" value="first" options={options} onChange={change} compact />)
  expect(view.queryAllByRole('radio')).toHaveLength(0)
  expect(change).not.toHaveBeenCalled()
})

test('the existing full-page picker retains option labels and selection when no placeholder is supplied', () => {
  function Host() {
    const [value, setValue] = useState('first')
    return <ChoiceField label="기존 선택" value={value} options={options} onChange={setValue} />
  }
  const view = render(<Host />)
  fireEvent.press(view.getByLabelText('기존 선택: 첫 번째'))
  fireEvent.press(view.getByRole('radio', { name: '두 번째' }))
  fireEvent.press(view.getByLabelText('기존 선택: 두 번째'))
  expect(view.getByRole('radio', { name: '두 번째', checked: true })).toBeTruthy()
})
