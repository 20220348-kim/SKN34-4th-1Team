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

// 하루 한도 안내는 다시 채워질 때까지 남은 시간을 적으므로 시계를 서울 저녁 9시(자정 3시간 전)로 고정합니다. 타이머는 실제로 둡니다.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T21:00:00+09:00')) })
afterEach(() => { vi.useRealTimers() })

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
  it('오늘 · 이번 달로 묶어 남은 양과 쓴 양 · 진행 막대를 보이고, 다시 채워지는 때는 묶음마다 한 번만 적는다', async () => {
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue(usage)
    renderPage()
    const section = await screen.findByRole('region', { name: '요금제와 이용량' })
    expect(await within(section).findByText('무료')).toBeTruthy()

    const today = within(section).getByRole('region', { name: '오늘 이용량' })
    const month = within(section).getByRole('region', { name: '이번 달 이용량' })
    expect(within(today).getAllByText('약 3시간 뒤에 다시 채워져요.')).toHaveLength(1)
    expect(within(month).getAllByText('11월 1일에 다시 채워져요.')).toHaveLength(1)
    const rows = (group: HTMLElement, name: string) => within(within(group).getByRole('list', { name })).getAllByRole('listitem')
    const todayRows = rows(today, '오늘 기능별 이용량')
    expect(todayRows.map((row) => row.textContent)).toEqual([
      'AI 대화 검색오늘 7회 남음10회 중 3회 썼어요',
      // 진행 중인 요청 때문에 한도를 넘겨 세어진 사용량도 화면은 한도에서 멈춥니다.
      '공고 원문 질문오늘 0회 남음10회 중 10회 썼어요',
    ])
    expect(rows(month, '이번 달 기능별 이용량').map((row) => row.textContent)).toEqual([
      '신청 문서 초안이번 달 2건 남음3건 중 1건 썼어요',
      '중복 지원·수혜 검토이번 달 3회 남음3회 중 0회 썼어요',
    ])
    const meters = within(section).getAllByRole('progressbar')
    expect(meters.map((meter) => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow'), meter.getAttribute('aria-valuemin'),
      meter.getAttribute('aria-valuemax'), meter.getAttribute('aria-valuetext')])).toEqual([
      ['AI 대화 검색 이용량', '3', '0', '10', '10회 중 3회 썼어요'],
      ['공고 원문 질문 이용량', '10', '0', '10', '10회 중 10회 썼어요'],
      ['신청 문서 초안 이용량', '1', '0', '3', '3건 중 1건 썼어요'],
      ['중복 지원·수혜 검토 이용량', '0', '0', '3', '3회 중 0회 썼어요'],
    ])
    expect((meters[0]!.firstElementChild as HTMLElement).style.width).toBe('30%')
    expect((meters[1]!.firstElementChild as HTMLElement).style.width).toBe('100%')
    // 남은 양이 한도의 20% 이하(최소 1회)면 남은 양 글자와 막대를 경고 색으로 바꿉니다.
    expect(within(todayRows[1]!).getByText('오늘 0회 남음').className).toContain('text-warning')
    expect(within(todayRows[0]!).getByText('오늘 7회 남음').className).not.toContain('text-warning')
    expect((meters[1]!.firstElementChild as HTMLElement).className).toContain('bg-warning')

    // 요금제는 요금제 화면에서 바꿉니다. 무엇을 한 번으로 세는지도 그 화면의 한도 아래에 둡니다.
    expect(within(section).getByText('결제는 아직 받지 않아요.')).toBeTruthy()
    expect(within(section).getByRole('link', { name: '요금제 바꾸기' }).getAttribute('href')).toBe('/app/pricing')
    expect(within(section).queryByRole('button')).toBeNull()
    expect(within(section).queryByText(/조건을 정리하는 대화와 필터 검색은 세지 않고/)).toBeNull()
  })

  it('출시 전 무료 체험 중이면 체험 요금제와 끝나는 때, 끝나면 무료로 돌아간다는 것을 적는다', async () => {
    const endsAt = '2026-10-22T21:00:00+09:00'
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue({
      plan: 'PLUS', planEndsAt: endsAt, planSource: 'TRIAL', trialsAvailable: ['PREMIUM'],
      items: [{ feature: 'AI_SEARCH', period: 'PLAN', limit: 500, used: 2, resetsAt: endsAt }],
    })
    renderPage()
    const section = await screen.findByRole('region', { name: '요금제와 이용량' })
    expect(await within(section).findByText('플러스 체험')).toBeTruthy()
    expect(within(section).getByText('10월 22일 21:00까지 체험할 수 있어요. 끝나면 자동 결제 없이 무료로 돌아가요.')).toBeTruthy()
    expect(within(section).getByRole('link', { name: '요금제 바꾸기' })).toBeTruthy()
  })

  it('30일 이용권은 네 기능을 이번 기간으로 묶어 남은 양과 기간이 끝나는 때, 이용권이 끝나는 때를 적는다', async () => {
    const endsAt = '2026-10-31T15:30:00+09:00'
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue({
      plan: 'PLUS',
      planEndsAt: endsAt,
      items: [
        { feature: 'AI_SEARCH', period: 'PLAN', limit: 500, used: 20, resetsAt: endsAt },
        { feature: 'EVIDENCE_QUESTION', period: 'PLAN', limit: 500, used: 0, resetsAt: endsAt },
        { feature: 'APPLICATION_DRAFT', period: 'PLAN', limit: 5, used: 4, resetsAt: endsAt },
        { feature: 'COMBINATION_REVIEW', period: 'PLAN', limit: 10, used: 0, resetsAt: endsAt },
      ],
    })
    renderPage()
    const section = await screen.findByRole('region', { name: '요금제와 이용량' })
    expect(await within(section).findByText('플러스')).toBeTruthy()
    expect(within(section).getByText('10월 31일 15:30까지 이용할 수 있어요.')).toBeTruthy()
    expect(within(section).queryByRole('region', { name: '오늘 이용량' })).toBeNull()
    const period = within(section).getByRole('region', { name: '이번 기간 이용량' })
    expect(within(period).getAllByText('10월 31일 15:30에 이번 기간이 끝나요.')).toHaveLength(1)
    const rows = within(within(period).getByRole('list', { name: '이번 기간 기능별 이용량' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'AI 대화 검색이번 기간 480회 남음500회 중 20회 썼어요',
      '공고 원문 질문이번 기간 500회 남음500회 중 0회 썼어요',
      // 5건 중 1건 남으면 미리 알립니다.
      '신청 문서 초안이번 기간 1건 남음5건 중 4건 썼어요',
      '중복 지원·수혜 검토이번 기간 10회 남음10회 중 0회 썼어요',
    ])
    expect(within(rows[2]!).getByText('이번 기간 1건 남음').className).toContain('text-warning')
  })

  it('한도가 없다고 받은 기능은 막대와 쓴 양 문장 없이 제한 없음으로 적는다', async () => {
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
    const rows = (name: string) => within(within(section).getByRole('list', { name })).getAllByRole('listitem').map((row) => row.textContent)
    expect(rows('오늘 기능별 이용량')).toEqual(['AI 대화 검색오늘 42회 · 제한 없음', '공고 원문 질문오늘 0회 · 제한 없음'])
    expect(rows('이번 달 기능별 이용량')).toEqual(['신청 문서 초안이번 달 2건 · 제한 없음'])
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
