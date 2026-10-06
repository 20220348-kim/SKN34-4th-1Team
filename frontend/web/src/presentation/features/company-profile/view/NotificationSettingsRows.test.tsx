// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSettings } from '@govbiz/shared/domain/entities/NotificationSettings'
import { NotificationSettingsError } from '@govbiz/shared/domain/errors/NotificationSettingsError'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import type { Account } from '../../../../domain/entities/Account'
import { sessionRestored } from '../../../shared/auth/state/authSlice'
import { CompanyProfilePage } from './CompanyProfilePage'

const settings: NotificationSettings = {
  deadlineReminder: { enabled: false, email: false, push: false },
  emailConfirmed: true, emailDeliveryAvailable: true, pushDeliveryAvailable: true,
  pushDeviceRegistered: false, schedulerEnabled: true, sendHour: 9, reminderDaysBefore: [7, 3, 1],
}
const account: Account = {
  email: 'member@example.test', role: 'USER', tier: 'MEMBER', emailVerified: true, company: null,
  hasPassword: true, accountType: null, onboarded: true,
}
const useCase = appContainer.resolve('notificationSettingsUseCase')
const reminderSwitch = () => screen.findByRole('switch', { name: '관심 공고 마감 알림' })

/** 제목 옆 ? 도움말을 열고 말풍선을 돌려줍니다. 안내 문구는 말풍선 안에만 있습니다. */
function openReminderHelp() {
  fireEvent.focus(screen.getByRole('button', { name: '관심 공고 마감 알림 도움말' }))
  return screen.getByRole('tooltip')
}

beforeEach(() => {
  vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
  vi.spyOn(useCase, 'settings').mockResolvedValue(settings)
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function renderPage() {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  render(<Provider store={store}><MemoryRouter initialEntries={['/app/profile']}><CompanyProfilePage /></MemoryRouter></Provider>)
}

describe('프로필 알림 설정', () => {
  it('서버 설정으로 마감 알림 스위치를 보여 주고, 보내지 않는 알림은 스위치 없이 준비 중으로 표시한다', async () => {
    renderPage()
    expect((await reminderSwitch()).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('마감 7일·3일·1일 전 오전 9시 이후에 한 번씩 보내요.')).toBeNull()
    expect(within(openReminderHelp()).getByText('마감 7일·3일·1일 전 오전 9시 이후에 한 번씩 보내요.')).toBeTruthy()
    expect(screen.queryByLabelText('알림 시점')).toBeNull()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByText('파트너 제안·메시지 알림')).toBeTruthy()
    expect(screen.getByText('프로필 조건에 맞는 새 공고 알림')).toBeTruthy()
    expect(screen.getAllByText('준비 중')).toHaveLength(2)
  })

  it('켜면 확인된 이메일로 저장하고 저장하는 동안 다른 조작을 막은 뒤 서버 응답으로 맞춘다', async () => {
    const pending: ((value: NotificationSettings) => void)[] = []
    const save = vi.spyOn(useCase, 'saveDeadlineReminder')
      .mockImplementation(() => new Promise<NotificationSettings>((resolve) => { pending.push(resolve) }))
    renderPage()
    fireEvent.click(await reminderSwitch())
    expect(save).toHaveBeenCalledWith({ enabled: true, email: true, push: false })
    const toggle = await reminderSwitch()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    const options = screen.getByRole('group', { name: '마감 알림 받는 방법' })
    expect(within(options).getAllByRole('checkbox').every((box) => (box as HTMLInputElement).disabled)).toBe(true)

    await act(async () => pending[0]({ ...settings, deadlineReminder: { enabled: true, email: true, push: false } }))
    expect(((await reminderSwitch()) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(screen.getByRole('group', { name: '마감 알림 받는 방법' })).getByRole('checkbox', { name: /앱 알림/ }))
    expect(save).toHaveBeenLastCalledWith({ enabled: true, email: true, push: true })
  })

  it('저장에 실패하면 이전 상태로 되돌리고 이유를 알려 준다', async () => {
    vi.spyOn(useCase, 'saveDeadlineReminder').mockRejectedValue(new NotificationSettingsError(409, 'EMAIL_CONFIRMATION_REQUIRED'))
    renderPage()
    fireEvent.click(await reminderSwitch())
    expect(await screen.findByText('맞춤 리포트 화면에서 수신 이메일 주소를 먼저 확인해 주세요.')).toBeTruthy()
    expect((await reminderSwitch()).getAttribute('aria-checked')).toBe('false')
  })

  it('받을 방법이 없으면 스위치를 잠그고, 이유는 도움말에 두되 수신 주소 확인 링크는 줄 아래에 남긴다', async () => {
    vi.spyOn(useCase, 'settings').mockResolvedValue({ ...settings, emailConfirmed: false })
    const save = vi.spyOn(useCase, 'saveDeadlineReminder')
    renderPage()
    expect(((await reminderSwitch()) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(/받을 방법이 아직 없어요/)).toBeNull()
    expect(screen.getByRole('link', { name: '수신 주소 확인하기' }).getAttribute('href')).toBe('/app/reports?settings=open')
    expect(within(openReminderHelp()).getByText(/받을 방법이 아직 없어요/)).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it('서버 발송이 꺼져 있다는 안내도 도움말 안에서만 보여 준다', async () => {
    vi.spyOn(useCase, 'settings').mockResolvedValue({ ...settings, schedulerEnabled: false })
    renderPage()
    await reminderSwitch()
    expect(screen.queryByText(/서버의 마감 알림 발송이 아직 꺼져 있어요/)).toBeNull()
    expect(within(openReminderHelp()).getByText('서버의 마감 알림 발송이 아직 꺼져 있어요. 설정은 미리 저장해 둘 수 있어요.')).toBeTruthy()
  })

  it('불러오기에 실패하면 가짜 상태 대신 오류를 보여 주고 다시 읽을 수 있다', async () => {
    const load = vi.spyOn(useCase, 'settings').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(settings)
    renderPage()
    expect(await screen.findByText('알림 설정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await reminderSwitch()).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
