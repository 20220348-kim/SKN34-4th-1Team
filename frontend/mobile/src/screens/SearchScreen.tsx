import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { SegmentedControl } from '../components/SegmentedControl'
import { colors } from '../ui'
import { CatalogScreen } from './CatalogScreen'
import { ChatScreen } from './ChatScreen'

export type SearchMode = 'ai' | 'filter'
const modes = [{ value: 'ai', label: 'AI 검색' }, { value: 'filter', label: '필터 검색' }] as const

export function SearchScreen({ mode, onModeChange, onOpenProgram, onLogin }: {
  mode: SearchMode; onModeChange(mode: SearchMode): void
  onOpenProgram(identity: SupportProgramIdentity): void; onLogin(): void
}) {
  const [visited, setVisited] = useState<Record<SearchMode, boolean>>({ ai: mode === 'ai', filter: mode === 'filter' })
  const [controlHeight, setControlHeight] = useState(0)
  useEffect(() => { setVisited((previous) => previous[mode] ? previous : { ...previous, [mode]: true }) }, [mode])

  // Mount a search only on first visit, then keep its input, results and scroll view alive.
  // Hidden search panels must not be reachable by touch or screen readers.
  return <View style={local.page}>
    <View style={local.header} onLayout={(event) => setControlHeight(event.nativeEvent.layout.height)}><View style={local.control}>
      <SegmentedControl label="검색 방식" options={modes} value={mode} onChange={onModeChange} />
    </View></View>
    {modes.map(({ value, label }) => (visited[value] || mode === value) && <View key={value}
      testID={`search-panel-${value}`} accessibilityLabel={label}
      accessibilityElementsHidden={mode !== value} importantForAccessibility={mode === value ? 'auto' : 'no-hide-descendants'}
      pointerEvents={mode === value ? 'auto' : 'none'} style={[local.panel, mode !== value && local.hidden]}>
      {value === 'ai' ? <ChatScreen onOpenProgram={onOpenProgram} onLogin={onLogin} keyboardOffset={controlHeight} />
        : <CatalogScreen onOpenProgram={onOpenProgram} keyboardOffset={controlHeight} />}
    </View>)}
  </View>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: { backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  control: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, width: '100%', maxWidth: 720, alignSelf: 'center' },
  panel: { flex: 1 },
  hidden: { display: 'none' },
})
