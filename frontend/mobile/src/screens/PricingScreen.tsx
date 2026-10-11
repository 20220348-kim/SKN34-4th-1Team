import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { pricingFrequentlyAskedQuestions, pricingPlans, pricingSearchSteps, pricingTitle, pricingUnlimitedNote,
  type PricingPlanId } from '@govbiz/shared/design/pricingContent'
import { planEndsText, planUsageResetText, type PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { SegmentedControl } from '../components/SegmentedControl'
import { Button, Page, StatusBadge, colors } from '../ui'

const planOptions = pricingPlans.map(plan => ({ value: plan.id, label: plan.name }))

/**
 * 웹과 같은 요금제별 한도와 가격을 안내합니다. 앱에는 결제·요금제 바꾸기·체험 시작 동작을 두지 않고(App Store 3.1.3)
 * 현재 플랜을 먼저 열고 이용·체험 상태와 서버 종료일을 표시합니다. 비로그인에게는 플러스를 추천합니다.
 */
export function PricingScreen({ onSearch, signedIn = false, usage = null, loading = false, failed = false, onRetry, onAccount }: {
  onSearch(): void; signedIn?: boolean; usage?: PlanUsage | null; loading?: boolean; failed?: boolean
  onRetry?(): void; onAccount?(): void
}) {
  const [selected, setSelected] = useState<PricingPlanId>(() => pricingPlans.find(item => item.code === usage?.plan)?.id ?? 'plus')
  const selectedByUser = useRef(false)
  const initializedPlan = useRef(Boolean(usage?.plan))
  const [compareOpen, setCompareOpen] = useState(false)
  const [openQuestions, setOpenQuestions] = useState<number[]>([])
  const plan = pricingPlans.find(item => item.id === selected)!
  const currentPlan = signedIn && !failed ? usage?.plan : null
  const isCurrent = plan.code === currentPlan
  const emphasized = signedIn ? isCurrent : plan.isFeatured
  const currentStatus = usage?.planSource === 'TRIAL' && currentPlan !== 'FREE' ? '체험 중' : '이용 중'
  const trial = isCurrent && currentStatus === '체험 중'
  const endsText = isCurrent ? planEndsText(usage) : null
  const usageWindow = isCurrent ? usage?.items.find(item => item.period === 'PLAN') : null
  const footerNote = isCurrent && currentPlan !== 'FREE'
    ? endsText ?? (trial ? '체험 종료일을 확인할 수 없어요.' : '현재 요금제로 이용하고 있어요.') : plan.footerNote
  useEffect(() => {
    if (!currentPlan || initializedPlan.current) return
    initializedPlan.current = true
    if (!selectedByUser.current) setSelected(pricingPlans.find(item => item.code === currentPlan)!.id)
  }, [currentPlan])
  function choose(id: PricingPlanId) { selectedByUser.current = true; setSelected(id); setCompareOpen(false) }
  function toggleQuestion(index: number) {
    setOpenQuestions(previous => previous.includes(index) ? previous.filter(item => item !== index) : [...previous, index])
  }
  return <Page>
    <View style={local.hero}>
      <Text style={local.eyebrow}>GOVBIZ PLANS</Text>
      <Text accessibilityRole="header" style={local.title}>{pricingTitle}</Text>
      <Text style={local.description}>요금제별 한도와 현재 이용 상태를 확인하세요.</Text>
    </View>
    {signedIn && <View style={local.memberStatus}>
      {loading && <Text accessibilityLiveRegion="polite" style={local.description}>
        {usage ? '이용 상태를 다시 확인하고 있어요. 아래는 이전에 확인한 정보예요.' : '현재 요금제를 확인하고 있어요.'}
      </Text>}
      {failed && <>
        <Text accessibilityLiveRegion="polite" style={local.error}>현재 요금제를 불러오지 못했어요.</Text>
        {onRetry && <Button label="다시 불러오기" variant="secondary" size="small" onPress={onRetry} />}
      </>}
      {onAccount && <Button label="내 계정에서 이용량 보기" variant="secondary" size="small" onPress={onAccount} />}
    </View>}
    <SegmentedControl label="요금제 선택" options={planOptions} value={selected} onChange={choose} />
    <View accessibilityLiveRegion="polite" style={[local.plan, emphasized && local.featured, isCurrent && local.current]}>
      <View style={local.planTop}>
        <Text style={local.planLabel}>{plan.label}</Text>
        {isCurrent && <StatusBadge label={currentStatus} tone="success" />}
      </View>
      <Text accessibilityRole="header" style={local.planTitle}>{plan.name}</Text>
      <Text style={local.description}>{plan.description}</Text>
      <View style={local.priceBlock}>
        <View style={local.priceRow}>
          <Text style={local.price}>{plan.price}</Text>
          {plan.pricePeriod && <Text style={local.pricePeriod}>{plan.pricePeriod}</Text>}
        </View>
        <Text style={local.priceNote}>{trial ? `30일 이용권 기준 가격 · ${plan.priceNote}` : plan.priceNote}</Text>
      </View>
      <View style={local.features}>
        {plan.limits.map(limit => <View key={limit} style={local.feature}>
          <Text accessible={false} style={local.featureCheck}>✓</Text>
          <Text style={local.featureText}>{limit}</Text>
        </View>)}
      </View>
      {plan.code === 'FREE' && <Button label="무료로 지원사업 찾기" onPress={onSearch} style={local.planButton} />}
      <Text style={local.footerNote}>{footerNote}</Text>
      {usageWindow && <Text style={local.footerNote}>이용량: {planUsageResetText(usageWindow)}</Text>}
    </View>
    <Text style={local.releaseNote}>{pricingUnlimitedNote}</Text>
    <View style={local.compare}>
      <Pressable accessibilityRole="button" accessibilityLabel="다른 요금제 한눈에 보기"
        accessibilityState={{ expanded: compareOpen }} onPress={() => setCompareOpen(previous => !previous)} style={local.accordion}>
        <Text style={local.accordionTitle}>다른 요금제 한눈에 보기</Text>
        <Text accessible={false} style={local.accordionMark}>{compareOpen ? '−' : '+'}</Text>
      </Pressable>
      {compareOpen && pricingPlans.map(item => <View key={item.id} style={local.compareRow}>
        <View style={local.flex}><Text style={local.compareName}>
          {item.name} · {item.price}{item.pricePeriod ? ` ${item.pricePeriod}` : ''}{item.code === currentPlan ? ` · ${currentStatus}` : ''}
        </Text>
          <Text style={local.footerNote}>{item.priceNote}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`${item.name} 상세 보기`} onPress={() => choose(item.id)} style={local.detailButton}>
          <Text style={local.detailLabel}>상세 보기</Text>
        </Pressable>
      </View>)}
    </View>
    <View style={local.section}>
      <Text accessibilityRole="header" style={local.sectionTitle}>찾고, 확인하고, 질문하세요</Text>
      <Text style={local.sectionDescription}>지원사업 탐색부터 신청 준비까지 이어서 이용하세요.</Text>
      {pricingSearchSteps.map(step => <View key={step.number} style={local.step}>
        <Text accessible={false} style={local.stepNumber}>{step.number}</Text>
        <View style={local.flex}><Text style={local.stepTitle}>{step.title}</Text><Text style={local.stepDescription}>{step.description}</Text></View>
      </View>)}
    </View>
    <View style={local.section}>
      <Text accessibilityRole="header" style={local.sectionTitle}>자주 묻는 질문</Text>
      <Text style={local.sectionDescription}>이용 전에 궁금한 점을 확인하세요.</Text>
      <View style={local.faqList}>
        {pricingFrequentlyAskedQuestions.map((faq, index) => {
          const expanded = openQuestions.includes(index)
          return <View key={faq.question} style={local.faq}>
            <Pressable accessibilityRole="button" accessibilityLabel={faq.question} accessibilityState={{ expanded }}
              onPress={() => toggleQuestion(index)} style={local.accordion}>
              <Text style={[local.accordionTitle, expanded && local.freeNote]}>{faq.question}</Text>
              <Text accessible={false} style={local.accordionMark}>{expanded ? '−' : '+'}</Text>
            </Pressable>
            {expanded && <Text style={local.faqAnswer}>{faq.answer}</Text>}
          </View>
        })}
      </View>
    </View>
  </Page>
}

const local = StyleSheet.create({
  flex: { flex: 1 },
  hero: { paddingTop: 10, gap: 9, paddingBottom: 4 },
  eyebrow: { color: colors.primaryText, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: colors.text, fontSize: 27, lineHeight: 37, fontWeight: '700', letterSpacing: -0.8 },
  description: { color: colors.muted, fontSize: 13, lineHeight: 23 },
  memberStatus: { gap: 8 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 23 },
  plan: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: 20, gap: 10 },
  featured: { borderColor: colors.primary },
  current: { borderWidth: 2, backgroundColor: colors.soft },
  planTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', minHeight: 24 },
  planLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  planTitle: { color: colors.text, fontSize: 22, lineHeight: 31, fontWeight: '700', marginTop: 2 },
  priceBlock: { marginTop: 6, gap: 6 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
  price: { color: colors.text, fontSize: 28, lineHeight: 37, fontWeight: '700', letterSpacing: -0.8 },
  pricePeriod: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  priceNote: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  freeNote: { color: colors.primaryText, fontWeight: '600' },
  features: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: 10, paddingTop: 16, gap: 10 },
  feature: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  featureCheck: { color: colors.primary, fontSize: 17, lineHeight: 23 },
  featureText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 23 },
  planButton: { borderRadius: 14, minHeight: 48, marginTop: 8 },
  footerNote: { color: colors.muted, fontSize: 11, lineHeight: 20 },
  releaseNote: { color: colors.muted, fontSize: 11, lineHeight: 20, paddingHorizontal: 2 },
  compare: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  accordion: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  accordionTitle: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600', lineHeight: 23 },
  accordionMark: { color: colors.muted, fontSize: 19, lineHeight: 25 },
  compareRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingVertical: 10 },
  compareName: { color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 24 },
  detailButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  detailLabel: { color: colors.primaryText, fontSize: 12, fontWeight: '600' },
  section: { gap: 8, marginTop: 18 },
  sectionTitle: { color: colors.text, fontSize: 19, lineHeight: 28, fontWeight: '700', letterSpacing: -0.4 },
  sectionDescription: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  step: { flexDirection: 'row', gap: 11, marginTop: 8 },
  stepNumber: { color: colors.primaryText, fontSize: 12, lineHeight: 24, fontWeight: '700' },
  stepTitle: { color: colors.text, fontSize: 13, lineHeight: 23, fontWeight: '600' },
  stepDescription: { color: colors.muted, fontSize: 12, lineHeight: 22 },
  faqList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: 7 },
  faq: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  faqAnswer: { color: colors.muted, fontSize: 12, lineHeight: 23, paddingBottom: 16 },
})
