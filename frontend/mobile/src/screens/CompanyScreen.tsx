import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { businessLookupDtoSchema, companyDtoSchema, toBusinessLookup, toCompany } from '@govbiz/shared/data/models/CompanyDto'
import {
  type BusinessLookup, type Company, type CompanyProfileInput, companyRegions, companyIndustries,
  companyProfileLimits, formatBusinessNumber, formatBusinessNumberInput, isValidBusinessNumber,
  normalizeBusinessNumber, normalizeHomepageUrl, isValidHomepageUrl,
} from '@govbiz/shared/domain/entities/Company'
import { apiRequest, ApiError, errorMessage } from '../api/client'
import { useAuth } from '../auth/session'
import { Page, Button, Field, Notice, Card, Title, colors, styles } from '../ui'

type CompanyState = { token: string | null; company: Company | null; loading: boolean; loadError: string | null }

export function CompanyScreen() {
  const { session, status, refreshSession, invalidateSession } = useAuth()
  const token = session?.accessToken ?? null
  const [state, setState] = useState<CompanyState>({ token: null, company: null, loading: true, loadError: null })
  const [revision, setRevision] = useState(0)
  const [businessNumber, setBusinessNumber] = useState('')
  const [lookup, setLookup] = useState<BusinessLookup | null>(null)
  const [region, setRegion] = useState('')
  const [industry, setIndustry] = useState('')
  const [foundedYear, setFoundedYear] = useState('')
  const [homepage, setHomepage] = useState('')
  const [selection, setSelection] = useState<'region' | 'industry' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mutation = useRef<AbortController | null>(null)

  function populate(company: Company | null) {
    setRegion(company?.region ?? ''); setIndustry(company?.industry ?? ''); setFoundedYear(company ? String(company.foundedYear) : ''); setHomepage(company?.homepageUrl ?? '')
    setBusinessNumber(company ? formatBusinessNumber(company.businessNumber) : '')
    setLookup(null); setSelection(null)
  }

  useEffect(() => {
    const controller = new AbortController()
    mutation.current?.abort()
    setState({ token, company: null, loading: true, loadError: null })
    populate(null); setError(null); setNotice(null); setBusy(false)
    if (token) void apiRequest('/api/v1/me/company', { accessToken: token, signal: controller.signal }).then((payload) => {
      const company = toCompany(companyDtoSchema.parse(payload))
      if (controller.signal.aborted) return
      populate(company)
      setState({ token, company, loading: false, loadError: null })
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      if (failure instanceof ApiError && failure.status === 404 && failure.code === 'COMPANY_NOT_REGISTERED') {
        setState({ token, company: null, loading: false, loadError: null }); return
      }
      if (failure instanceof ApiError && failure.status === 401) void invalidateSession().catch(() => undefined)
      setState({ token, company: null, loading: false, loadError: errorMessage(failure) })
    })
    return () => { controller.abort(); mutation.current?.abort() }
  }, [token, revision, invalidateSession])

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (!token || busy) return
    const controller = new AbortController()
    mutation.current?.abort(); mutation.current = controller
    setBusy(true); setError(null); setNotice(null)
    try { await action(controller.signal) } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof ApiError && failure.status === 401) void invalidateSession().catch(() => undefined)
      setError(failure instanceof ApiError ? companyError(failure) : failure instanceof Error ? failure.message : errorMessage(failure))
    } finally {
      if (mutation.current === controller) setBusy(false)
    }
  }

  const lookupBusiness = () => run(async (signal) => {
    if (!isValidBusinessNumber(businessNumber)) throw new Error('사업자등록번호 10자리를 입력해 주세요.')
    setLookup(null)
    const query = new URLSearchParams({ businessNumber: normalizeBusinessNumber(businessNumber) })
    const result = toBusinessLookup(businessLookupDtoSchema.parse(await apiRequest(`/api/v1/me/company/lookup?${query}`, { accessToken: token!, signal })))
    if (signal.aborted) return
    setLookup(result)
    if (!result.isActive) setError('현재 영업 중인 사업자만 등록할 수 있습니다.')
  })

  const saveCompany = () => run(async (signal) => {
    const company = state.company
    if (!company && (!lookup?.isActive || lookup.businessNumber !== normalizeBusinessNumber(businessNumber))) throw new Error('사업자등록번호 조회를 먼저 완료해 주세요.')
    if (!companyRegions.some((value) => value === region)) throw new Error('기업 소재지를 선택해 주세요.')
    if (!companyIndustries.some((value) => value === industry)) throw new Error('기업 업종을 선택해 주세요.')
    const year = Number(foundedYear)
    if (!/^\d{4}$/.test(foundedYear) || !Number.isInteger(year) || year < companyProfileLimits.foundedYearMin || year > new Date().getFullYear()) throw new Error(`설립연도는 ${companyProfileLimits.foundedYearMin}년부터 올해까지 입력해 주세요.`)
    const normalizedHomepage = normalizeHomepageUrl(homepage)
    if (normalizedHomepage && !isValidHomepageUrl(normalizedHomepage)) throw new Error('올바른 홈페이지 주소를 입력해 주세요.')
    const profile: CompanyProfileInput = { region, industry, foundedYear: year, homepageUrl: normalizedHomepage || null }
    const body = company ? profile : { businessNumber: lookup!.businessNumber, ...profile }
    const saved = toCompany(companyDtoSchema.parse(await apiRequest('/api/v1/me/company', { method: company ? 'PUT' : 'POST', accessToken: token!, body, signal })))
    if (signal.aborted) return
    populate(saved)
    setState({ token, company: saved, loading: false, loadError: null })
    setNotice('기업 프로필을 저장했습니다.')
    await refreshSession()
  })

  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice><Button label="다시 확인" onPress={() => void refreshSession()} /></Page>
  if (!token) return <Page><Title>기업 프로필</Title><Notice>내 정보 탭에서 로그인한 뒤 기업 정보를 등록해 주세요.</Notice></Page>
  if (state.token !== token || state.loading) return <Page><ActivityIndicator accessibilityLabel="기업 프로필 불러오는 중" /></Page>
  if (state.loadError) return <Page><Title>기업 프로필</Title><Notice error>{state.loadError}</Notice><Button label="다시 불러오기" onPress={() => setRevision((value) => value + 1)} /></Page>
  return <Page>
    <Title>{state.company ? '기업 프로필' : '기업 등록'}</Title>
    <Text style={styles.muted}>웹과 앱에서 같은 기업 정보를 사용합니다.</Text>
    {state.company ? <Card><Text style={styles.heading}>{state.company.companyName}</Text><Text style={styles.body}>{formatBusinessNumber(state.company.businessNumber)} · {state.company.businessStatus}</Text></Card> : <>
      <Field label="사업자등록번호" value={businessNumber} onChangeText={(value) => { setBusinessNumber(formatBusinessNumberInput(value)); setLookup(null); setError(null) }} keyboardType="number-pad" maxLength={12} editable={!busy} />
      <Button label="사업자 정보 조회" onPress={() => void lookupBusiness()} busy={busy} variant="secondary" />
      {lookup && <Card><Text style={styles.heading}>{lookup.companyName}</Text><Text style={styles.body}>{lookup.businessStatus}</Text></Card>}
    </>}
    <Text style={styles.label}>소재지</Text>
    <Button label={region || '소재지를 선택해 주세요'} variant="secondary" disabled={busy} onPress={() => setSelection(selection === 'region' ? null : 'region')} />
    {selection === 'region' && <Choices values={companyRegions} selected={region} onSelect={(value) => { setRegion(value); setSelection(null) }} />}
    <Text style={styles.label}>업종</Text>
    <Button label={industry || '업종을 선택해 주세요'} variant="secondary" disabled={busy} onPress={() => setSelection(selection === 'industry' ? null : 'industry')} />
    {selection === 'industry' && <Choices values={companyIndustries} selected={industry} onSelect={(value) => { setIndustry(value); setSelection(null) }} />}
    <Field label="설립연도" value={foundedYear} onChangeText={(value) => setFoundedYear(value.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" maxLength={4} editable={!busy} placeholder="예: 2020" />
    <Field label="홈페이지 (선택)" value={homepage} onChangeText={setHomepage} keyboardType="url" autoCapitalize="none" autoCorrect={false} maxLength={companyProfileLimits.homepageMaxLength} editable={!busy} placeholder="https://example.com" />
    {error && <Notice error>{error}</Notice>}
    {notice && <Notice>{notice}</Notice>}
    <Button label={state.company ? '기업 정보 저장' : '기업 등록'} onPress={() => void saveCompany()} busy={busy} disabled={!state.company && !lookup?.isActive} />
  </Page>
}

function Choices({ values, selected, onSelect }: { values: readonly string[]; selected: string; onSelect(value: string): void }) {
  return <View style={{ gap: 4 }}>{values.map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: selected === value }} onPress={() => onSelect(value)} style={{ padding: 14, borderRadius: 10, backgroundColor: selected === value ? colors.soft : colors.surface }}><Text style={styles.body}>{value}</Text></Pressable>)}</View>
}

function companyError(error: ApiError): string {
  if (error.status === 409) return '이미 등록된 기업 정보가 있습니다. 프로필을 다시 불러와 주세요.'
  if (error.status === 422) return '사업자 정보 또는 입력값을 확인해 주세요. 영업 중인 사업자만 등록할 수 있습니다.'
  if (error.status === 503) return '사업자 정보 조회 서비스를 이용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.'
  return error.message
}
