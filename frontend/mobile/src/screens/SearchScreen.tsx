import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { SegmentedControl } from '../components/SegmentedControl'
import { colors } from '../ui'
import { CatalogScreen } from './CatalogScreen'
import { ChatScreen } from './ChatScreen'
import type { LoginRequest } from '../auth/loginFlow'
import { useSearchProgramInterests } from '../components/SearchProgramInterests'
import { Button, Notice } from '../ui'

export type SearchMode = 'ai' | 'filter'
const modes = [{ value: 'ai', label: 'AI 대화 검색' }, { value: 'filter', label: '필터 검색' }] as const

export function SearchScreen({ mode, headerHeight = 0, onModeChange, onOpenProgram, onLogin }: {
  mode: SearchMode; headerHeight?: number; onModeChange(mode: SearchMode): void
  onOpenProgram(identity: SupportProgramIdentity): void; onLogin(request?: LoginRequest): void
}) {
  const [visited, setVisited] = useState<Record<SearchMode, boolean>>({ ai: mode === 'ai', filter: mode === 'filter' })
  const [controlHeight, setControlHeight] = useState(0)
  const interests = useSearchProgramInterests()
  useEffect(() => { setVisited((previous) => previous[mode] ? previous : { ...previous, [mode]: true }) }, [mode])

  // Mount a search only on first visit, then keep its input, results and scroll view alive.
  // Hidden search panels must not be reachable by touch or screen readers.
  return <View style={local.page}>
    <View testID="search-mode-header" style={local.header} onLayout={(event) => setControlHeight(event.nativeEvent.layout.height)}><View style={local.control}>
      <SegmentedControl label="검색 방식" options={modes} value={mode} onChange={onModeChange} />
    </View></View>
    {interests.error && <View style={local.control}><Notice error>{interests.error}</Notice>
      <Button label="관심 상태 다시 확인" variant="secondary" onPress={interests.retry} /></View>}
    {modes.map(({ value, label }) => (visited[value] || mode === value) && <View key={value}
      testID={`search-panel-${value}`} accessibilityLabel={label}
      accessibilityElementsHidden={mode !== value} importantForAccessibility={mode === value ? 'auto' : 'no-hide-descendants'}
      pointerEvents={mode === value ? 'auto' : 'none'} style={[local.panel, mode !== value && local.hidden]}>
      {value === 'ai' ? <ChatScreen interests={interests} onOpenProgram={onOpenProgram} onLogin={onLogin} keyboardOffset={headerHeight + controlHeight} active={mode === 'ai'} />
        : <CatalogScreen interests={interests} onLogin={() => onLogin()} onOpenProgram={onOpenProgram} keyboardOffset={controlHeight} />}
    </View>)}
  </View>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface },
  header: { backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  control: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, width: '100%', maxWidth: 720, alignSelf: 'center' },
  panel: { flex: 1 },
  hidden: { display: 'none' },
})
