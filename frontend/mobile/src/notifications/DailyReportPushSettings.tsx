import { Text } from 'react-native'
import { sendHourLabel } from '@govbiz/shared/domain/entities/DailyReport'
import { Button, Notice, styles } from '../ui'
import { useDailyReportPush } from './DailyReportPushProvider'

export function DailyReportPushSettings({ hasCompany }: { hasCompany: boolean }) {
  const { settings, busy, error, refresh, toggle } = useDailyReportPush()
  return <>
    <Text style={styles.heading}>앱 알림</Text>
    <Text style={styles.muted}>맞춤 리포트와 관심 공고 마감 알림(앱 알림을 고른 경우)을 이 기기로 받아요. 이메일 수신과 별도로 설정할 수 있어요.</Text>
    {settings && <Button label={settings.enabled ? '이 기기 앱 알림 끄기' : '이 기기 앱 알림 켜기'}
      variant="secondary" busy={busy} disabled={busy || (!settings.enabled && (!settings.available || !hasCompany))}
      onPress={() => void toggle()} />}
    {settings && !settings.available && <Notice>앱 알림 발송을 준비 중이에요.</Notice>}
    {settings && !settings.schedulerEnabled && <Notice>정기 리포트 예약이 꺼져 있어요.</Notice>}
    {settings && !hasCompany && <Notice>기업 정보를 등록하면 앱 알림을 켤 수 있어요.</Notice>}
    {settings?.enabled && <Text style={styles.muted}>서울 시간 {sendHourLabel(settings.sendHour)} 이후 생성되는 리포트를 알려드려요.</Text>}
    {error && <Notice error>{error}</Notice>}
    {(!settings || error) && <Button label="앱 알림 설정 다시 확인" variant="ghost" busy={busy} onPress={refresh} />}
  </>
}
