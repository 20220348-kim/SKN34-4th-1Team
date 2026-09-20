import { fireEvent, within } from '@testing-library/react'

/**
 * 공용 드롭다운(`SelectField`)에서 값을 고릅니다. 기본 `<select>`의 `fireEvent.change` 대신 씁니다.
 * 버튼을 눌러 목록을 열고 값이 같은 항목을 누릅니다. 목록이 이미 열려 있으면 그대로 고릅니다.
 */
export function chooseOption(combobox: HTMLElement, value: string) {
  if (combobox.getAttribute('aria-expanded') !== 'true') fireEvent.click(combobox)
  const listbox = document.getElementById(combobox.getAttribute('aria-controls') ?? '')
  if (!listbox) throw new Error(`드롭다운 목록이 열리지 않았습니다: ${combobox.getAttribute('aria-label') ?? combobox.id}`)
  const option = within(listbox).getAllByRole('option').find((item) => item.getAttribute('data-value') === value)
  if (!option) throw new Error(`드롭다운에 값이 없습니다: ${value}`)
  fireEvent.click(option)
}

/** 드롭다운의 현재 값입니다. 기본 `<select>`의 `.value` 대신 씁니다. */
export function selectedValue(combobox: HTMLElement): string {
  return combobox.getAttribute('data-value') ?? ''
}

/** 드롭다운을 열어 항목 글자 목록을 읽고 다시 닫습니다. 기본 `<select>`의 `.options` 대신 씁니다. */
export function optionLabels(combobox: HTMLElement): string[] {
  fireEvent.click(combobox)
  const listbox = document.getElementById(combobox.getAttribute('aria-controls') ?? '')
  const labels = listbox ? within(listbox).getAllByRole('option').map((item) => item.textContent ?? '') : []
  fireEvent.click(combobox)
  return labels
}

/** 드롭다운을 열어 항목 값 목록을 읽고 다시 닫습니다. 기본 `<select>`의 `[...options].map(o => o.value)` 대신 씁니다. */
export function optionValues(combobox: HTMLElement): string[] {
  fireEvent.click(combobox)
  const listbox = document.getElementById(combobox.getAttribute('aria-controls') ?? '')
  const values = listbox ? within(listbox).getAllByRole('option').map((item) => item.getAttribute('data-value') ?? '') : []
  fireEvent.click(combobox)
  return values
}
