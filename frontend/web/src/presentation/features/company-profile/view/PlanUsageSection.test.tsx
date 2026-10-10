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
const resetsAt = '2026-10-09T00:00:00+09:00'
const usage: PlanUsage = {
  plan: 'FREE',
  items: [
    { feature: 'AI_SEARCH', period: 'DAY', limit: 10, used: 3, resetsAt },
    // 진행 중인 요청 때문에 한도를 넘겨 세어진 사용량입니다. 화면은 한도에서 멈춥니다.
    { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, used: 11, resetsAt },
    { feature: 'APPLICATION_DRAFT', period: 'MONTH', limit: 3, used: 1, resetsAt: '2026-11-01T00:00:00+09:00' },
    { feature: 'COMBINATION_REVIEW', period: 'MONTH', limit: 3, used: 0, resetsAt: '2026-11-01T00:00:00+09:00' },
  ],
}

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

describe('프로필 요금제와 이용량', () => {
  it('지금 요금제와 기능별 사용량 · 진행 막대 · 다시 채워지는 때를 보여 주고 결제 없이 요금제 화면으로 잇지 않는다', async () => {
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue(usage)
    renderPage()
    const section = await screen.findByRole('region', { name: '요금제와 이용량' })
    expect(await within(section).findByText('무료')).toBeTruthy()

    const rows = within(within(section).getByRole('list', { name: '기능별 이용량' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'AI 대화 검색오늘 3/10회자정(서울 시간)에 다시 채워져요.',
      '공고 원문 질문오늘 10/10회자정(서울 시간)에 다시 채워져요.',
      '신청 문서 초안이번 달 1/3건11월 1일에 다시 채워져요.',
      '중복 지원·수혜 검토이번 달 0/3회11월 1일에 다시 채워져요.',
    ])
    const meters = within(section).getAllByRole('progressbar')
    expect(meters.map((meter) => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow'), meter.getAttribute('aria-valuemin'),
      meter.getAttribute('aria-valuemax'), meter.getAttribute('aria-valuetext')])).toEqual([
      ['AI 대화 검색 이용량', '3', '0', '10', '오늘 3/10회'],
      ['공고 원문 질문 이용량', '10', '0', '10', '오늘 10/10회'],
      ['신청 문서 초안 이용량', '1', '0', '3', '이번 달 1/3건'],
      ['중복 지원·수혜 검토 이용량', '0', '0', '3', '이번 달 0/3회'],
    ])
    expect((meters[0]!.firstElementChild as HTMLElement).style.width).toBe('30%')
    expect((meters[1]!.firstElementChild as HTMLElement).style.width).toBe('100%')
    // 80%부터는 사용량 글자와 막대를 경고 색으로 바꿉니다.
    expect(within(rows[1]!).getByText('오늘 10/10회').className).toContain('text-warning')
    expect(within(rows[0]!).getByText('오늘 3/10회').className).not.toContain('text-warning')
    expect((meters[1]!.firstElementChild as HTMLElement).className).toContain('bg-warning')

    // 요금제 화면에는 아직 한도가 없으므로 그 화면으로 잇지 않습니다.
    expect(within(section).getByText('결제는 아직 받지 않아요.')).toBeTruthy()
    expect(within(section).queryByRole('link')).toBeNull()
    expect(within(section).queryByRole('button')).toBeNull()
  })

  it('아직 한도를 정하지 않은 요금제는 막대 없이 제한 없음으로 적는다', async () => {
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue({
      plan: 'PREMIUM',
      items: [
        { feature: 'AI_SEARCH', period: 'DAY', limit: null, used: 42, resetsAt },
        { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: null, used: 0, resetsAt },
        { feature: 'APPLICATION_DRAFT', period: 'MONTH', limit: null, used: 2, resetsAt: '2026-11-01T00:00:00+09:00' },
      ],
    })
    renderPage()
    const section = await screen.findByRole('region', { name: '요금제와 이용량' })
    expect(await within(section).findByText('프리미엄')).toBeTruthy()
    const rows = within(within(section).getByRole('list', { name: '기능별 이용량' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'AI 대화 검색오늘 42회 · 제한 없음자정(서울 시간)에 다시 채워져요.',
      '공고 원문 질문오늘 0회 · 제한 없음자정(서울 시간)에 다시 채워져요.',
      '신청 문서 초안이번 달 2건 · 제한 없음11월 1일에 다시 채워져요.',
    ])
    expect(within(section).queryByRole('progressbar')).toBeNull()
  })

  it('읽는 동안과 읽지 못했을 때를 숨기지 않고 알리며 다시 시도로 다시 읽는다', async () => {
    let finish!: (value: PlanUsage) => void
    const read = vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage')
      .mockRejectedValueOnce(new Error('usage unavailable'))
      .mockReturnValueOnce(new Promise<PlanUsage>((resolve) => { finish = resolve }))
    renderPage()
    const section = screen.getByRole('region', { name: '요금제와 이용량' })
    expect(within(section).getByText('이용량을 불러오는 중이에요.')).toBeTruthy()
    expect((await within(section).findByRole('alert')).textContent).toBe('이용량을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')
    expect(within(section).queryByRole('progressbar')).toBeNull()

    fireEvent.click(within(section).getByRole('button', { name: '다시 시도' }))
    expect(within(section).getByText('이용량을 불러오는 중이에요.')).toBeTruthy()
    await act(async () => finish(usage))
    expect(within(section).getAllByRole('progressbar')).toHaveLength(4)
    expect(within(section).queryByRole('alert')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
