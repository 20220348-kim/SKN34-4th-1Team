import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { OnboardingPreview } from '../components/OnboardingPreview'
import { Button, Notice, colors, styles } from '../ui'

const slides = [
  { title: '말로 물어보면', highlight: '맞는 지원사업을 찾아요', description: '지역 · 업종 · 필요한 지원을 적으면\n검색 조건으로 정리해 드려요' },
  { title: '신청 자격은', highlight: '공고 원문 문장으로 확인해요', description: '결과마다 자격 판단에 쓴 본문 문장을\n함께 보여 드려요' },
  { title: '궁금한 조건은', highlight: '공고에 직접 물어보세요', description: '로그인 후 지원되는 기업마당 공고의\n상세 본문에서 근거를 찾아 답해 드려요' },
  { title: '담아 두면', highlight: '신청 준비까지 이어져요', description: '로그인하면 관심 공고함부터\n신청 문서 · 중복 검토까지 한곳에서' },
]

export function WelcomeScreen({ busy, error, onBrowse, onLogin, onSignup }: {
  busy: boolean; error: string | null; onBrowse(): void; onLogin(): void; onSignup(): void
}) {
  const [index, setIndex] = useState(0)
  const insets = useSafeAreaInsets()
  const dimensions = useWindowDimensions()
  const [pageWidth, setPageWidth] = useState(Math.max(1, dimensions.width - insets.left - insets.right))
  const carousel = useRef<ScrollView | null>(null)
  useEffect(() => { carousel.current?.scrollTo({ x: index * pageWidth, animated: false }) }, [index, pageWidth, busy])
  function select(next: number) {
    if (busy) return
    const target = Math.max(0, Math.min(slides.length - 1, next))
    setIndex(target)
  }
  return <View style={[local.page, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
    <View style={local.navigation}>
      <Button label={index ? '이전' : '건너뛰기'} variant="ghost" disabled={busy} onPress={() => index ? select(index - 1) : onBrowse()} />
      <Text accessibilityLiveRegion="polite" style={styles.muted}>{index + 1} / 4</Text>
      <Button label={index === 3 ? '둘러보기' : '다음'} variant="ghost" disabled={busy} onPress={() => index === 3 ? onBrowse() : select(index + 1)} />
    </View>
    <View style={local.progress} accessibilityLabel={`기능 소개 ${index + 1}단계`}>
      {slides.map((_, step) => <Pressable key={step} accessibilityRole="button" accessibilityLabel={`온보딩 ${step + 1}장 보기`}
        accessibilityState={{ selected: index === step, disabled: busy }} disabled={busy} onPress={() => select(step)} style={local.progressTarget}>
        <View style={[local.bar, step <= index && { backgroundColor: colors.primary }]} />
      </Pressable>)}
    </View>
    {error && <View style={{ paddingHorizontal: 20 }}><Notice error>{error}</Notice></View>}
    <ScrollView ref={carousel} testID="welcome-carousel" horizontal pagingEnabled directionalLockEnabled bounces={false} overScrollMode="never"
      scrollEnabled={!busy} showsHorizontalScrollIndicator={false} style={{ flex: 1 }} keyboardShouldPersistTaps="handled"
      onLayout={event => { const width = event.nativeEvent.layout.width; if (width > 0 && width !== pageWidth) {
        setPageWidth(width)
      } }}
      onMomentumScrollEnd={event => { if (busy) { carousel.current?.scrollTo({ x: index * pageWidth, animated: false }); return }
        setIndex(Math.max(0, Math.min(slides.length - 1, Math.round(event.nativeEvent.contentOffset.x / pageWidth)))) }}>
      {slides.map((slide, step) => <ScrollView key={step} bounces={false} overScrollMode="never" style={{ width: pageWidth }} contentContainerStyle={local.slide}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
        accessibilityElementsHidden={step !== index} importantForAccessibility={step === index ? 'auto' : 'no-hide-descendants'}>
        <View style={local.heading}><Text style={local.title}>{slide.title}</Text><Text style={[local.title, { color: colors.primary }]}>{slide.highlight}</Text>
          <Text style={[styles.subtitle, { textAlign: 'center', marginTop: 12 }]}>{slide.description}</Text></View>
        <OnboardingPreview step={step} />
      </ScrollView>)}
    </ScrollView>
    <Text style={local.swipeHint}>좌우로 밀어서 넘겨보세요</Text>
    <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 16), gap: 6 }}>
      <Button label="회원가입하고 시작하기" busy={busy} onPress={onSignup} size="large" />
      <View style={local.footerLinks}>
        <Pressable accessibilityRole="button" accessibilityLabel="이미 계정이 있습니다" disabled={busy} onPress={onLogin} style={local.link}>
          <Text style={local.linkText}>이미 계정이 있습니다</Text></Pressable>
        <View style={local.separator} />
        <Pressable accessibilityRole="button" accessibilityLabel="로그인 없이 둘러보기" disabled={busy} onPress={onBrowse} style={local.link}>
          <Text style={local.linkText}>로그인 없이 둘러보기</Text></Pressable>
      </View>
    </View>
  </View>
}
const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface }, navigation: { paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progress: { paddingHorizontal: 20, flexDirection: 'row', gap: 6 }, progressTarget: { flex: 1, minHeight: 30, justifyContent: 'center' },
  bar: { height: 3, borderRadius: 3, backgroundColor: colors.track }, slide: { paddingHorizontal: 20 },
  heading: { paddingTop: 15, paddingBottom: 18 }, title: { fontSize: 26, lineHeight: 37, fontWeight: '700', color: colors.text, textAlign: 'center' },
  swipeHint: { fontSize: 12, lineHeight: 20, color: colors.muted, textAlign: 'center', paddingTop: 5 },
  footerLinks: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 6 },
  link: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: { fontSize: 14, lineHeight: 22, color: colors.secondaryText, textAlign: 'center' }, separator: { width: 1, height: 16, backgroundColor: colors.fieldBorder },
})
