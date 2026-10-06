import { Link } from 'react-router'

import { appPaths } from '../../../shared/routes/appPaths'
import { HelpTip } from '../../../shared/workspace/HelpTip'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspaceToggle } from '../../../shared/workspace/WorkspaceToggle'
import type { NotificationSettingsViewModel } from '../viewmodel/useNotificationSettingsViewModel'
import { companyProfileStyles } from './CompanyProfilePage.styles'

/** 아직 보내는 기능이 없는 알림입니다. 켜고 끄는 스위치 대신 준비 중으로만 알립니다. */
const upcomingNotifications = ['파트너 제안·메시지 알림', '프로필 조건에 맞는 새 공고 알림'] as const

type ReadyViewModel = Extract<NotificationSettingsViewModel, { status: 'ready' }>

/** 계정과 알림 카드의 알림 줄입니다. 관심 공고 마감 알림만 서버에 저장하고 실제로 보냅니다. */
export function NotificationSettingsRows({ vm }: { vm: NotificationSettingsViewModel }) {
  return (
    <>
      {vm.status === 'ready' ? (
        <DeadlineReminderRow vm={vm} />
      ) : (
        <div className={companyProfileStyles.settingRow}>
          <span className="min-w-0">
            <span className={companyProfileStyles.accountValue}>관심 공고 마감 알림</span>
            {vm.status === 'loading' ? (
              <span className={companyProfileStyles.settingDescription} aria-live="polite">알림 설정을 불러오는 중이에요.</span>
            ) : (
              <span className={companyProfileStyles.settingDescription} role="alert">{vm.loadFailedMessage}</span>
            )}
          </span>
          {vm.status === 'failed' ? (
            <button className={workspacePageStyles.secondaryButton} type="button" onClick={vm.retry}>다시 시도</button>
          ) : null}
        </div>
      )}
      {upcomingNotifications.map((label) => (
        <div className={companyProfileStyles.settingRow} key={label}>
          <span className={companyProfileStyles.accountValue}>{label}</span>
          <span className={workspaceTagClassName('muted')}>준비 중</span>
        </div>
      ))}
    </>
  )
}

/**
 * 마감 알림 한 줄입니다. 보내는 시점과 지금 켤 수 없는 이유·서버 발송 상태는 제목 옆 ? 도움말에 둡니다.
 * 수신 주소 확인 링크는 말풍선 안에서는 키보드로 닿지 않으므로 필요할 때 줄 아래에 그대로 둡니다.
 */
function DeadlineReminderRow({ vm }: { vm: ReadyViewModel }) {
  const needsEmailConfirmation = vm.channels.some((channel) => channel.needsEmailConfirmation)
  const confirmLink = (
    <Link className={workspacePageStyles.quietLink} to={`${appPaths.reports}?settings=open`}>수신 주소 확인하기</Link>
  )
  return (
    <div className={companyProfileStyles.reminderBox} aria-busy={vm.isSaving}>
      <div className={companyProfileStyles.reminderHeader}>
        <span className={`${companyProfileStyles.titleRow} min-w-0`}>
          <span className={companyProfileStyles.accountValue}>관심 공고 마감 알림</span>
          <HelpTip label="관심 공고 마감 알림 도움말" title="관심 공고 마감 알림">
            <p className="m-0">{vm.timing}</p>
            {vm.enableBlocker ? <p className="m-0">{vm.enableBlocker}</p> : null}
            {vm.schedulerNote ? <p className="m-0">{vm.schedulerNote}</p> : null}
          </HelpTip>
        </span>
        <WorkspaceToggle
          label="관심 공고 마감 알림"
          isOn={vm.setting.enabled}
          disabled={vm.isSaving || vm.enableBlocker !== null}
          onToggle={vm.toggleEnabled}
        />
      </div>
      {vm.setting.enabled ? (
        <div className={companyProfileStyles.reminderOptions} role="group" aria-label="마감 알림 받는 방법">
          {vm.channels.map((channel) => (
            <label className={companyProfileStyles.reminderChannel} key={channel.key}>
              <input
                type="checkbox"
                checked={channel.isOn}
                disabled={channel.isDisabled}
                onChange={() => vm.toggleChannel(channel.key)}
              />
              <span className="min-w-0">
                <span className={companyProfileStyles.settingTitle}>{channel.label}</span>
                <span className={companyProfileStyles.settingDescription}>{channel.note}</span>
              </span>
            </label>
          ))}
          {needsEmailConfirmation ? confirmLink : null}
        </div>
      ) : null}
      {vm.enableBlocker && needsEmailConfirmation ? <p className={companyProfileStyles.reminderNote}>{confirmLink}</p> : null}
      {vm.isSaving ? <p className="sr-only" aria-live="polite">알림 설정을 저장하는 중이에요.</p> : null}
      {vm.error ? <p className={companyProfileStyles.formError} role="alert">{vm.error}</p> : null}
    </div>
  )
}
