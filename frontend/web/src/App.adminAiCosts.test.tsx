// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import type { AdminAiCostSummary, AdminAiModelPrice } from './domain/entities/AdminAiCost'
import { adminAiCostMessages } from './presentation/features/admin/viewmodel/useAdminAiCostViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const adminAccount: Account = { email: 'admin@govbiz.local', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, company: null, accountType: null, onboarded: true }
const totals = { calls: 12, inputTokens: 50_000, cachedInputTokens: 30_000, outputTokens: 4_000, estimatedUsd: '0.012346', unpricedCalls: 0 }

function summaryOf(overrides: Partial<AdminAiCostSummary> = {}): AdminAiCostSummary {
  return {
    from: '2026-10-01',
    to: '2026-10-10',
    totals,
    actualUsd: null,
    actualConfigured: false,
    actualFetchedAt: null,
    krwPerUsd: null,
    byFeature: [{ key: 'AI_SEARCH', totals }, { key: null, totals: { ...totals, calls: 3, estimatedUsd: '0.000060' } }],
    byModel: [{ key: 'gpt-5.6-sol-2026-07-30', serviceTier: 'priority', totals }],
    days: [
      { date: '2026-10-09', estimatedUsd: '0.000000', calls: 0, actualUsd: null },
      { date: '2026-10-07', estimatedUsd: '0.000001', calls: 1, actualUsd: null },
      { date: '2026-10-10', estimatedUsd: '0.012346', calls: 12, actualUsd: null },
      { date: '2026-10-08', estimatedUsd: '0.000000', calls: 0, actualUsd: '0.000002' },
    ],
    topAccounts: [{ accountId: 11, email: 'member@company.co.kr', planCode: 'PLUS', totals }],
    ...overrides,
  }
}

const price: AdminAiModelPrice = {
  id: 1, modelPrefix: 'gpt-5.6-luna', serviceTier: 'default', inputUsdPerMillion: '0.2', cachedInputUsdPerMillion: '0.02',
  outputUsdPerMillion: '1.2', effectiveFrom: '2026-10-01', note: '공식 가격',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T03:00:00Z'))
  vi.spyOn(appContainer.resolve('getAdminAiModelPricesUseCase'), 'execute').mockResolvedValue([price])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderApp() {
  const store = createAppStore()
  store.dispatch(sessionRestored(adminAccount))
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/app/admin/ai-costs']}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('관리자 AI 비용', () => {
  it('이번 달 추정 비용을 기능·모델·날짜·회원별로 보이고, 관리자 키가 없으면 실제 비용 대신 까닭을 보인다', async () => {
    const getSummary = vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf())
    renderApp()

    const stats = await screen.findByRole('region', { name: '비용 요약' })
    expect(getSummary).toHaveBeenCalledWith('2026-10-01', '2026-10-10', expect.any(AbortSignal))
    expect(within(stats).getByText('$0.012346')).toBeTruthy()
    expect(within(stats).getByText(adminAiCostMessages.actualMissingKey)).toBeTruthy()
    expect((screen.getByRole('button', { name: '실제 비용 가져오기' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(screen.getByRole('region', { name: '기능별' })).getByText('AI 대화 검색')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '기능별' })).getByText('시스템·기타(색인·조건 정리·공고 분석)')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '모델별' })).getByText('Fast(priority)')).toBeTruthy()
    // 호출도 실제 비용도 없는 날은 빼고, API 순서와 관계없이 최신 날짜부터 표시합니다.
    const days = within(screen.getByRole('region', { name: '날짜별' }))
    expect(days.queryByText('2026-10-09')).toBeNull()
    expect(days.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent))
      .toEqual(['2026-10-10', '2026-10-08', '2026-10-07'])
    const member = within(screen.getByRole('region', { name: '많이 쓴 회원' })).getByRole('link', { name: 'member@company.co.kr' })
    expect(member.getAttribute('href')).toBe('/app/admin/accounts/detail?accountId=11')
    expect(within(screen.getByRole('region', { name: '가격표' })).getByText('gpt-5.6-luna')).toBeTruthy()
    // 사이드바 메뉴는 잠시 숨겨 주소로만 엽니다.
    expect(screen.queryByRole('link', { name: 'AI 비용' })).toBeNull()
  })

  it('관리자 키가 있으면 실제 비용을 가져와 다시 읽고, 원화 환율이 있으면 함께 보인다', async () => {
    const getSummary = vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute')
      .mockResolvedValueOnce(summaryOf({ actualConfigured: true }))
      .mockResolvedValueOnce(summaryOf({ actualConfigured: true, actualUsd: '0.020000', actualFetchedAt: '2026-10-10T12:00:00', krwPerUsd: '1400' }))
    const sync = vi.spyOn(appContainer.resolve('syncAdminAiCostsUseCase'), 'execute').mockResolvedValue({ outcome: 'done', lines: 4, amountUsd: '0.020000' })
    renderApp()

    const stats = await screen.findByRole('region', { name: '비용 요약' })
    expect(within(stats).getByText(adminAiCostMessages.actualNeverFetched)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '실제 비용 가져오기' }))

    await waitFor(() => expect(sync).toHaveBeenCalled())
    expect(await screen.findByText(adminAiCostMessages.sync.done(4, '0.020000'))).toBeTruthy()
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(2))
    const updated = await screen.findByText('$0.020000 (약 28원)')
    expect(updated).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '비용 요약' })).getByText('+$0.007654')).toBeTruthy()
  })

  it('거꾸로 된 기간은 보내지 않고, 가격은 새 행으로 더한다', async () => {
    const getSummary = vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf())
    const addPrice = vi.spyOn(appContainer.resolve('addAdminAiModelPriceUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'conflict' })
      .mockResolvedValueOnce({ outcome: 'done', price: { ...price, id: 2, modelPrefix: 'gpt-6-luna', effectiveFrom: '2026-11-01', note: null } })
    renderApp()
    await screen.findByRole('region', { name: '비용 요약' })

    fireEvent.change(screen.getByLabelText('시작일', { selector: 'input[name="from"]' }), { target: { value: '2026-10-20' } })
    fireEvent.click(screen.getByRole('button', { name: '조회' }))
    expect(screen.getByText(adminAiCostMessages.period['reversed-period'])).toBeTruthy()
    expect(getSummary).toHaveBeenCalledTimes(1)

    const form = screen.getByRole('form', { name: '가격 추가' })
    fireEvent.change(within(form).getByLabelText('모델'), { target: { value: 'gpt-6-luna' } })
    fireEvent.change(within(form).getByLabelText('입력'), { target: { value: '0.1' } })
    fireEvent.change(within(form).getByLabelText('출력'), { target: { value: '0.5' } })
    fireEvent.change(within(form).getByLabelText('시작일'), { target: { value: '2026-11-01' } })
    fireEvent.click(within(form).getByRole('button', { name: '가격 추가' }))
    expect(await screen.findByText(adminAiCostMessages.price.conflict)).toBeTruthy()

    fireEvent.click(within(form).getByRole('button', { name: '가격 추가' }))
    expect(await screen.findByText(adminAiCostMessages.price.added)).toBeTruthy()
    expect(addPrice).toHaveBeenLastCalledWith({
      modelPrefix: 'gpt-6-luna', serviceTier: 'default', inputUsdPerMillion: '0.1', cachedInputUsdPerMillion: null,
      outputUsdPerMillion: '0.5', effectiveFrom: '2026-11-01', note: '',
    })
    expect(within(screen.getByRole('region', { name: '가격표' })).getByText('gpt-6-luna')).toBeTruthy()
  })
})
