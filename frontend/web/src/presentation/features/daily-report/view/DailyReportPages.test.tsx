// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { Link } from 'react-router'
import { StrictMode } from 'react'
import App from '../../../../App'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import type { DailyReport } from '../../../../domain/entities/DailyReport'
import { DailyReportError } from '../../../../domain/errors/DailyReportError'
import { sessionRestored } from '../../../shared/auth/state/authSlice'
import { DailyReportPage } from './DailyReportPage'
import { DailyReportEmailPage } from './DailyReportEmailPage'
import { readyReport, reportAccount, reportCompany, reportSettings } from '../testing/dailyReportFixtures'
import { reportToday } from '../viewmodel/dailyReportPeriod'
import { dailyReportPollMs } from '../viewmodel/useDailyReportViewModel'

const useCase = appContainer.resolve('dailyReportUseCase')

beforeEach(() => {
  vi.spyOn(useCase, 'settings').mockResolvedValue(reportSettings)
  vi.spyOn(useCase, 'latest').mockResolvedValue(null)
  vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(reportCompany)
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function renderPage(entry = '/app/reports') {
  const store = createAppStore()
  store.dispatch(sessionRestored(reportAccount))
  render(<Provider store={store}><MemoryRouter initialEntries={[entry]}><DailyReportPage /></MemoryRouter></Provider>)
  return store
}

/** 접힌 수신 설정을 펼칩니다. */
async function openSettings() {
  fireEvent.click(await screen.findByRole('button', { name: /^수신 설정/ }))
}

/** 수신 설정을 펼치고 [수정]을 눌러 수정 폼을 엽니다. */
async function editSettings() {
  await openSettings()
  fireEvent.click(screen.getByRole('button', { name: '수정' }))
  return screen.getByRole('form', { name: '수신 설정 수정' })
}

/** 픽스처 리포트의 날짜(2026-09-09)를 서울 기준 오늘로 둡니다. 타이머는 그대로 두고 날짜만 고정합니다. */
function setTodayToReportDate() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-09T03:00:00Z'))
}

describe('기업 맞춤 리포트 화면', () => {
  it('작업 사이드바의 리포트 메뉴가 보호된 리포트 화면으로 연결된다', async () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(reportAccount))
    render(<Provider store={store}><MemoryRouter initialEntries={['/app/reports']}><App /></MemoryRouter></Provider>)
    expect((await screen.findByRole('heading', { name: '기업 맞춤 리포트' }))).toBeTruthy()
    expect(screen.getByRole('link', { name: '기업 맞춤 리포트' }).getAttribute('href')).toBe('/app/reports')
  })

  it('조회만으로 유료 생성이나 이메일을 요청하지 않고, 수신 설정은 접어 둔 채 리포트 자리를 먼저 보여 준다', async () => {
    const preview = vi.spyOn(useCase, 'preview')
    const verify = vi.spyOn(useCase, 'verifyEmail')
    renderPage()
    expect(await screen.findByRole('heading', { name: '오늘의 리포트가 아직 없어요' })).toBeTruthy()
    expect(screen.getByText('리포트 기업 · 서울특별시 · 정보통신업 기준')).toBeTruthy()
    expect(screen.getByRole('link', { name: '기업 정보 수정' }).getAttribute('href')).toBe('/app/profile')
    const toggle = screen.getByRole('button', { name: /^수신 설정/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('정기 이메일 꺼짐 · 매일 오전 8시 이후 · report@example.test 확인 필요')
    expect(screen.queryByRole('region', { name: '받는 방법' })).toBeNull()
    expect(preview).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('수신 설정을 펼치면 받는 방법과 추천 기준을 보기로 보여 주고, 수정을 눌러야 고칠 수 있다', async () => {
    renderPage()
    await openSettings()
    const channels = within(screen.getByRole('region', { name: '받는 방법' }))
    expect(channels.getByText('이메일')).toBeTruthy()
    expect(channels.getByText('꺼짐')).toBeTruthy()
    expect(channels.getByText('report@example.test')).toBeTruthy()
    expect(channels.getByRole('button', { name: '확인 메일 보내기' })).toBeTruthy()
    expect(channels.getByText('앱 푸시')).toBeTruthy()
    // 앱 푸시는 모바일 앱이 보내므로 준비 중이 아니라 켜는 곳을 안내합니다.
    expect(channels.getByText('모바일 앱의 전체 › 리포트 수신 설정에서 기기마다 켜요.')).toBeTruthy()
    expect(channels.queryByText('준비 중')).toBeNull()
    expect(within(screen.getByRole('region', { name: '추천 기준' })).getByText('AI 제품 개발')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '수정' }))
    expect(screen.getByRole('form', { name: '수신 설정 수정' })).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect((screen.getByRole('switch', { name: '정기 이메일 받기' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('수신 주소를 확인하면 켤 수 있어요.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '수정' })).toBeNull()
  })

  it('주소에 settings=open이 있으면 수신 설정을 펼쳐 바로 고칠 수 있게 연다', async () => {
    renderPage('/app/reports?settings=open')
    expect(await screen.findByRole('form', { name: '수신 설정 수정' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^수신 설정/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('메일 설정이 꺼져 있어도 웹에서 리포트를 만들 수 있고 발송 준비 상태를 알린다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, emailDeliveryAvailable: false })
    renderPage()
    await openSettings()
    expect(screen.getByText(/현재 서버의 이메일 발송이 꺼져/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^수신 설정/ }).textContent).toContain('이메일 발송 준비 안 됨')
    expect((screen.getByRole('button', { name: '확인 메일 보내기' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '오늘의 리포트 만들기' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('기업이 없으면 등록 링크만 보여 주고 리포트 만들기를 내놓지 않는다', async () => {
    vi.mocked(appContainer.resolve('getMyCompanyUseCase').execute).mockResolvedValue(null)
    renderPage()
    expect((await screen.findByRole('link', { name: '기업 등록' })).getAttribute('href')).toBe('/app/profile')
    expect(screen.queryByRole('button', { name: '오늘의 리포트 만들기' })).toBeNull()
    expect(screen.queryByRole('link', { name: '기업 정보 수정' })).toBeNull()
  })

  it('SMTP 준비와 자동 발송 활성화는 서로 구분한다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, schedulerEnabled: false })
    vi.mocked(useCase.latest).mockResolvedValue(readyReport)
    renderPage()
    await openSettings()
    expect(screen.getByText(/서버의 새 정기 발송 예약이 꺼져/)).toBeTruthy()
    expect(screen.getByText(/이미 예약된 메일은 처리될 수/)).toBeTruthy()
    expect(screen.getByText('오전 9:00 생성 · 이메일 보내기 전')).toBeTruthy()
    expect((screen.getByRole('button', { name: '확인 메일 보내기' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('수신 동의는 미리 선택하지 않고 명시적으로 선택한 뒤 저장한다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, emailConfirmed: true })
    const save = vi.spyOn(useCase, 'saveSettings').mockResolvedValue({ ...reportSettings, emailConfirmed: true, enabled: true })
    renderPage()
    const form = await editSettings()
    fireEvent.click(screen.getByRole('switch', { name: '정기 이메일 받기' }))
    const consent = screen.getByLabelText(/정기 이메일 수신에 동의합니다/) as HTMLInputElement
    expect(consent.checked).toBe(false)
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('직접 체크')
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(consent)
    fireEvent.submit(form)
    await waitFor(() => expect(save).toHaveBeenCalledWith({ supportPurpose: 'AI 제품 개발', enabled: true, consent: true }, expect.any(AbortSignal)))
    expect((await screen.findByRole('status')).textContent).toContain('수신 설정을 저장했어요')
    // 저장하면 보기로 돌아와 바뀐 상태를 보여 줍니다.
    expect(screen.queryByRole('form', { name: '수신 설정 수정' })).toBeNull()
    expect(within(screen.getByRole('region', { name: '받는 방법' })).getByText('켜짐')).toBeTruthy()
    expect(screen.getByRole('button', { name: '수정' })).toBeTruthy()
  })

  it('수신 중지는 스위치를 끄고 저장하면 추가 동의 없이 처리한다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, emailConfirmed: true, enabled: true })
    const save = vi.spyOn(useCase, 'saveSettings').mockResolvedValue(reportSettings)
    renderPage()
    const form = await editSettings()
    fireEvent.click(screen.getByRole('switch', { name: '정기 이메일 받기' }))
    expect(screen.queryByLabelText(/정기 이메일 수신에 동의합니다/)).toBeNull()
    fireEvent.submit(form)
    await waitFor(() => expect(save).toHaveBeenCalledWith({ supportPurpose: reportSettings.supportPurpose, enabled: false, consent: false }, expect.any(AbortSignal)))
    expect((await screen.findByRole('status')).textContent).toContain('정기 이메일 수신을 중지했어요')
  })

  it('취소하면 고치던 입력을 버리고 저장된 값의 보기로 돌아간다', async () => {
    renderPage()
    await editSettings()
    fireEvent.change(screen.getByLabelText(/지원 목적/), { target: { value: '해외 전시회' } })
    expect((screen.getByRole('button', { name: '오늘의 리포트 만들기' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('form', { name: '수신 설정 수정' })).toBeNull()
    expect((screen.getByRole('button', { name: '오늘의 리포트 만들기' }) as HTMLButtonElement).disabled).toBe(false)
    expect(within(screen.getByRole('region', { name: '추천 기준' })).getByText('AI 제품 개발')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '수정' }))
    expect((screen.getByLabelText(/지원 목적/) as HTMLInputElement).value).toBe('AI 제품 개발')
  })

  it('추천 카드에 접수 상태·자격 배지·관련도·근거를 보여 주고 미지원 항목을 구분한다', async () => {
    setTodayToReportDate()
    const report = structuredClone(readyReport)
    report.programs.push({ ...report.programs[0], sourceCode: 'KSTARTUP', sourceUrl: 'https://www.k-startup.go.kr/detail', title: '창업 지원', eligibilityStatus: 'UNKNOWN', evidenceStatus: 'UNSUPPORTED', evidenceAnswer: null, citations: [] })
    vi.mocked(useCase.latest).mockResolvedValue(report)
    renderPage()
    expect(await screen.findByRole('heading', { name: '9월 9일 리포트' })).toBeTruthy()
    expect(screen.getByText('추천 2건')).toBeTruthy()
    expect(screen.getByText(/서울특별시 · 정보통신업 · 지원 목적 “AI 제품 개발” 기준으로/).textContent).toContain('1건은 원문에서 조건·서류 근거까지 찾았어요.')
    expect(screen.getByText('설립일이 없어 업력 조건은 추가 확인이 필요합니다.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '오늘의 리포트 만들기' })).toBeNull()
    const card = within(screen.getByRole('article', { name: 'AI 제품 개발 지원' }))
    expect(card.getByText('접수 중')).toBeTruthy()
    expect(card.getByText('D-21')).toBeTruthy()
    expect(card.getByText('확인 필요')).toBeTruthy()
    expect(card.getByText('관련도 92')).toBeTruthy()
    expect(card.getByText('접수 기간 2026-09-01 ~ 2026-09-30')).toBeTruthy()
    expect(card.getByText('· 대상·지역 본문에서 확인 필요')).toBeTruthy()
    expect(card.getByText('원문 근거 확인')).toBeTruthy()
    expect(card.getByText('제출서류: 사업계획서')).toBeTruthy()
    expect(card.getByRole('link', { name: '근거 1 원문 보기 ↗' }).getAttribute('href')).toBe('https://www.bizinfo.go.kr/detail?id=PBLN_123')
    expect(card.getByRole('link', { name: '원문 보기' }).getAttribute('href')).toBe('https://www.bizinfo.go.kr/detail?id=PBLN_123')
    expect(card.getByRole('button', { name: '관심 공고에 담기' })).toBeTruthy()
    for (const name of ['AI 제품 개발 지원', '상세 보기']) {
      expect(card.getByRole('link', { name }).getAttribute('href')).toBe('/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_123')
    }
    const unsupported = within(screen.getByRole('article', { name: '창업 지원' }))
    expect(unsupported.getByText('자격 미평가')).toBeTruthy()
    expect(unsupported.getByText('원문 분석 미지원')).toBeTruthy()
  })

  it('가장 최근 리포트가 오늘 것이 아니면 그 리포트를 보여 주면서 오늘 것을 만들 수 있게 한다', async () => {
    vi.mocked(useCase.latest).mockResolvedValue(readyReport)
    const preview = vi.spyOn(useCase, 'preview').mockResolvedValue({ ...readyReport, id: 2, reportDate: reportToday() })
    renderPage()
    expect(await screen.findByText('오늘 리포트는 아직 없어요. 아래는 9월 9일 리포트예요.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '9월 9일 리포트' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '오늘의 리포트 만들기' }))
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1))
    expect((await screen.findByRole('status')).textContent).toContain('오늘의 리포트를 만들었어요')
    expect(screen.queryByRole('button', { name: '오늘의 리포트 만들기' })).toBeNull()
  })

  it.each(['GENERATING', 'FAILED', 'READY'] as const)('%s 상태에서 검색 준비·장애를 빈 추천과 혼동하지 않는다', async (status) => {
    setTodayToReportDate()
    vi.mocked(useCase.latest).mockResolvedValue({ ...readyReport, status, programs: [], generatedAt: null, errorMessage: status === 'FAILED' ? '검색 장애' : null })
    renderPage()
    const text = status === 'GENERATING' ? /오늘의 리포트를 만들고 있어요/ : status === 'FAILED' ? /오늘의 리포트를 만들지 못했어요/ : /이번에는 추천할 접수 중 공고가 없어요/
    await screen.findByText(text)
    if (status !== 'READY') expect(screen.queryByText(/이번에는 추천할 접수 중/)).toBeNull()
    if (status === 'FAILED') {
      expect(screen.getByText(/검색 장애 추천할 공고가 없다는 뜻은 아니에요/)).toBeTruthy()
      expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()
    }
    if (status === 'READY') expect(screen.getByRole('link', { name: '지원사업 검색' }).getAttribute('href')).toBe('/app/chat')
  })

  it('만드는 중인 리포트는 끝날 때까지 다시 읽어 완성본으로 바꾼다', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-09-09T03:00:00Z'))
    vi.mocked(useCase.latest).mockResolvedValueOnce({ ...readyReport, status: 'GENERATING', programs: [], generatedAt: null }).mockResolvedValue(readyReport)
    renderPage()
    await screen.findByText(/오늘의 리포트를 만들고 있어요/)
    await act(async () => { await vi.advanceTimersByTimeAsync(dailyReportPollMs) })
    expect(await screen.findByRole('heading', { name: '9월 9일 리포트' })).toBeTruthy()
    expect(useCase.latest).toHaveBeenCalledTimes(2)
  })

  it('리포트를 불러오지 못하면 그 자리에서 다시 시도한다', async () => {
    vi.mocked(useCase.settings).mockRejectedValueOnce(new Error('network')).mockResolvedValue(reportSettings)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('heading', { name: '오늘의 리포트가 아직 없어요' })).toBeTruthy()
  })

  it('계정 전환 직후 진행 중 요청을 취소하고 늦게 도착한 이전 결과를 버린다', async () => {
    let resolvePreview: (report: DailyReport) => void = () => {}
    const preview = vi.spyOn(useCase, 'preview').mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve }))
    const store = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '오늘의 리포트 만들기' }))
    const signal = preview.mock.calls[0][0]
    act(() => {
      store.dispatch(sessionRestored({ ...reportAccount, email: 'other@example.test' }))
      resolvePreview({ ...readyReport, companyName: '이전 계정 비공개 정보' })
    })
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(useCase.latest).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/이전 계정 비공개 정보/)).toBeNull()
  })

  it('화면을 떠나면 리포트 생성 요청을 취소한다', async () => {
    const preview = vi.spyOn(useCase, 'preview').mockImplementation(() => new Promise(() => {}))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '오늘의 리포트 만들기' }))
    expect(await screen.findByText(/오늘의 리포트를 만들고 있어요/)).toBeTruthy()
    cleanup()
    expect(preview.mock.calls[0][0]?.aborted).toBe(true)
  })
})

function LocationProbe() { const location = useLocation(); return <span data-testid="location">{location.pathname}{location.hash}</span> }

describe('리포트 이메일 링크', () => {
  it('이미 로그인한 계정도 헤더·사이드바 없는 이메일 확인 화면에 머문다', async () => {
    const perform = vi.spyOn(useCase, 'emailAction')
    const store = createAppStore()
    store.dispatch(sessionRestored(reportAccount))
    render(<Provider store={store}><MemoryRouter initialEntries={[`/report-email#action=confirm&token=${'a'.repeat(43)}`]}><App /></MemoryRouter></Provider>)
    await screen.findByRole('button', { name: '수신 주소 확인' })
    expect(screen.getByRole('heading', { name: '리포트 수신 주소를 확인할까요?' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    expect(screen.queryByRole('banner')).toBeNull()
    expect(perform).not.toHaveBeenCalled()
  })
  it.each(['confirm', 'unsubscribe'] as const)('%s 링크는 토큰을 주소에서 지우고 직접 누른 버튼으로만 처리한다', async (action) => {
    const perform = vi.spyOn(useCase, 'emailAction').mockResolvedValue(undefined)
    const token = 'a'.repeat(43)
    render(<MemoryRouter initialEntries={[`/report-email#action=${action}&token=${token}`]}><DailyReportEmailPage /><LocationProbe /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/report-email'))
    expect(perform).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: action === 'confirm' ? '수신 주소 확인' : '수신 해지' }))
    await waitFor(() => expect(perform).toHaveBeenCalledWith(action, token, expect.any(AbortSignal)))
    expect((await screen.findByRole('heading', { name: action === 'confirm' ? '리포트 이메일을 확인했어요' : '정기 리포트 수신을 해지했어요' }))).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(action === 'confirm' ? '자동으로 켜지지 않으니' : '더 보내지 않아요')
    expect(screen.getByRole('link', { name: '수신 설정 열기' }).getAttribute('href')).toBe('/app/reports?settings=open')
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.body.textContent).not.toContain(token)
  })

  it('처리하는 동안은 버튼 대신 처리 중 표시를 보여 준다', async () => {
    vi.spyOn(useCase, 'emailAction').mockImplementation(() => new Promise(() => {}))
    render(<MemoryRouter initialEntries={[`/report-email#action=confirm&token=${'a'.repeat(43)}`]}><DailyReportEmailPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: '수신 주소 확인' }))
    expect((await screen.findByRole('status')).textContent).toContain('처리하는 중이에요')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('만료되거나 이미 쓴 링크는 결과 화면으로 넘겨 수신 설정에서 다시 요청하게 한다', async () => {
    vi.spyOn(useCase, 'emailAction').mockRejectedValue(new DailyReportError(400, 'INVALID_EMAIL_TOKEN'))
    render(<MemoryRouter initialEntries={[`/report-email#action=confirm&token=${'a'.repeat(43)}`]}><DailyReportEmailPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: '수신 주소 확인' }))
    expect((await screen.findByRole('alert')).textContent).toContain('만료됐거나 이미 사용한 링크예요')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('link', { name: '수신 설정 열기' }).getAttribute('href')).toBe('/app/reports?settings=open')
  })

  it('일시적인 실패는 버튼을 둔 채 알려 다시 누를 수 있게 한다', async () => {
    const perform = vi.spyOn(useCase, 'emailAction').mockRejectedValueOnce(new DailyReportError(429, 'RATE_LIMITED')).mockResolvedValue(undefined)
    render(<MemoryRouter initialEntries={[`/report-email#action=unsubscribe&token=${'a'.repeat(43)}`]}><DailyReportEmailPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: '수신 해지' }))
    expect((await screen.findByRole('alert')).textContent).toContain('요청량 제한')
    fireEvent.click(screen.getByRole('button', { name: '수신 해지' }))
    expect(await screen.findByRole('heading', { name: '정기 리포트 수신을 해지했어요' })).toBeTruthy()
    expect(perform).toHaveBeenCalledTimes(2)
  })

  it('토큰 없는 링크는 처리 버튼을 제공하지 않는다', () => {
    render(<MemoryRouter initialEntries={['/report-email']}><DailyReportEmailPage /></MemoryRouter>)
    expect(screen.getByRole('alert').textContent).toContain('유효한 이메일 링크가 없어요')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('StrictMode와 같은 화면의 새 링크에서도 최신 토큰만 사용한다', async () => {
    const perform = vi.spyOn(useCase, 'emailAction').mockResolvedValue(undefined)
    const oldToken = 'a'.repeat(43)
    const newToken = 'b'.repeat(43)
    render(<StrictMode><MemoryRouter initialEntries={[`/report-email#action=confirm&token=${oldToken}`]}><DailyReportEmailPage /><Link to={`/report-email#action=confirm&token=${newToken}`}>새 링크</Link><LocationProbe /></MemoryRouter></StrictMode>)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/report-email'))
    fireEvent.click(screen.getByRole('link', { name: '새 링크' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/report-email'))
    fireEvent.click(screen.getByRole('button', { name: '수신 주소 확인' }))
    await waitFor(() => expect(perform).toHaveBeenCalledWith('confirm', newToken, expect.any(AbortSignal)))
    expect(perform).toHaveBeenCalledTimes(1)
  })
})
