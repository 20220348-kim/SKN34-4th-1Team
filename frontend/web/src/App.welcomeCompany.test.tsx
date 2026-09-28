// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import type { BusinessLookup, Company } from './domain/entities/Company'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { chooseOption } from './test/selectField'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const businessAccount: Account = {
  email: 'new@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null,
  accountType: 'BUSINESS', onboarded: true,
}

const activeBusiness: BusinessLookup = {
  businessNumber: '1248100998', companyName: '삼성전자(주)', businessStatus: '계속사업자', businessStatusCode: '01', isActive: true, canRegister: true,
}

const registeredCompany: Company = {
  businessNumber: '1248100998', companyName: '삼성전자(주)', businessStatus: '계속사업자', businessStatusCode: '01',
  region: '서울특별시', industry: '정보통신업', foundedYear: 2020, homepageUrl: null,
  businessVerifiedAt: '2026-09-22T10:00:00', updatedAt: '2026-09-22T10:00:00',
}

function Location() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function renderApp(path: string, account: Account) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  render(<Provider store={store}><MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter></Provider>)
  return store
}

function lookupNumber(value: string) {
  const form = screen.getByRole('form', { name: '기업 등록' })
  fireEvent.change(within(form).getByLabelText('사업자등록번호'), { target: { value } })
  fireEvent.click(within(form).getByRole('button', { name: '조회' }))
  return form
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('온보딩 2단계 기업 등록', () => {
  it('조회 전에는 폼이 없고 등록 버튼이 잠기며, 계속사업자를 조회하면 폼이 열려 등록한 뒤 검색 화면으로 간다', async () => {
    const lookup = vi.spyOn(appContainer.resolve('lookupBusinessUseCase'), 'execute').mockResolvedValue({ outcome: 'found', business: activeBusiness })
    const register = vi.spyOn(appContainer.resolve('registerCompanyUseCase'), 'execute').mockResolvedValue({ outcome: 'registered', company: registeredCompany })
    const store = renderApp('/app/welcome/company', businessAccount)

    expect(await screen.findByRole('heading', { name: '기업 정보를 알려 주세요' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    expect(screen.queryByLabelText('소재지')).toBeNull()
    expect((screen.getByRole('button', { name: '등록하고 시작' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '나중에 하기' }) as HTMLButtonElement).disabled).toBe(false)

    const form = lookupNumber('124-81-00998')
    const result = await screen.findByRole('status', { name: '조회 결과' })
    expect(lookup).toHaveBeenCalledWith('124-81-00998')
    expect(within(result).getByText('삼성전자(주)')).toBeTruthy()
    expect(within(result).getByText('계속사업자')).toBeTruthy()
    expect((screen.getByRole('button', { name: '등록하고 시작' }) as HTMLButtonElement).disabled).toBe(false)

    // 비워 두고 누르면 검증 문구가 나오고 서버에는 가지 않습니다.
    fireEvent.click(screen.getByRole('button', { name: '등록하고 시작' }))
    expect(screen.getByText('소재지를 선택해 주세요.')).toBeTruthy()
    expect(register).not.toHaveBeenCalled()

    chooseOption(within(form).getByLabelText('소재지'), '서울특별시')
    chooseOption(within(form).getByLabelText('업종'), '정보통신업')
    chooseOption(within(form).getByLabelText('설립연도'), '2020')
    fireEvent.click(screen.getByRole('button', { name: '등록하고 시작' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/chat'))
    expect(register).toHaveBeenCalledWith('1248100998', { region: '서울특별시', industry: '정보통신업', foundedYear: 2020, homepageUrl: null })
    expect(store.getState().auth.account?.company?.companyName).toBe('삼성전자(주)')
    expect(store.getState().auth.account?.tier).toBe('COMPANY')
    const sidebar = await screen.findByRole('complementary', { name: '작업 사이드바' })
    expect(within(sidebar).getByText('삼성전자(주) · 기업 회원')).toBeTruthy()
  })

  it('번호를 고치면 결과와 폼이 접히고, 폐업자는 폼이 열리지 않은 채 이유만 보여 준다', async () => {
    vi.spyOn(appContainer.resolve('lookupBusinessUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'found', business: activeBusiness })
      .mockResolvedValueOnce({ outcome: 'found', business: { ...activeBusiness, businessNumber: '1112233334', companyName: '오션푸드', businessStatus: '폐업자', businessStatusCode: '03', isActive: false, canRegister: false } })
    renderApp('/app/welcome/company', businessAccount)
    await screen.findByRole('heading', { name: '기업 정보를 알려 주세요' })

    const form = lookupNumber('1248100998')
    await screen.findByRole('status', { name: '조회 결과' })
    expect(screen.getByLabelText('소재지')).toBeTruthy()

    fireEvent.change(within(form).getByLabelText('사업자등록번호'), { target: { value: '1112233334' } })
    expect(screen.queryByRole('status', { name: '조회 결과' })).toBeNull()
    expect(screen.queryByLabelText('소재지')).toBeNull()

    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    const closed = await screen.findByRole('status', { name: '조회 결과' })
    expect(within(closed).getByText('폐업자')).toBeTruthy()
    expect(within(closed).getByText(/폐업한 사업자는 등록할 수 없어요/)).toBeTruthy()
    expect(screen.queryByLabelText('소재지')).toBeNull()
    expect((screen.getByRole('button', { name: '등록하고 시작' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('휴업자는 폼이 열려 등록할 수 있고 안내가 파트너 기능 잠김을 말한다', async () => {
    vi.spyOn(appContainer.resolve('lookupBusinessUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'found', business: { ...activeBusiness, companyName: '한빛정밀', businessStatus: '휴업자', businessStatusCode: '02', isActive: false, canRegister: true } })
    renderApp('/app/welcome/company', businessAccount)
    await screen.findByRole('heading', { name: '기업 정보를 알려 주세요' })

    lookupNumber('1248100998')
    const result = await screen.findByRole('status', { name: '조회 결과' })
    expect(within(result).getByText('휴업자')).toBeTruthy()
    expect(within(result).getByText(/등록은 할 수 있어요/)).toBeTruthy()
    expect(screen.getByLabelText('소재지')).toBeTruthy()
    expect((screen.getByRole('button', { name: '등록하고 시작' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('미등록 번호는 입력 칸 오류로, 조회 불가는 다시 시도 카드로 안내하고 다시 시도하면 다시 조회한다', async () => {
    const lookup = vi.spyOn(appContainer.resolve('lookupBusinessUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'not-found' })
      .mockResolvedValueOnce({ outcome: 'lookup-unavailable' })
      .mockResolvedValueOnce({ outcome: 'found', business: activeBusiness })
    renderApp('/app/welcome/company', businessAccount)
    await screen.findByRole('heading', { name: '기업 정보를 알려 주세요' })

    const form = lookupNumber('1234567890')
    const error = await screen.findByRole('alert')
    expect(error.textContent).toContain('국세청에 등록되지 않은 번호예요')
    expect(within(form).getByLabelText('사업자등록번호').getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(within(form).getByLabelText('사업자등록번호'), { target: { value: '1248100998' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    const unavailable = await screen.findByRole('status', { name: '조회 결과' })
    expect(within(unavailable).getByText('지금은 조회가 되지 않아요')).toBeTruthy()
    expect(within(unavailable).getByText(/건너뛰고 프로필에서 나중에 등록할 수 있어요/)).toBeTruthy()

    fireEvent.click(within(unavailable).getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('삼성전자(주)')).toBeTruthy()
  })

  it('다른 계정이 등록한 사업자와 등록 실패는 입력값을 그대로 둔 채 안내한다', async () => {
    vi.spyOn(appContainer.resolve('lookupBusinessUseCase'), 'execute').mockResolvedValue({ outcome: 'found', business: activeBusiness })
    vi.spyOn(appContainer.resolve('registerCompanyUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'business-number-taken' })
      .mockRejectedValueOnce(new Error('down'))
    renderApp('/app/welcome/company', businessAccount)
    await screen.findByRole('heading', { name: '기업 정보를 알려 주세요' })

    const form = lookupNumber('1248100998')
    await screen.findByRole('status', { name: '조회 결과' })
    chooseOption(within(form).getByLabelText('소재지'), '서울특별시')
    chooseOption(within(form).getByLabelText('업종'), '정보통신업')
    chooseOption(within(form).getByLabelText('설립연도'), '2020')

    fireEvent.click(screen.getByRole('button', { name: '등록하고 시작' }))
    expect((await screen.findByRole('alert')).textContent).toContain('다른 계정에 등록돼 있어요')
    expect(screen.getByTestId('location').textContent).toBe('/app/welcome/company')

    fireEvent.click(screen.getByRole('button', { name: '등록하고 시작' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('입력한 내용은 그대로 있어요'))
    expect(within(form).getByLabelText('소재지').textContent).toContain('서울특별시')
  })

  it('나중에 하기는 저장 없이 검색 화면으로 가고 사이드바가 열린다', async () => {
    const register = vi.spyOn(appContainer.resolve('registerCompanyUseCase'), 'execute')
    renderApp('/app/welcome/company', businessAccount)
    fireEvent.click(await screen.findByRole('button', { name: '나중에 하기' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/chat'))
    expect(await screen.findByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
    expect(register).not.toHaveBeenCalled()
  })

  it('개인 회원은 검색 화면으로, 이미 기업이 있는 계정은 프로필로 보낸다', async () => {
    renderApp('/app/welcome/company', { ...businessAccount, accountType: 'INDIVIDUAL' })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/chat'))
    cleanup()

    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(registeredCompany)
    renderApp('/app/welcome/company', { ...businessAccount, tier: 'COMPANY', company: { companyName: '삼성전자(주)', businessNumber: '1248100998', businessStatusCode: '01' } })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/profile'))
  })

  it('아직 1단계를 답하지 않은 계정이 2단계를 열면 1단계로 돌아간다', async () => {
    renderApp('/app/welcome/company', { ...businessAccount, accountType: null, onboarded: false })
    expect(await screen.findByRole('heading', { name: '어떤 회원으로 시작할까요?' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/app/welcome')
  })
})
