import { Switch, Text, View } from 'react-native'
import { sendHourLabel } from '@govbiz/shared/domain/entities/DailyReport'
import { Button, Notice, colors, styles } from '../ui'
import { useDailyReportPush } from './DailyReportPushProvider'

export function DailyReportPushSettings({ hasCompany }: { hasCompany: boolean }) {
  const { settings, busy, error, permissionDenied, refresh, toggle, openSystemSettings } = useDailyReportPush()
  const switchDisabled = busy || !settings || !settings.enabled && (permissionDenied || !settings.available || !hasCompany)
  return <>
    <Text style={styles.heading}>앱 알림</Text>
    <Text style={styles.muted}>맞춤 리포트와 관심 공고 마감 알림(앱 알림을 고른 경우)을 이 기기로 받아요. 이메일 수신과 별도로 설정할 수 있어요.</Text>
    {permissionDenied && <><Notice>이 기기에서 GovBiz 알림이 허용되지 않았어요. 기기 설정에서 허용한 뒤 돌아와 주세요.</Notice>
      <Button label="기기 설정 열기" variant="secondary" disabled={busy} onPress={() => void openSystemSettings()} /></>}
    {settings && <View style={[styles.row, { minHeight: 48 }]}><Text style={[styles.body, { flex: 1 }]}>이 기기 앱 알림</Text>
      <Switch accessibilityLabel={settings.enabled ? '이 기기 앱 알림 끄기' : '이 기기 앱 알림 켜기'} value={settings.enabled}
        accessibilityState={{ checked: settings.enabled, disabled: switchDisabled, busy }}
        disabled={switchDisabled}
        style={{ minWidth: 48, minHeight: 48 }}
        trackColor={{ false: colors.fieldBorder, true: colors.primary }} thumbColor={colors.surface} onValueChange={() => { if (!switchDisabled) void toggle() }} /></View>}
    {settings && !settings.available && <Notice>앱 알림 발송을 준비 중이에요.</Notice>}
    {settings && !settings.schedulerEnabled && <Notice>정기 리포트 예약이 꺼져 있어요.</Notice>}
    {settings && !hasCompany && <Notice>기업 정보를 등록하면 앱 알림을 켤 수 있어요.</Notice>}
    {settings?.enabled && <Text style={styles.muted}>서울 시간 {sendHourLabel(settings.sendHour)} 이후 생성되는 리포트를 알려드려요.</Text>}
    {error && <Notice error>{error}</Notice>}
    {(!settings || error) && <Button label="앱 알림 설정 다시 확인" variant="ghost" busy={busy} onPress={refresh} />}
  </>
}
