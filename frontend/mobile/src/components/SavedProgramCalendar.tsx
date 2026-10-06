import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { Button, Card, Notice, colors, styles } from '../ui'
import { ChoiceField } from './ChoiceField'
import { preparationKey } from './PreparationRows'
import { buildSavedCalendar, firstSavedCalendarYear, lastSavedCalendarYear, moveSavedCalendarMonth, savedCalendarMonth, type SavedCalendarMonth } from './savedProgramPresentation'

/** 관심 공고의 접수 시작·마감 일정을 네이티브 월별 달력과 날짜별 목록으로 표시합니다. */
export function SavedProgramCalendar({ items, month, today, ready, loading, onMonthChange, onOpenProgram }: {
  items: readonly SavedSupportProgram[]; month: SavedCalendarMonth; today: string; ready: boolean; loading: boolean
  onMonthChange(value: SavedCalendarMonth): void; onOpenProgram(identity: SupportProgramIdentity): void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const weeks = buildSavedCalendar(month, items)
  const monthKey = `${month.year}-${String(month.month).padStart(2, '0')}`
  const selectedDate = selected?.startsWith(`${monthKey}-`) ? selected : null
  const events = weeks.flat().find(day => day.key === selectedDate)?.events ?? []
  const eventCount = weeks.flat().reduce((total, day) => total + day.events.length, 0)
  const years = Array.from({ length: lastSavedCalendarYear - firstSavedCalendarYear + 1 }, (_, index) => firstSavedCalendarYear + index)
  const move = (amount: number) => { setSelected(null); onMonthChange(moveSavedCalendarMonth(month, amount)) }
  return <View style={{ gap: 12 }}>
    <View style={styles.row}><Button label="이전 달" variant="secondary" size="small" disabled={month.year === firstSavedCalendarYear && month.month === 1} onPress={() => move(-1)} />
      <Text accessibilityRole="header" style={[styles.heading, { flex: 1, textAlign: 'center' }]}>{month.year}년 {month.month}월</Text>
      <Button label="다음 달" variant="secondary" size="small" disabled={month.year === lastSavedCalendarYear && month.month === 12} onPress={() => move(1)} /></View>
    <View style={styles.row}><View style={{ flex: 1 }}><ChoiceField label="달력 연도" value={String(month.year)}
      options={years.map(year => ({ value: String(year), label: `${year}년` }))} onChange={value => { setSelected(null); onMonthChange({ ...month, year: Number(value) }) }} /></View>
      <View style={{ flex: 1 }}><ChoiceField label="달력 월" value={String(month.month)} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `${index + 1}월` }))}
        onChange={value => { setSelected(null); onMonthChange({ ...month, month: Number(value) }) }} /></View></View>
    <Button label="오늘" variant="ghost" onPress={() => { onMonthChange(savedCalendarMonth(today)); setSelected(today) }} />
    {!ready ? loading ? <ActivityIndicator accessibilityLabel="관심 공고 일정 불러오는 중" color={colors.primary} />
      : <Notice>관심 공고 목록을 확인한 뒤 일정을 표시할 수 있어요.</Notice> : <>
      <Text accessibilityLiveRegion="polite" style={styles.muted}>이달의 접수 일정 {eventCount}건 · 날짜를 눌러 공고를 확인하세요.</Text>
      <Card><View style={local.week}>{['일', '월', '화', '수', '목', '금', '토'].map((label, index) => <Text key={label}
        style={[local.weekday, index === 0 && { color: colors.danger }]}>{label}</Text>)}</View>
        {weeks.map(week => <View key={week[0].key} style={local.week}>{week.map((day, index) => day.inMonth
          ? <Pressable key={day.key} accessibilityRole="button" accessibilityLabel={`${day.key} 접수 일정 ${day.events.length}건${day.key === today ? ' · 오늘' : ''}`}
            accessibilityState={{ selected: selectedDate === day.key }} onPress={() => setSelected(day.key)}
            style={[local.day, day.key === today && local.today, selectedDate === day.key && local.selected]}>
            <Text style={[styles.body, index === 0 && { color: colors.danger }]}>{day.day}</Text>
            {!!day.events.length && <Text style={local.count}>{day.events.length}건</Text>}</Pressable>
          : <View key={day.key} style={local.day}><Text style={styles.muted}>{day.day}</Text></View>)}</View>)}</Card>
      <Text style={styles.muted}>일정은 공고의 접수 시작일·마감일을 표시합니다. 날짜 정보가 없는 공고는 목록에서 확인해 주세요.</Text>
      {selectedDate && <View style={{ gap: 10 }}><Text accessibilityRole="header" style={styles.heading}>{selectedDate} 접수 일정</Text>
        {!events.length && <Notice>선택한 날짜에는 접수 일정이 없습니다.</Notice>}
        {events.map(({ item: { program }, type }) => <Card key={`${preparationKey({ sourceCode: program.sourceCode, sourceProgramId: program.id })}:${type}`}>
          <Text style={styles.label}>{type === 'START' ? '접수 시작' : type === 'END' ? '접수 마감' : '접수 시작·마감'}</Text>
          <Text style={styles.heading}>{program.title}</Text><Text style={styles.muted}>{program.organization} · {program.sourceName}</Text>
          <Button label={`${program.title} 상세 보기`} variant="secondary" onPress={() => onOpenProgram({ sourceCode: program.sourceCode, sourceProgramId: program.id })} />
        </Card>)}
      </View>}
    </>}
  </View>
}

const local = StyleSheet.create({
  week: { flexDirection: 'row' }, weekday: { flex: 1, textAlign: 'center', fontSize: 13, lineHeight: 24, color: colors.muted },
  day: { flex: 1, minHeight: 56, borderWidth: 1, borderColor: 'transparent', borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  today: { borderColor: colors.primary }, selected: { backgroundColor: colors.soft }, count: { fontSize: 11, color: colors.primaryText, lineHeight: 16 },
})
