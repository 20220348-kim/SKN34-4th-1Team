import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { pricingFrequentlyAskedQuestions, pricingPlans, pricingSearchSteps, pricingTitle, pricingUnlimitedNote,
  type PricingPlanId } from '@govbiz/shared/design/pricingContent'
import type { PlanCode } from '@govbiz/shared/domain/entities/PlanUsage'
import { SegmentedControl } from '../components/SegmentedControl'
import { Button, Page, StatusBadge, colors } from '../ui'

const planOptions = pricingPlans.map(plan => ({ value: plan.id, label: plan.name }))

/**
 * 웹과 같은 요금제별 한도와 가격을 안내합니다. 앱에는 결제·요금제 바꾸기·체험 시작 동작을 두지 않고(App Store 3.1.3)
 * 무료 요금제의 검색 진입만 둡니다. 로그인해 [currentPlan]을 알면 그 요금제를 "이용 중"으로 강조하고, 모르면 추천 요금제(플러스)를 강조합니다.
 */
export function PricingScreen({ onSearch, currentPlan = null }: { onSearch(): void; currentPlan?: PlanCode | null }) {
  const [selected, setSelected] = useState<PricingPlanId>('plus')
  const [compareOpen, setCompareOpen] = useState(false)
  const [openQuestions, setOpenQuestions] = useState<number[]>([])
  const plan = pricingPlans.find(item => item.id === selected)!
  const isCurrent = plan.code === currentPlan
  const emphasized = currentPlan ? isCurrent : plan.isFeatured
  function choose(id: PricingPlanId) { setSelected(id); setCompareOpen(false) }
  function toggleQuestion(index: number) {
    setOpenQuestions(previous => previous.includes(index) ? previous.filter(item => item !== index) : [...previous, index])
  }
  return <Page>
    <View style={local.hero}>
      <Text style={local.eyebrow}>GOVBIZ PLANS</Text>
      <Text accessibilityRole="header" style={local.title}>{pricingTitle}</Text>
      <Text style={local.description}>지원사업 탐색부터 신청 준비까지{ '\n' }지금 무료로 시작하세요.</Text>
    </View>
    <View style={local.policy}>
      <Text accessible={false} style={local.policyCheck}>✓</Text>
      <View style={local.flex}>
        <Text style={local.policyTitle}>지금은 결제를 받지 않아요</Text>
        <Text style={local.policyText}>회원가입 후 무료 요금제로 바로 이용할 수 있어요.</Text>
      </View>
    </View>
    <SegmentedControl label="요금제 선택" options={planOptions} value={selected} onChange={choose} />
    <View accessibilityLiveRegion="polite" style={[local.plan, emphasized && local.featured, isCurrent && local.current]}>
      <View style={local.planTop}>
        <Text style={local.planLabel}>{plan.label}</Text>
        {isCurrent && <StatusBadge label="이용 중" tone="success" />}
      </View>
      <Text accessibilityRole="header" style={local.planTitle}>{plan.name}</Text>
      <Text style={local.description}>{plan.description}</Text>
      <View style={local.priceBlock}>
        <View style={local.priceRow}>
          <Text style={local.price}>{plan.price}</Text>
          {plan.pricePeriod && <Text style={local.pricePeriod}>{plan.pricePeriod}</Text>}
        </View>
        <Text style={local.priceNote}>{plan.priceNote}</Text>
      </View>
      <View style={local.features}>
        {plan.limits.map(limit => <View key={limit} style={local.feature}>
          <Text accessible={false} style={local.featureCheck}>✓</Text>
          <Text style={local.featureText}>{limit}</Text>
        </View>)}
      </View>
      {plan.code === 'FREE' && <Button label="무료로 지원사업 찾기" onPress={onSearch} style={local.planButton} />}
      <Text style={local.footerNote}>{plan.footerNote}</Text>
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
          {item.name} · {item.price}{item.pricePeriod ? ` ${item.pricePeriod}` : ''}{item.code === currentPlan ? ' · 이용 중' : ''}
        </Text>
          <Text style={local.footerNote}>{item.priceNote}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`${item.name} 상세 보기`} onPress={() => choose(item.id)} style={local.detailButton}>
          <Text style={local.detailLabel}>상세 보기</Text>
        </Pressable>
      </View>)}
    </View>
    <View style={local.section}>
      <Text accessibilityRole="header" style={local.sectionTitle}>찾고, 확인하고, 질문하세요</Text>
      <Text style={local.sectionDescription}>현재 무료로 이용할 수 있어요</Text>
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
  policy: { flexDirection: 'row', gap: 9, padding: 13, borderRadius: 12, backgroundColor: colors.soft, marginVertical: 6 },
  policyCheck: { color: colors.primaryText, fontSize: 16, lineHeight: 23 },
  policyTitle: { color: colors.primaryText, fontSize: 13, lineHeight: 22, fontWeight: '700' },
  policyText: { color: colors.primaryText, fontSize: 12, lineHeight: 20 },
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
