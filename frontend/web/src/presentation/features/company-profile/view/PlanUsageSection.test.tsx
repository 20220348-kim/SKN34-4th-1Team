// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import type { Account } from '../../../../domain/entities/Account'
import { sessionRestored } from '../../../shared/auth/state/authSlice'
import { CompanyProfilePage } from './CompanyProfilePage'

const account: Account = {
  email: 'member@example.test', role: 'USER', tier: 'MEMBER', emailVerified: true, company: null,
  hasPassword: true, accountType: null, onboarded: true,
}
const usage: PlanUsage = { plan: 'FREE' }

beforeEach(() => {
  vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
  vi.spyOn(appContainer.resolve('notificationSettingsUseCase'), 'settings').mockReturnValue(new Promise(() => {}))
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function renderPage() {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  render(<Provider store={store}><MemoryRouter initialEntries={['/app/profile']}><CompanyProfilePage /></MemoryRouter></Provider>)
}

describe('프로필 요금제', () => {
  it('지금 요금제를 보여 주고 결제 없이 요금제 안내로만 잇는다', async () => {
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue(usage)
    renderPage()
    const section = await screen.findByRole('region', { name: '요금제' })
    expect(await within(section).findByText('무료')).toBeTruthy()

    expect(within(section).getByText(/결제는 아직 받지 않아요./)).toBeTruthy()
    expect(within(section).getByRole('link', { name: '요금제 보기' }).getAttribute('href')).toBe('/app/pricing')
    expect(within(section).queryByRole('button')).toBeNull()
  })

  it('읽는 동안과 읽지 못했을 때를 숨기지 않고 알리며 다시 시도로 다시 읽는다', async () => {
    let finish!: (value: PlanUsage) => void
    const read = vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage')
      .mockRejectedValueOnce(new Error('plan unavailable'))
      .mockReturnValueOnce(new Promise<PlanUsage>((resolve) => { finish = resolve }))
    renderPage()
    const section = screen.getByRole('region', { name: '요금제' })
    expect(within(section).getByText('요금제를 불러오는 중이에요.')).toBeTruthy()
    expect((await within(section).findByRole('alert')).textContent).toBe('요금제를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')
    expect(within(section).queryByText('무료')).toBeNull()

    fireEvent.click(within(section).getByRole('button', { name: '다시 시도' }))
    expect(within(section).getByText('요금제를 불러오는 중이에요.')).toBeTruthy()
    await act(async () => finish({ plan: 'PREMIUM' }))
    expect(within(section).getByText('프리미엄')).toBeTruthy()
    expect(within(section).queryByRole('alert')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
