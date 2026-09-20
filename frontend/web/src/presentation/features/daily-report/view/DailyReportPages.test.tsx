// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { Link } from 'react-router'
import { StrictMode } from 'react'
import App from '../../../../App'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import type { DailyReport } from '../../../../domain/entities/DailyReport'
import { sessionRestored } from '../../../shared/auth/state/authSlice'
import { DailyReportPage } from './DailyReportPage'
import { DailyReportEmailPage } from './DailyReportEmailPage'
import { readyReport, reportAccount, reportCompany, reportSettings } from '../testing/dailyReportFixtures'

const useCase = appContainer.resolve('dailyReportUseCase')

beforeEach(() => {
  vi.spyOn(useCase, 'settings').mockResolvedValue(reportSettings)
  vi.spyOn(useCase, 'latest').mockResolvedValue(null)
  vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(reportCompany)
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function renderPage() {
  const store = createAppStore()
  store.dispatch(sessionRestored(reportAccount))
  render(<Provider store={store}><MemoryRouter initialEntries={['/app/reports']}><DailyReportPage /></MemoryRouter></Provider>)
  return store
}

describe('기업 맞춤 리포트 화면', () => {
  it('작업 사이드바의 리포트 메뉴가 보호된 리포트 화면으로 연결된다', async () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(reportAccount))
    render(<Provider store={store}><MemoryRouter initialEntries={['/app/reports']}><App /></MemoryRouter></Provider>)
    expect((await screen.findByRole('heading', { name: '기업 맞춤 리포트' }))).toBeTruthy()
    expect(screen.getByRole('link', { name: '기업 맞춤 리포트' }).getAttribute('href')).toBe('/app/reports')
  })
  it('조회만으로 유료 미리보기나 이메일을 요청하지 않고 수신 주소 확인을 안내한다', async () => {
    const preview = vi.spyOn(useCase, 'preview')
    const verify = vi.spyOn(useCase, 'verifyEmail')
    renderPage()
    await screen.findByRole('button', { name: '이메일 주소 확인 메일 보내기' })
    expect((screen.getByLabelText(/매일 8시 이후/) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/아직 생성된 리포트가 없습니다/)).toBeTruthy()
    expect(preview).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('메일 설정이 꺼져 있어도 웹 미리보기는 가능하고 발송 준비 상태를 알린다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, emailDeliveryAvailable: false })
    renderPage()
    await screen.findByText(/현재 서버의 이메일 발송이 꺼져/)
    expect((screen.getByRole('button', { name: '이메일 주소 확인 메일 보내기' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '오늘의 리포트 미리보기' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('기업이 없으면 등록 링크를 보여 주고 미리보기를 막는다', async () => {
    vi.mocked(appContainer.resolve('getMyCompanyUseCase').execute).mockResolvedValue(null)
    renderPage()
    expect((await screen.findByRole('link', { name: '기업 정보 등록하기' })).getAttribute('href')).toBe('/app/profile')
    expect((screen.getByRole('button', { name: '오늘의 리포트 미리보기' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('SMTP 준비와 자동 발송 활성화는 서로 구분한다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, schedulerEnabled: false })
    vi.mocked(useCase.latest).mockResolvedValue(readyReport)
    renderPage()
    await screen.findByText(/서버의 새 정기 발송 예약이 꺼져/)
    expect(screen.getByText(/이미 예약된 메일은 처리될 수/)).toBeTruthy()
    expect(await screen.findByText('이메일: 미발송 (예약 전 또는 대기 중)')).toBeTruthy()
    expect((screen.getByRole('button', { name: '이메일 주소 확인 메일 보내기' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('수신 동의는 미리 선택하지 않고 명시적으로 선택한 뒤 저장한다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, emailConfirmed: true })
    const save = vi.spyOn(useCase, 'saveSettings').mockResolvedValue({ ...reportSettings, emailConfirmed: true, enabled: true })
    renderPage()
    await screen.findByRole('form', { name: '리포트 설정' })
    fireEvent.click(screen.getByLabelText(/매일 8시 이후/))
    const consent = screen.getByLabelText(/정기 이메일 수신에 동의합니다/) as HTMLInputElement
    expect(consent.checked).toBe(false)
    fireEvent.submit(screen.getByRole('form', { name: '리포트 설정' }))
    expect(screen.getByRole('alert').textContent).toContain('직접 체크')
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(consent)
    fireEvent.submit(screen.getByRole('form', { name: '리포트 설정' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ supportPurpose: 'AI 제품 개발', enabled: true, consent: true }, expect.any(AbortSignal)))
  })

  it('수신 중지는 추가 동의 없이 저장된 설정으로 처리한다', async () => {
    vi.mocked(useCase.settings).mockResolvedValue({ ...reportSettings, emailConfirmed: true, enabled: true })
    const save = vi.spyOn(useCase, 'saveSettings').mockResolvedValue(reportSettings)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '정기 이메일 수신 중지' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ supportPurpose: reportSettings.supportPurpose, enabled: false, consent: false }, expect.any(AbortSignal)))
  })

  it('관련도·기준 조건·근거와 미지원 항목을 구분한다', async () => {
    const report = structuredClone(readyReport)
    report.programs.push({ ...report.programs[0], sourceCode: 'KSTARTUP', sourceUrl: 'https://www.k-startup.go.kr/detail', title: '창업 지원', evidenceStatus: 'UNSUPPORTED', evidenceAnswer: null, citations: [] })
    vi.mocked(useCase.latest).mockResolvedValue(report)
    renderPage()
    expect((await screen.findAllByText('검색 관련도: 92/100점 · 선정확률 아님')).length).toBe(2)
    expect(screen.getByText('제출서류: 사업계획서')).toBeTruthy()
    expect(screen.getByText('이 제공처의 원문 분석은 아직 지원하지 않음')).toBeTruthy()
    expect(screen.getByText(/저장한 조건을 바꾸어도 오늘의 결과는/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'AI 제품 개발 지원' }).getAttribute('href')).toBe('/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_123')
  })

  it.each(['GENERATING', 'FAILED', 'READY'] as const)('%s 상태에서 검색 준비·장애를 빈 추천과 혼동하지 않는다', async (status) => {
    vi.mocked(useCase.latest).mockResolvedValue({ ...readyReport, status, programs: [], generatedAt: null, errorMessage: status === 'FAILED' ? '검색 장애' : null })
    renderPage()
    const text = status === 'GENERATING' ? /리포트를 생성 중입니다/ : status === 'FAILED' ? /리포트 생성에 실패했습니다/ : /이번 검색에서 추천할 접수 중 공고를 찾지 못했습니다/
    await screen.findByText(text)
    if (status !== 'READY') expect(screen.queryByText(/이번 검색에서 추천할 접수 중/)).toBeNull()
  })

  it('계정 전환 직후 진행 중 요청을 취소하고 늦게 도착한 이전 결과를 버린다', async () => {
    let resolvePreview: (report: DailyReport) => void = () => {}
    const preview = vi.spyOn(useCase, 'preview').mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve }))
    const store = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '오늘의 리포트 미리보기' }))
    const signal = preview.mock.calls[0][0]
    act(() => {
      store.dispatch(sessionRestored({ ...reportAccount, email: 'other@example.test' }))
      resolvePreview({ ...readyReport, companyName: '이전 계정 비공개 정보' })
    })
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(useCase.latest).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/이전 계정 비공개 정보/)).toBeNull()
  })

  it('화면을 떠나면 미리보기 요청을 취소한다', async () => {
    const preview = vi.spyOn(useCase, 'preview').mockImplementation(() => new Promise(() => {}))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '오늘의 리포트 미리보기' }))
    cleanup()
    expect(preview.mock.calls[0][0]?.aborted).toBe(true)
  })
})

function LocationProbe() { const location = useLocation(); return <span data-testid="location">{location.pathname}{location.hash}</span> }

describe('리포트 이메일 링크', () => {
  it('이미 로그인한 계정도 이메일 확인 공개 경로에 머문다', async () => {
    const perform = vi.spyOn(useCase, 'emailAction')
    const store = createAppStore()
    store.dispatch(sessionRestored(reportAccount))
    render(<Provider store={store}><MemoryRouter initialEntries={[`/report-email#action=confirm&token=${'a'.repeat(43)}`]}><App /></MemoryRouter></Provider>)
    await screen.findByRole('button', { name: '리포트 수신 주소 확인' })
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    expect(perform).not.toHaveBeenCalled()
  })
  it.each(['confirm', 'unsubscribe'] as const)('%s 링크는 토큰을 주소에서 지우고 직접 누른 버튼으로만 처리한다', async (action) => {
    const perform = vi.spyOn(useCase, 'emailAction').mockResolvedValue(undefined)
    const token = 'a'.repeat(43)
    render(<MemoryRouter initialEntries={[`/report-email#action=${action}&token=${token}`]}><DailyReportEmailPage /><LocationProbe /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/report-email'))
    expect(perform).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: action === 'confirm' ? '리포트 수신 주소 확인' : '정기 리포트 수신 해지' }))
    await waitFor(() => expect(perform).toHaveBeenCalledWith(action, token, expect.any(AbortSignal)))
    expect(screen.getByRole('status').textContent).toContain(action === 'confirm' ? '자동으로 켜지지 않습니다' : '수신을 중지')
    expect(document.body.textContent).not.toContain(token)
  })

  it('토큰 없는 링크는 처리 버튼을 제공하지 않는다', () => {
    render(<MemoryRouter initialEntries={['/report-email']}><DailyReportEmailPage /></MemoryRouter>)
    expect(screen.getByRole('alert').textContent).toContain('유효한 이메일 링크가 없습니다')
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
    fireEvent.click(screen.getByRole('button', { name: '리포트 수신 주소 확인' }))
    await waitFor(() => expect(perform).toHaveBeenCalledWith('confirm', newToken, expect.any(AbortSignal)))
    expect(perform).toHaveBeenCalledTimes(1)
  })
})
