import { fireEvent, render, screen } from '@testing-library/react-native'
import { pricingFrequentlyAskedQuestions, pricingPlans } from '@govbiz/shared/design/pricingContent'
import { PricingScreen } from './PricingScreen'

test('plan tabs show one plan at a time with the shared price, benefits and availability', () => {
  const onSearch = jest.fn(), onPlus = jest.fn()
  const request = jest.spyOn(globalThis, 'fetch')
  render(<PricingScreen onSearch={onSearch} onPlus={onPlus} />)
  expect(screen.getByRole('tab', { name: '플러스' }).props.accessibilityState.selected).toBe(true)
  expect(screen.getByText('월 9,900원')).toBeTruthy()
  expect(screen.getByText('정식 출시 전까지 회원 무료')).toBeTruthy()
  for (const plan of pricingPlans) {
    fireEvent.press(screen.getByRole('tab', { name: plan.name }))
    expect(screen.getByRole('tab', { name: plan.name }).props.accessibilityState.selected).toBe(true)
    expect(screen.getByText(plan.price)).toBeTruthy()
    for (const feature of plan.features) expect(screen.getByText(feature)).toBeTruthy()
    for (const other of pricingPlans.filter(item => item.id !== plan.id)) expect(screen.queryByText(other.description)).toBeNull()
  }
  expect(screen.getByText('월 29,000원')).toBeTruthy()
  const pending = screen.getByRole('button', { name: '출시 준비 중' })
  expect(pending.props.accessibilityState.disabled).toBe(true)
  fireEvent.press(pending)
  expect(onSearch).not.toHaveBeenCalled()
  expect(onPlus).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  request.mockRestore()
  expect(screen.queryByText('다음 기회가 될 공고를 만나보세요')).toBeNull()
  expect(screen.queryByRole('button', { name: '지원사업 찾기 시작하기' })).toBeNull()
})

test('the free and plus actions use their own destinations and an unresolved session cannot open plus', () => {
  const onSearch = jest.fn(), onPlus = jest.fn()
  const view = render(<PricingScreen onSearch={onSearch} onPlus={onPlus} />)
  fireEvent.press(screen.getByRole('button', { name: '지금 무료로 이용하기' }))
  expect(onPlus).toHaveBeenCalledTimes(1)
  expect(onSearch).not.toHaveBeenCalled()
  fireEvent.press(screen.getByRole('tab', { name: '무료' }))
  fireEvent.press(screen.getByRole('button', { name: '무료로 지원사업 찾기' }))
  expect(onSearch).toHaveBeenCalledTimes(1)
  view.rerender(<PricingScreen onSearch={onSearch} onPlus={onPlus} plusDisabled />)
  fireEvent.press(screen.getByRole('tab', { name: '플러스' }))
  fireEvent.press(screen.getByRole('button', { name: '지금 무료로 이용하기' }))
  expect(onPlus).toHaveBeenCalledTimes(1)
})

test('the compact comparison selects a plan and closes after opening its details', () => {
  render(<PricingScreen onSearch={jest.fn()} onPlus={jest.fn()} />)
  const compare = screen.getByRole('button', { name: '다른 요금제 한눈에 보기' })
  expect(compare.props.accessibilityState.expanded).toBe(false)
  fireEvent.press(compare)
  expect(screen.getByRole('button', { name: '무료 상세 보기' })).toBeTruthy()
  fireEvent.press(screen.getByRole('button', { name: '프리미엄 상세 보기' }))
  expect(screen.getByRole('tab', { name: '프리미엄' }).props.accessibilityState.selected).toBe(true)
  expect(screen.queryByRole('button', { name: '무료 상세 보기' })).toBeNull()
  expect(screen.getByRole('button', { name: '다른 요금제 한눈에 보기' }).props.accessibilityState.expanded).toBe(false)
})

test('each FAQ expands the shared answer and collapses without affecting the other questions', () => {
  render(<PricingScreen onSearch={jest.fn()} onPlus={jest.fn()} />)
  for (const faq of pricingFrequentlyAskedQuestions) {
    expect(screen.queryByText(faq.answer)).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: faq.question }))
    expect(screen.getByText(faq.answer)).toBeTruthy()
    expect(screen.getByRole('button', { name: faq.question }).props.accessibilityState.expanded).toBe(true)
    fireEvent.press(screen.getByRole('button', { name: faq.question }))
    expect(screen.queryByText(faq.answer)).toBeNull()
  }
})
