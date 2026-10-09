import { fireEvent, render, screen } from '@testing-library/react-native'
import { pricingFrequentlyAskedQuestions, pricingPlans } from '@govbiz/shared/design/pricingContent'
import { PricingScreen } from './PricingScreen'

test('plan tabs show one plan at a time with the shared price and limits', () => {
  const onSearch = jest.fn()
  const request = jest.spyOn(globalThis, 'fetch')
  render(<PricingScreen onSearch={onSearch} />)
  expect(screen.getByRole('tab', { name: '플러스' }).props.accessibilityState.selected).toBe(true)
  // 금액을 크게, 이용 기간은 뒤에 작게 붙입니다.
  expect(screen.getByText('9,900원')).toBeTruthy()
  expect(screen.getByText('/ 30일')).toBeTruthy()
  for (const plan of pricingPlans) {
    fireEvent.press(screen.getByRole('tab', { name: plan.name }))
    expect(screen.getByRole('tab', { name: plan.name }).props.accessibilityState.selected).toBe(true)
    expect(screen.getByText(plan.price)).toBeTruthy()
    for (const limit of plan.limits) expect(screen.getByText(limit)).toBeTruthy()
    for (const other of pricingPlans.filter(item => item.id !== plan.id)) expect(screen.queryByText(other.description)).toBeNull()
  }
  expect(screen.getByText('29,000원')).toBeTruthy()
  expect(screen.queryByText(/세나요|다시 채워져요|표시한 가격은|출시 예정|지금 이용 가능/)).toBeNull()
  expect(screen.getByText('AI 대화 검색 1,500회')).toBeTruthy()
  expect(onSearch).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  request.mockRestore()
  expect(screen.queryByText('다음 기회가 될 공고를 만나보세요')).toBeNull()
  expect(screen.queryByRole('button', { name: '지원사업 찾기 시작하기' })).toBeNull()
})

test('only the free plan has an action and the app never offers a plan change, trial or payment', () => {
  const onSearch = jest.fn()
  render(<PricingScreen onSearch={onSearch} />)
  for (const name of ['플러스', '프리미엄']) {
    fireEvent.press(screen.getByRole('tab', { name }))
    expect(screen.queryByRole('button', { name: /체험|이용하기|출시 준비 중|결제|구독/ })).toBeNull()
  }
  expect(screen.queryByText(/14일 무료 체험 시작|요금제 바꾸기/)).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '무료' }))
  fireEvent.press(screen.getByRole('button', { name: '무료로 지원사업 찾기' }))
  expect(onSearch).toHaveBeenCalledTimes(1)
})

test('a signed-in member sees their current plan marked as in use instead of the recommended plan', () => {
  render(<PricingScreen onSearch={jest.fn()} currentPlan="PREMIUM" />)
  // 플러스는 추천 요금제지만 지금 요금제가 있으면 그 요금제만 강조합니다. 고정 상태 배지는 두지 않습니다.
  expect(screen.queryByText(/출시 예정|지금 이용 가능/)).toBeNull()
  expect(screen.queryByText('이용 중')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '프리미엄' }))
  expect(screen.getByText('이용 중')).toBeTruthy()
  fireEvent.press(screen.getByRole('button', { name: '다른 요금제 한눈에 보기' }))
  expect(screen.getByText('프리미엄 · 29,000원 / 30일 · 이용 중')).toBeTruthy()
  expect(screen.getByText('플러스 · 9,900원 / 30일')).toBeTruthy()
})

test('the compact comparison selects a plan and closes after opening its details', () => {
  render(<PricingScreen onSearch={jest.fn()} />)
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
  render(<PricingScreen onSearch={jest.fn()} />)
  for (const faq of pricingFrequentlyAskedQuestions) {
    expect(screen.queryByText(faq.answer)).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: faq.question }))
    expect(screen.getByText(faq.answer)).toBeTruthy()
    expect(screen.getByRole('button', { name: faq.question }).props.accessibilityState.expanded).toBe(true)
    fireEvent.press(screen.getByRole('button', { name: faq.question }))
    expect(screen.queryByText(faq.answer)).toBeNull()
  }
})
