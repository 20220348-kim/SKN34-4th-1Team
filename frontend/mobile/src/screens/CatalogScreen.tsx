import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { BrowseSupportProgramsUseCase } from '@govbiz/shared/domain/usecases/BrowseSupportProgramsUseCase'
import { catalogSourceCodes, catalogSourceLabels, type SupportProgramCatalog, type SupportProgramCatalogFilters } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { regionNames } from '@govbiz/shared/domain/entities/Region'
import { supportProgramCategories } from '@govbiz/shared/domain/entities/SupportProgramCategory'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { errorMessage, programClient } from '../api/client'
import { ChoiceField } from '../components/ChoiceField'
import { ProgramCard } from '../components/ProgramCard'
import { Button, Card, Field, Notice, Page, Subtitle, Title, colors, styles } from '../ui'

export const initialFilters: SupportProgramCatalogFilters = {
  keyword: '', region: '', category: '', sourceCode: '', startupStage: '', applicantType: '', founderAge: '',
  status: 'OPEN', sort: 'RECENT', page: 1, pageSize: 12,
}

const options = (values: readonly string[]) => [{ value: '', label: '전체' }, ...[...new Set(values)].map((value) => ({ value, label: value }))]

export function CatalogScreen({ onOpenProgram }: { onOpenProgram: (identity: SupportProgramIdentity) => void }) {
  const [draft, setDraft] = useState(initialFilters)
  const [applied, setApplied] = useState(initialFilters)
  const [catalog, setCatalog] = useState<SupportProgramCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true); setError(null); setCatalog(null)
    const timeout = setTimeout(() => controller.abort(), 15_000)
    Promise.resolve().then(() => new BrowseSupportProgramsUseCase({ browseCatalog: programClient().browseCatalog }).execute(applied, controller.signal))
      .then((result) => { if (!controller.signal.aborted) setCatalog(result) })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)) })
      .finally(() => { clearTimeout(timeout); if (active) setLoading(false) })
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [applied, retry])

  function change<K extends keyof SupportProgramCatalogFilters>(key: K, value: SupportProgramCatalogFilters[K]) {
    setDraft((previous) => ({ ...previous, [key]: value,
      ...(key === 'sourceCode' && value !== 'KSTARTUP' ? { startupStage: '', applicantType: '', founderAge: '' } : {}) }))
  }

  return <Page>
    <View><Text style={[styles.label, { color: colors.primary, marginBottom: 8 }]}>GOVBIZ · 지원사업 찾기</Text><Title>우리 회사의 다음 기회</Title></View>
    <Subtitle>공고를 찾아 조건을 확인하고, 관심 있는 사업을 모아 보세요.</Subtitle>
    <Card>
      <Field label="공고명·기관명" value={draft.keyword} onChangeText={(value) => change('keyword', value)} maxLength={100}
        placeholder="예: 창업, 수출, 연구개발" returnKeyType="search" onSubmitEditing={() => setApplied({ ...draft, page: 1 })} />
      <Button label={expanded ? '상세 조건 접기' : '지역·분야·접수 조건'} variant="ghost" onPress={() => setExpanded(!expanded)} />
      {expanded && <>
        <ChoiceField label="지역" value={draft.region} options={options([...regionNames, ...(catalog?.regions ?? [])])} onChange={(value) => change('region', value)} />
        <ChoiceField label="분야" value={draft.category} options={options([...supportProgramCategories, ...(catalog?.categories ?? [])])} onChange={(value) => change('category', value)} />
        <ChoiceField label="출처" value={draft.sourceCode} options={catalogSourceCodes.map((value) => ({ value, label: catalogSourceLabels[value] }))}
          onChange={(value) => change('sourceCode', value as SupportProgramCatalogFilters['sourceCode'])} />
        <ChoiceField label="접수 상태" value={draft.status} options={[
          { value: 'ALL', label: '전체' }, { value: 'OPEN', label: '접수 중' }, { value: 'UPCOMING', label: '접수 예정' },
          { value: 'CLOSED', label: '마감' }, { value: 'UNKNOWN', label: '상태 미확인' },
        ]} onChange={(value) => change('status', value as SupportProgramCatalogFilters['status'])} />
        <ChoiceField label="정렬" value={draft.sort} options={[{ value: 'RECENT', label: '최신순' }, { value: 'DEADLINE', label: '마감일순' }]}
          onChange={(value) => change('sort', value as SupportProgramCatalogFilters['sort'])} />
        {draft.sourceCode === 'KSTARTUP' && <>
          <ChoiceField label="창업 업력" value={draft.startupStage} options={options(catalog?.startupStages.length ? catalog.startupStages : ['예비창업자', '1년미만', '3년미만', '5년미만', '7년미만', '10년미만'])} onChange={(value) => change('startupStage', value)} />
          <ChoiceField label="신청 대상" value={draft.applicantType} options={options(catalog?.applicantTypes.length ? catalog.applicantTypes : ['청소년', '대학생', '일반인', '대학', '연구기관', '일반기업', '1인 창조기업'])} onChange={(value) => change('applicantType', value)} />
          <ChoiceField label="대표자 연령" value={draft.founderAge} options={options(catalog?.founderAges.length ? catalog.founderAges : ['만 20세 미만', '만 20세 이상 ~ 만 39세 이하', '만 40세 이상'])} onChange={(value) => change('founderAge', value)} />
        </>}
        <Text style={styles.muted}>필터는 제공처의 공고 분류입니다. 실제 신청 자격은 공고 원문에서 확인해 주세요.</Text>
      </>}
      <Button label="공고 검색" onPress={() => { setApplied({ ...draft, page: 1 }); setExpanded(false) }} />
      <Button label="조건 초기화" variant="ghost" onPress={() => { setDraft(initialFilters); setApplied({ ...initialFilters }) }} />
    </Card>
    {loading && <ActivityIndicator accessibilityLabel="공고를 불러오는 중" color={colors.primary} />}
    {error && <><Notice error>{error}</Notice><Button label="다시 불러오기" onPress={() => setRetry((value) => value + 1)} /></>}
    {!loading && !error && catalog && <>
      <Text accessibilityLiveRegion="polite" style={styles.heading}>검색 결과 {catalog.total.toLocaleString()}건</Text>
      {catalog.programs.length === 0 && <Notice>조건에 맞는 공고가 없습니다. 검색 조건을 바꿔 보세요.</Notice>}
      {catalog.programs.map((program) => <ProgramCard key={JSON.stringify([program.sourceCode, program.id])} program={program} onOpen={onOpenProgram} />)}
      {catalog.totalPages > 0 && <View style={styles.row}>
        <Button label="이전" variant="secondary" disabled={applied.page <= 1} onPress={() => setApplied((value) => ({ ...value, page: value.page - 1 }))} />
        <Text style={styles.body}>{catalog.page} / {catalog.totalPages}</Text>
        <Button label="다음" variant="secondary" disabled={applied.page >= catalog.totalPages} onPress={() => setApplied((value) => ({ ...value, page: value.page + 1 }))} />
      </View>}
    </>}
  </Page>
}
