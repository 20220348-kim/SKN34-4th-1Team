// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { pricingFrequentlyAskedQuestions, pricingPlans, pricingUnlimitedNote } from '@govbiz/shared/design/pricingContent'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { PlanTrialError } from '@govbiz/shared/domain/errors/PlanTrialError'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  // 체험 확인 문구는 지금부터 14일 뒤 서울 날짜를 적으므로 시계를 고정합니다. 타이머는 실제로 둡니다.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T21:00:00+09:00'))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const free: PlanUsage = { plan: 'FREE', planEndsAt: null, planSource: null, trialsAvailable: ['PLUS', 'PREMIUM'], items: [] }
const plusTrial: PlanUsage = {
  plan: 'PLUS', planEndsAt: '2026-10-22T21:00:00+09:00', planSource: 'TRIAL', trialsAvailable: ['PREMIUM'], items: [],
}
const card = (name: string) => screen.getByRole('heading', { name, level: 3 }).closest('article') as HTMLElement

function renderApp(path: string, signedIn = path.startsWith('/app')) {
  const store = createAppStore()
  // 작업 화면(/partners 등)은 회원 세션이 있어야 열립니다. 세션 복원 요청은 보내지 않습니다.
  store.dispatch(sessionRestored(
    signedIn ? { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null } : null,
  ))
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
    </Provider>,
  )
}

describe('공개 요금제', () => {
  it('웹은 모바일과 같은 가격·한도·FAQ를 표시하고 이용 기간은 금액 뒤에 붙인다', () => {
    renderApp('/pricing')
    for (const plan of pricingPlans) {
      const planCard = card(plan.name)
      expect(within(planCard).getByText(plan.price)).toBeTruthy()
      if (plan.pricePeriod) expect(within(planCard).getByText(plan.pricePeriod).closest('p')?.textContent).toBe(`${plan.price} ${plan.pricePeriod}`)
      expect(within(planCard).getByText(plan.priceNote, { selector: 'p' })).toBeTruthy()
      expect(within(planCard).getByRole('list', { name: `${plan.name} 한도` }).textContent).toBe(plan.limits.join(''))
    }
    // 기능은 요금제마다 같아 기능 목록과 사실과 다른 프리미엄 문구를 두지 않습니다.
    expect(screen.queryByText(/AI 초안 자동 채움|우선 처리|회원가입 없이 시작|정식 출시 전까지 회원 무료/)).toBeNull()
    expect(screen.getByText(pricingUnlimitedNote)).toBeTruthy()
    // 세는 기준 절과 한도 위 제목은 두지 않습니다. 한도 줄이 기간을 함께 적습니다.
    expect(screen.queryByText(/세나요|다시 채워져요/)).toBeNull()
    expect(within(card('플러스')).getByText('AI 대화 검색 500회')).toBeTruthy()
    // 가격 아래에는 부가세 포함만 적고 출시 예정가 안내 문장은 두지 않습니다.
    expect(screen.queryByText(/^표시한 가격은/)).toBeNull()
    expect(screen.queryByText(/출시 예정가 ·/)).toBeNull()
    // 고정 상태 배지(지금 이용 가능·출시 예정)는 두지 않고 이용 중인 요금제에만 배지를 붙입니다.
    expect(screen.queryByText(/^(출시 예정|지금 이용 가능)$/)).toBeNull()
    // 첫 문단은 무료로 시작하라는 한 문장만 둡니다.
    expect(screen.queryByText(/14일 동안 무료로 써 볼 수 있어요/)).toBeNull()
    // 로그인 전에는 추천 요금제(플러스)만 강조하고 이용 중인 카드는 없습니다.
    expect(document.querySelector('article[aria-current]')).toBeNull()
    for (const faq of pricingFrequentlyAskedQuestions) {
      expect(screen.getByText(faq.question).closest('details')?.textContent).toContain(faq.answer)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['/pricing', '/app/pricing'])('%s 제목은 전체 접근성 이름과 글자 공간을 유지하며 순서대로 등장한다', (path) => {
    renderApp(path)
    const title = '기업의 다음 단계에 맞는 요금제'
    const heading = screen.getByRole('heading', { level: 1, name: title })
    expect(heading.textContent).toBe(title)
    expect(heading.querySelector('[aria-hidden="true"]')).toBeTruthy()
    const characters = Array.from(heading.querySelectorAll<HTMLElement>('[data-pricing-title-character]'))
    expect(characters.map((node) => node.textContent).join('')).toBe(title.replaceAll(' ', ''))
    expect(characters.every((node) => node.classList.contains('motion-safe:animate-search-intro-type'))).toBe(true)
    expect(characters[0].style.animationDelay).toBe('180ms')
    expect(characters.every((node, index) => index === 0 || parseInt(node.style.animationDelay) > parseInt(characters[index - 1].style.animationDelay))).toBe(true)
    expect(screen.queryByText('GovBiz 요금제', { exact: true })).toBeNull()
  })

  it.each(['/pricing', '/pricing/'])('%s에서 세 요금제를 보여주고 결제 요청은 보내지 않는다', (path) => {
    renderApp(path)

    expect(screen.queryByText('GovBiz 요금제', { exact: true })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: '기업의 다음 단계에 맞는 요금제' })).toBeTruthy()
    for (const name of ['무료', '플러스', '프리미엄']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy()
    }
    // 로그인 전에는 플러스·프리미엄 체험이 로그인 뒤 이 요금제 화면으로 이어집니다. 결제 요청은 보내지 않습니다.
    for (const name of ['플러스', '프리미엄']) {
      expect(within(card(name)).getByRole('link', { name: '로그인하고 14일 무료 체험' }).getAttribute('href')).toBe('/login?next=%2Fapp%2Fpricing')
      expect(within(card(name)).getByText('체험이 끝나면 무료로 돌아가며 자동 결제는 없어요.')).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: '출시 준비 중' })).toBeNull()
    expect(screen.queryByText(/데모 화면/)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    const navigation = screen.getByRole('navigation', { name: '화면 이동' })
    expect(within(navigation).getByRole('link', { name: '요금제' }).getAttribute('aria-current')).toBe('page')
    expect(within(navigation).getByRole('link', { name: '지원사업 찾기' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: '무료로 지원사업 찾기' }).getAttribute('href')).toBe('/')
    expect(screen.getByRole('link', { name: '지원사업 찾기 시작하기' }).getAttribute('href')).toBe('/')
  })

  it('공개 검색 상단 메뉴에서 요금제로 이동한다', () => {
    renderApp('/')
    fireEvent.click(screen.getByRole('link', { name: '요금제' }))
    expect(screen.getByRole('heading', { level: 1, name: '기업의 다음 단계에 맞는 요금제' })).toBeTruthy()
  })

  it('작업 사이드바에서 요금제를 열면 사이드바 안에 머물고 무료 버튼은 작업 채팅으로 간다', () => {
    renderApp('/app/partners')
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    fireEvent.click(within(sidebar).getByRole('link', { name: '요금제' }))

    expect(screen.queryByText('GovBiz 요금제', { exact: true })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: '기업의 다음 단계에 맞는 요금제' })).toBeTruthy()
    for (const name of ['무료', '플러스', '프리미엄']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy()
    }
    expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
    expect(within(sidebar).getByRole('link', { name: '요금제' }).getAttribute('aria-current')).toBe('page')
    // 로그인 뒤에는 지금 요금제를 읽습니다(테스트 설정에서는 끝나지 않는 요청). 읽는 동안 체험 버튼은 누를 수 없고 결제 요청은 없습니다.
    expect(fetch).not.toHaveBeenCalled()
    for (const name of ['플러스', '프리미엄']) {
      expect((within(card(name)).getByRole('button', { name: '14일 무료 체험 시작' }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByRole('link', { name: '무료로 지원사업 찾기' }).getAttribute('href')).toBe('/app/chat')
    fireEvent.click(screen.getByRole('link', { name: '무료로 지원사업 찾기' }))
    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
  })

  it('로그인 상태로 공개 요금제 주소에 오면 사이드바 안의 요금제로 보낸다', () => {
    renderApp('/pricing', true)
    expect(screen.queryByText('GovBiz 요금제', { exact: true })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: '기업의 다음 단계에 맞는 요금제' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
    expect(screen.queryByRole('banner', { name: '앱 헤더' })).toBeNull()
  })
})

describe('출시 전 무료 체험', () => {
  it('지금 요금제는 비활성 버튼으로 두고, 체험은 카드 안에서 한 번 더 확인한 뒤 시작해 카드를 바로 바꾼다', async () => {
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue(free)
    let finish!: (usage: PlanUsage) => void
    const start = vi.spyOn(appContainer.resolve('planTrialUseCase'), 'start')
      .mockReturnValue(new Promise<PlanUsage>((resolve) => { finish = resolve }))
    renderApp('/app/pricing')

    const current = await within(card('무료')).findByRole('button', { name: '현재 요금제' })
    expect((current as HTMLButtonElement).disabled).toBe(true)
    expect(within(card('무료')).getByText('이용 중')).toBeTruthy()
    // 지금 요금제 카드만 강조하고, 추천 요금제(플러스)의 강조 테두리는 뺍니다.
    expect(card('무료').getAttribute('aria-current')).toBe('true')
    expect(card('무료').className).toContain('border-2')
    expect(card('플러스').className).not.toContain('border-brand-primary')
    const opener = await within(card('플러스')).findByRole('button', { name: '14일 무료 체험 시작' })
    fireEvent.click(opener)
    // 바로 시작하지 않고 확인 다이얼로그를 엽니다. 끝나는 날과 자동 결제가 없다는 것을 보여 줍니다.
    const confirm = screen.getByRole('dialog', { name: '플러스 14일 무료 체험을 시작할까요?' })
    expect(confirm.getAttribute('aria-modal')).toBe('true')
    expect(confirm.textContent).toContain('10월 22일까지 플러스 한도로 쓰고, 끝나면 무료로 돌아가요.')
    expect(confirm.textContent).toContain('결제 수단을 받지 않아 자동 결제는 없어요.')
    expect(confirm.textContent).toContain('요금제마다 한 번만 체험할 수 있어요.')
    expect(start).not.toHaveBeenCalled()

    fireEvent.click(within(confirm).getByRole('button', { name: '체험 시작' }))
    expect(start).toHaveBeenCalledWith('PLUS')
    expect((within(confirm).getByRole('button', { name: '체험을 시작하는 중' }) as HTMLButtonElement).disabled).toBe(true)
    // 시작하는 동안에는 Esc로 닫히지 않습니다.
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => finish(plusTrial))
    expect(screen.queryByRole('dialog')).toBeNull()

    expect(screen.getByRole('status').textContent)
      .toBe('플러스 체험을 시작했어요. 10월 22일 21:00까지 체험할 수 있어요. 끝나면 자동 결제 없이 무료로 돌아가요.')
    expect((within(card('플러스')).getByRole('button', { name: '현재 요금제' }) as HTMLButtonElement).disabled).toBe(true)
    expect(card('플러스').getAttribute('aria-current')).toBe('true')
    expect(card('무료').getAttribute('aria-current')).toBeNull()
    expect(within(card('플러스')).getByText('10월 22일 21:00까지 체험할 수 있어요. 끝나면 자동 결제 없이 무료로 돌아가요.')).toBeTruthy()
    expect((within(card('무료')).getByRole('button', { name: '현재 요금제에 포함' }) as HTMLButtonElement).disabled).toBe(true)
    // 플러스 체험 중 프리미엄 체험은 바로 바꾼다는 것을 확인 단계에서 알립니다.
    fireEvent.click(within(card('프리미엄')).getByRole('button', { name: '14일 무료 체험 시작' }))
    expect(screen.getByRole('dialog', { name: '프리미엄 14일 무료 체험을 시작할까요?' }).textContent)
      .toContain('지금 쓰는 플러스 체험은 바로 끝나고 프리미엄 이용 기간이 새로 시작돼요.')
  })

  it('이미 체험한 요금제는 체험 완료로 두고, 거절되면 확인 단계에 이유를 보여 주며 취소하면 닫는다', async () => {
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValue({ ...free, trialsAvailable: ['PREMIUM'] })
    vi.spyOn(appContainer.resolve('planTrialUseCase'), 'start').mockRejectedValue(new PlanTrialError(409, 'PLAN_TRIAL_UNAVAILABLE'))
    renderApp('/app/pricing')

    const used = await within(card('플러스')).findByRole('button', { name: '체험 완료' })
    expect((used as HTMLButtonElement).disabled).toBe(true)
    const opener = within(card('프리미엄')).getByRole('button', { name: '14일 무료 체험 시작' })
    // 실제 클릭처럼 버튼에 초점을 둔 뒤 누릅니다(jsdom의 click은 초점을 옮기지 않습니다).
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '프리미엄 14일 무료 체험을 시작할까요?' })
    fireEvent.click(within(dialog).getByRole('button', { name: '체험 시작' }))
    expect((await within(dialog).findByRole('alert')).textContent)
      .toBe('지금 요금제에서는 이 체험을 시작할 수 없어요. 요금제 화면을 다시 불러와 주세요.')
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // 닫으면 연 버튼으로 초점이 돌아갑니다.
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})
