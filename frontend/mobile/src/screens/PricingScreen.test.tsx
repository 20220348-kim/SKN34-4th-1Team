import { fireEvent, render, screen } from '@testing-library/react-native'
import { pricingFrequentlyAskedQuestions, pricingPlans } from '@govbiz/shared/design/pricingContent'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { colors } from '../ui'
import { StyleSheet, View } from 'react-native'
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
  render(<PricingScreen onSearch={jest.fn()} signedIn usage={{ plan: 'PREMIUM', items: [] }} />)
  // 플러스는 추천 요금제지만 지금 요금제가 있으면 그 요금제만 강조합니다. 고정 상태 배지는 두지 않습니다.
  expect(screen.queryByText(/출시 예정|지금 이용 가능/)).toBeNull()
  expect(screen.getByRole('tab', { name: '프리미엄' }).props.accessibilityState.selected).toBe(true)
  expect(screen.getByText('이용 중')).toBeTruthy()
  fireEvent.press(screen.getByRole('button', { name: '다른 요금제 한눈에 보기' }))
  expect(screen.getByText('프리미엄 · 29,000원 / 30일 · 이용 중')).toBeTruthy()
  expect(screen.getByText('플러스 · 9,900원 / 30일')).toBeTruthy()
})

const trial: PlanUsage = { plan: 'PLUS', planSource: 'TRIAL', planEndsAt: '2026-10-22T21:00:00+09:00', items: [
  { feature: 'AI_SEARCH', period: 'PLAN', limit: 500, used: 2, resetsAt: '2026-10-22T21:00:00+09:00' },
] }

test('the current trial shows its end date and marks the thirty-day price as a reference', () => {
  render(<PricingScreen onSearch={jest.fn()} signedIn usage={trial} />)
  expect(screen.getByText('체험 중')).toBeTruthy()
  expect(screen.getByText('30일 이용권 기준 가격 · 부가세 포함')).toBeTruthy()
  expect(screen.getByText('10월 22일 21:00까지 체험할 수 있어요. 끝나면 자동 결제 없이 무료로 돌아가요.')).toBeTruthy()
  expect(screen.queryByText('30일 동안 쓰는 이용권이에요. 자동으로 갱신되지 않아요.')).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '다른 요금제 한눈에 보기' }))
  expect(screen.getByText('플러스 · 9,900원 / 30일 · 체험 중')).toBeTruthy()
})

test('a paid pass keeps the server end date while an open-ended assignment only shows its usage period', () => {
  const view = render(<PricingScreen onSearch={jest.fn()} signedIn usage={{ ...trial, planSource: 'OPERATOR' }} />)
  expect(screen.getByText('이용 중')).toBeTruthy()
  expect(screen.getByText('10월 22일 21:00까지 이용할 수 있어요.')).toBeTruthy()
  view.rerender(<PricingScreen onSearch={jest.fn()} signedIn usage={{ ...trial, planSource: 'OPERATOR', planEndsAt: null }} />)
  expect(screen.queryByText('10월 22일 21:00까지 이용할 수 있어요.')).toBeNull()
  expect(screen.getByText('이용량: 10월 22일 21:00에 이번 기간이 끝나요.')).toBeTruthy()
  expect(screen.queryByText(/무료로 돌아가요/)).toBeNull()
})

test('the first response selects the member plan unless they already chose another tab', () => {
  const view = render(<PricingScreen onSearch={jest.fn()} signedIn loading />)
  view.rerender(<PricingScreen onSearch={jest.fn()} signedIn usage={{ plan: 'FREE', items: [] }} />)
  expect(screen.getByRole('tab', { name: '무료' }).props.accessibilityState.selected).toBe(true)
  fireEvent.press(screen.getByRole('tab', { name: '프리미엄' }))
  view.rerender(<PricingScreen onSearch={jest.fn()} signedIn usage={trial} />)
  expect(screen.getByRole('tab', { name: '프리미엄' }).props.accessibilityState.selected).toBe(true)
  view.unmount()
  const other = render(<PricingScreen onSearch={jest.fn()} signedIn loading />)
  fireEvent.press(screen.getByRole('tab', { name: '무료' }))
  other.rerender(<PricingScreen onSearch={jest.fn()} signedIn usage={trial} />)
  expect(screen.getByRole('tab', { name: '무료' }).props.accessibilityState.selected).toBe(true)
})

test('a new account resets the initial tab while a token refresh and expiry preserve a manual selection', () => {
  const view = render(<View><PricingScreen key="first" onSearch={jest.fn()} signedIn usage={trial} /></View>)
  fireEvent.press(screen.getByRole('tab', { name: '프리미엄' }))
  view.rerender(<View><PricingScreen key="first" onSearch={jest.fn()} signedIn usage={{ ...trial }} loading /></View>)
  expect(screen.getByRole('tab', { name: '프리미엄' }).props.accessibilityState.selected).toBe(true)
  view.rerender(<View><PricingScreen key="first" onSearch={jest.fn()} signedIn usage={{ plan: 'FREE', items: [] }} /></View>)
  expect(screen.getByRole('tab', { name: '프리미엄' }).props.accessibilityState.selected).toBe(true)
  view.rerender(<View><PricingScreen key="second" onSearch={jest.fn()} signedIn usage={{ plan: 'FREE', items: [] }} /></View>)
  expect(screen.getByRole('tab', { name: '무료' }).props.accessibilityState.selected).toBe(true)
})

test('a failed member lookup removes the status, keeps plan information and offers retry without a recommendation', () => {
  const retry = jest.fn()
  const view = render(<PricingScreen onSearch={jest.fn()} signedIn usage={trial} />)
  view.rerender(<PricingScreen onSearch={jest.fn()} signedIn loading />)
  expect(screen.getByText('현재 요금제를 확인하고 있어요.')).toBeTruthy()
  expect(screen.queryByText('체험 중')).toBeNull()
  // 플러스 추천 테두리도 회원 상태를 확인할 수 없을 때는 두지 않습니다.
  const card = screen.UNSAFE_getAllByType(View).find(item => item.props.accessibilityLiveRegion === 'polite')!
  expect(StyleSheet.flatten(card.props.style).borderColor).toBe(colors.border)
  view.rerender(<PricingScreen onSearch={jest.fn()} signedIn failed onRetry={retry} />)
  expect(screen.getByText('현재 요금제를 불러오지 못했어요.')).toBeTruthy()
  expect(screen.getByText('AI 대화 검색 500회')).toBeTruthy()
  expect(screen.queryByText('이용 중')).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '다시 불러오기' }))
  expect(retry).toHaveBeenCalledTimes(1)
})

test('refreshing identifies the previous information and the account action only opens usage', () => {
  const onAccount = jest.fn()
  render(<PricingScreen onSearch={jest.fn()} signedIn usage={trial} loading onAccount={onAccount} />)
  expect(screen.getByText('이용 상태를 다시 확인하고 있어요. 아래는 이전에 확인한 정보예요.')).toBeTruthy()
  fireEvent.press(screen.getByRole('button', { name: '내 계정에서 이용량 보기' }))
  expect(onAccount).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: /체험 시작|요금제 바꾸기|결제|구독/ })).toBeNull()
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
