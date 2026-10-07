import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { BrowseSupportProgramsUseCase } from '@govbiz/shared/domain/usecases/BrowseSupportProgramsUseCase'
import { catalogSourceCodes, catalogSourceLabels, type SupportProgramCatalog, type SupportProgramCatalogFilters } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { defaultCatalogApplicantTypes, defaultCatalogCategories, defaultCatalogFounderAges, defaultCatalogRegions,
  defaultCatalogStartupStages, mergeCatalogFilterOptions } from '@govbiz/shared/domain/entities/SupportProgramCatalogFilterOptions'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import { programStatusLabels } from '@govbiz/shared/domain/labels'
import { errorMessage, programClient } from '../api/client'
import { AppIcon } from '../components/AppIcon'
import { ChoiceField } from '../components/ChoiceField'
import { FilterMultiChoices } from '../components/FilterMultiChoices'
import { PartnerSheet } from '../components/PartnerSheet'
import { ProgramCard, type ProgramSelectionLabels } from '../components/ProgramCard'
import { Button, Field, Notice, Page, colors, styles } from '../ui'

export const initialFilters: SupportProgramCatalogFilters = {
  keyword: '', region: '', category: '', sourceCode: '', startupStage: '', applicantType: '', founderAge: '',
  status: 'OPEN', sort: 'RECENT', page: 1, pageSize: 12,
}
const split = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean)
const options = (defaults: readonly string[], available?: readonly string[]) =>
  [{ value: '', label: '전체' }, ...mergeCatalogFilterOptions(defaults, available).map(value => ({ value, label: value }))]
const statusOptions = [{ value: 'ALL', label: '전체 접수 상태' }, ...Object.entries(programStatusLabels).map(([value, label]) => ({ value, label }))]
const sortOptions = [{ value: 'RECENT', label: '최신순' }, { value: 'DEADLINE', label: '마감일순' }] as const

export function CatalogScreen({ onOpenProgram, keyboardOffset = 0, selection, header }: {
  onOpenProgram(identity: SupportProgramIdentity): void; keyboardOffset?: number; header?: ReactNode
  selection?: { keys: string[]; disabled?: boolean; maximum?: number; labels?: ProgramSelectionLabels; onToggle(program: SupportProgram): void }
}) {
  const defaults = { ...initialFilters, status: selection ? 'ALL' as const : initialFilters.status }
  const [keyword, setKeyword] = useState('')
  const [applied, setApplied] = useState(defaults)
  const [catalog, setCatalog] = useState<SupportProgramCatalog | null>(null)
  const available = useRef<SupportProgramCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  const regions = split(applied.region), categories = split(applied.category)
  const activeConditions = [
    ...regions.map(value => ({ key: 'region' as const, value, label: value })),
    ...categories.map(value => ({ key: 'category' as const, value, label: value })),
    ...(applied.sourceCode ? [{ key: 'sourceCode' as const, value: applied.sourceCode, label: catalogSourceLabels[applied.sourceCode] }] : []),
    ...(applied.status !== defaults.status ? [{ key: 'status' as const, value: applied.status, label: statusOptions.find(item => item.value === applied.status)!.label }] : []),
    ...(['startupStage', 'applicantType', 'founderAge'] as const).filter(key => applied[key]).map(key => ({ key, value: applied[key], label: applied[key] })),
  ]
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true); setError(null); setCatalog(null)
    const timeout = setTimeout(() => controller.abort(), 15_000)
    Promise.resolve().then(() => new BrowseSupportProgramsUseCase({ browseCatalog: programClient().browseCatalog }).execute(applied, controller.signal))
      .then(result => { if (active && !controller.signal.aborted) { available.current = result; setCatalog(result) } })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)) })
      .finally(() => { clearTimeout(timeout); if (active) setLoading(false) })
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [applied, retry])
  function apply(filters: SupportProgramCatalogFilters) {
    setApplied(previous => JSON.stringify(previous) === JSON.stringify(filters) ? previous : filters)
  }
  function change<K extends keyof SupportProgramCatalogFilters>(key: K, value: SupportProgramCatalogFilters[K]) {
    apply({ ...applied, [key]: value, page: 1,
      ...(key === 'sourceCode' && value !== 'KSTARTUP' ? { startupStage: '', applicantType: '', founderAge: '' } : {}) })
  }
  function toggle(key: 'region' | 'category', value: string) {
    const selected = split(applied[key])
    change(key, (selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]).join(','))
  }
  function clearCondition(item: typeof activeConditions[number]) {
    if (item.key === 'region' || item.key === 'category') toggle(item.key, item.value)
    else if (item.key === 'status') change('status', defaults.status)
    else if (item.key === 'sourceCode') change('sourceCode', '')
    else change(item.key, '')
  }
  function reset() { setKeyword(''); apply({ ...defaults }) }
  const cached = available.current
  const periodMissing = applied.sourceCode === 'MSIT' || applied.sourceCode === 'CNTRADE_NOTICE'
  return <Page keyboardOffset={keyboardOffset}>
    {header}
    <View style={local.search}><View style={local.keyword}>
      <Field label="공고명·기관명" value={keyword} onChangeText={setKeyword} maxLength={100} placeholder="공고명 또는 기관명"
        returnKeyType="search" onSubmitEditing={() => apply({ ...applied, keyword: keyword.trim(), page: 1 })} />
    </View><Pressable accessibilityRole="button" accessibilityLabel="공고 필터 열기" accessibilityState={{ expanded: filterOpen }}
      onPress={() => setFilterOpen(true)} style={local.filterButton}><AppIcon name="filter" color={colors.primary} size={19} />
      <Text style={local.filterText}>필터{activeConditions.length ? ` ${activeConditions.length}` : ''}</Text></Pressable></View>
    {keyword.trim() !== applied.keyword && <Text style={styles.muted}>검색어는 키보드의 검색을 눌러 적용해 주세요.</Text>}
    <View testID="catalog-condition-summary" style={local.conditions}>
      {applied.keyword ? <Button label={`검색어: ${applied.keyword} ×`} size="small" variant="secondary" onPress={() => { setKeyword(''); change('keyword', '') }} /> : null}
      {activeConditions.map(item => <Button key={`${item.key}:${item.value}`} accessibilityLabel={`${item.label} 조건 해제`}
        label={`${item.label} ×`} size="small" variant="secondary" onPress={() => clearCondition(item)} />)}
    </View>
    <View style={local.results}><Text accessibilityLiveRegion="polite" style={styles.heading}>검색 결과 {loading || error ? '—' : catalog?.total.toLocaleString() ?? '—'}건</Text>
      <View style={local.sort}><ChoiceField label="정렬" value={applied.sort} options={sortOptions}
        onChange={value => change('sort', value as SupportProgramCatalogFilters['sort'])} /></View></View>
    {loading && <ActivityIndicator accessibilityLabel="공고를 불러오는 중" color={colors.primary} />}
    {error && <><Notice error>{error}</Notice><Button label="다시 불러오기" onPress={() => setRetry(value => value + 1)} /></>}
    {!loading && !error && catalog && <>
      {catalog.programs.length === 0 && <Notice>조건에 맞는 공고가 없습니다. 검색 조건을 바꿔 보세요.</Notice>}
      {catalog.programs.map(program => {
        const selected = selection?.keys.includes(`${program.sourceCode}:${program.id}`) ?? false
        return <ProgramCard key={JSON.stringify([program.sourceCode, program.id])} program={program} onOpen={onOpenProgram}
          selection={selection ? { selected, labels: selection.labels, disabled: Boolean(selection.disabled || (!selected && selection.keys.length >= (selection.maximum ?? 2))), onToggle: () => selection.onToggle(program) } : undefined} />
      })}
      {catalog.totalPages > 0 && <View style={styles.row}>
        <Button label="이전" variant="secondary" disabled={applied.page <= 1} onPress={() => apply({ ...applied, page: applied.page - 1 })} />
        <Text style={styles.body}>{catalog.page} / {catalog.totalPages}</Text>
        <Button label="다음" variant="secondary" disabled={applied.page >= catalog.totalPages} onPress={() => apply({ ...applied, page: applied.page + 1 })} />
      </View>}
    </>}
    <PartnerSheet visible={filterOpen} title="공고 검색 필터" onClose={() => setFilterOpen(false)} actions={<>
      <Button label="초기화" variant="secondary" onPress={reset} />
      <Button label={loading ? '결과 조회 중' : error ? '결과 확인하기' : `결과 ${catalog?.total.toLocaleString() ?? '—'}건 보기`}
        disabled={loading} onPress={() => setFilterOpen(false)} />
    </>}>
      <FilterMultiChoices label="지역" selected={regions} options={mergeCatalogFilterOptions(defaultCatalogRegions, [...(cached?.regions ?? []), ...regions])}
        onToggle={value => toggle('region', value)} onClear={() => change('region', '')} />
      <FilterMultiChoices label="분야" selected={categories} options={mergeCatalogFilterOptions(defaultCatalogCategories, [...(cached?.categories ?? []), ...categories])}
        onToggle={value => toggle('category', value)} onClear={() => change('category', '')} />
      <ChoiceField label="출처" value={applied.sourceCode} options={catalogSourceCodes.map(value => ({ value, label: catalogSourceLabels[value] }))}
        onChange={value => change('sourceCode', value as SupportProgramCatalogFilters['sourceCode'])} />
      <ChoiceField label="접수 상태" value={applied.status} options={statusOptions} onChange={value => change('status', value as SupportProgramCatalogFilters['status'])} />
      {periodMissing && <Notice>접수 기간을 제공하지 않는 공고는 상태 확인 필요에 표시됩니다. 전체 접수 상태 또는 상태 확인 필요로 검색해 주세요.</Notice>}
      {applied.sourceCode === 'KSTARTUP' && <>
        <Text style={styles.heading}>K-Startup 추가 조건</Text>
        <ChoiceField label="창업 업력" value={applied.startupStage} options={options(defaultCatalogStartupStages, cached?.startupStages)} onChange={value => change('startupStage', value)} />
        <ChoiceField label="신청 대상" value={applied.applicantType} options={options(defaultCatalogApplicantTypes, cached?.applicantTypes)} onChange={value => change('applicantType', value)} />
        <ChoiceField label="대표자 연령" value={applied.founderAge} options={options(defaultCatalogFounderAges, cached?.founderAges)} onChange={value => change('founderAge', value)} />
      </>}
      {error && <Notice error>{error}</Notice>}
      <Text style={styles.muted}>공고 분류 기준입니다. 실제 신청 자격은 공고 원문에서 확인해 주세요.</Text>
      {selection && <Text style={styles.muted}>공고 상세 조회와 작성·비교 대상 선택은 별도 동작입니다.</Text>}
    </PartnerSheet>
  </Page>
}
const local = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'flex-end', gap: 9 }, keyword: { flex: 1, minWidth: 0 },
  filterButton: { minHeight: 48, paddingHorizontal: 13, borderRadius: 24, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', gap: 6 }, filterText: { fontSize: 14, color: colors.primary },
  conditions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, results: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sort: { marginLeft: 'auto', minWidth: 108 },
})
