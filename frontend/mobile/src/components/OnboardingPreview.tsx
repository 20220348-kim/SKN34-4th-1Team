import { StyleSheet, Text, View } from 'react-native'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import { AppIcon } from './AppIcon'
import { SearchConditionCard } from './SearchConditionCard'
import { SearchProgramCard } from './SearchProgramCard'
import { colors } from '../ui'

// These are explicitly labelled introduction examples, never API or personal-data fallbacks.
const exampleProgram: SupportProgram = {
  sourceCode: 'BIZINFO', id: 'introduction-example', title: '2026 스마트공장 고도화 지원사업 2차', organization: '중소벤처기업부',
  summary: '', categories: ['기술'], regions: ['경기'], targetDescription: '', applicationPeriod: '신청 기간 예시',
  applicationStartDate: null, applicationEndDate: '2026-10-07', status: 'OPEN', sourceName: '기업마당', sourceUrl: 'https://www.bizinfo.go.kr',
  matchedReasons: [], recommendationScore: 92, eligibilityReview: {
    status: 'MATCH', basis: 'OFFICIAL_API_TEXT',
    target: { status: 'MATCH', explanation: '소개 예시', evidence: [{ field: 'TARGET_DESCRIPTION', quote: '제조 중소기업 중 기초 수준 이상 스마트공장을 구축한 기업' }] },
    region: { status: 'MATCH', explanation: '소개 예시', evidence: [{ field: 'SUMMARY', quote: '경기도 소재 제조기업' }] },
  },
}

export function OnboardingPreview({ step }: { step: number }) {
  return <View accessibilityLabel="기능 소개 화면 예시" style={local.window}>
    {step === 0 ? <>
      <View style={local.userBubble}><Text style={local.body}>경기 제조기업이 받을 수 있는 설비 지원 찾아줘</Text></View>
      <SearchConditionCard context={{ query: '설비 지원', acceptingOnly: true,
        companyConditions: { region: '경기', industry: '제조업', establishedOn: null, supportPurpose: null } }} />
      <Text style={local.footnote}>기업마당 · K-Startup · 과기정통부 · 충남 공고</Text>
    </> : step === 1 ? <>
      <SearchProgramCard program={exampleProgram} />
      <SearchProgramCard program={{ ...exampleProgram, id: 'introduction-example-2', title: '청년일자리 도약장려금 하반기', recommendationScore: null, applicationEndDate: '2026-10-05',
        eligibilityReview: { ...exampleProgram.eligibilityReview!, status: 'REVIEW_REQUIRED',
          target: { status: 'UNKNOWN', explanation: '추가 확인 예시', evidence: [{ field: 'TARGET_DESCRIPTION', quote: '상시 근로자 5인 이상 기업' }] } } }} />
    </> : step === 2 ? <>
      <View style={local.userBubble}><Text style={local.body}>창업 3년 차도 신청할 수 있나요?</Text></View>
      <View style={local.paper}><Text style={local.answerLabel}>원문 근거 답변 · 예시</Text>
        <Text style={local.body}>공고 본문에 업력 7년 이하 기업이 대상이라는 문구가 있어요.</Text>
        <View style={local.quote}><Text style={local.footnote}>근거 1 · 기업마당 상세 본문</Text><Text style={local.body}>공고일 기준 업력 7년 이하인 창업기업</Text></View>
      </View>
      <Text style={local.footnote}>최종 신청 조건은 공식 공고 원문에서 확인해 주세요.</Text>
    </> : <>
      <View style={local.paper}><View style={local.meta}><Text style={local.status}>접수 중</Text><Text style={local.stage}>준비 중</Text></View>
        <Text style={local.title}>2026년 2차 중소기업 혁신바우처 사업</Text>
        <View style={local.meta}><AppIcon name="document" color={colors.muted} size={18} /><Text style={local.footnote}>문서 · 초안 완료</Text>
          <AppIcon name="shield" color={colors.muted} size={18} /><Text style={local.footnote}>검토 · 분석 완료</Text></View>
      </View>
      <View style={[local.paper, local.file]}><View style={local.fileIcon}><AppIcon name="document" color={colors.primary} /></View>
        <View style={{ flex: 1, gap: 4 }}><Text style={local.title}>사업계획서_초안_v4.hwpx</Text><Text style={local.footnote}>공식 양식 그대로 · 빈칸 3곳 표시</Text></View>
      </View>
    </>}
    <View pointerEvents="none" style={local.fade} />
  </View>
}

const local = StyleSheet.create({
  window: { marginHorizontal: 12, backgroundColor: colors.background, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 16, gap: 12, height: 370, overflow: 'hidden' },
  userBubble: { alignSelf: 'flex-end', maxWidth: '92%', padding: 14, borderRadius: 18, backgroundColor: colors.soft },
  paper: { backgroundColor: colors.surface, borderRadius: 18, padding: 16, gap: 12 },
  title: { color: colors.text, fontSize: 15, lineHeight: 23, fontWeight: '600' }, body: { color: colors.text, fontSize: 14, lineHeight: 23 },
  footnote: { color: colors.secondaryText, fontSize: 12, lineHeight: 19 }, answerLabel: { color: colors.info, fontSize: 13, fontWeight: '600' },
  quote: { backgroundColor: colors.background, borderRadius: 12, padding: 12, gap: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }, status: { color: colors.primaryText, fontSize: 13, fontWeight: '600' },
  stage: { marginLeft: 'auto', color: colors.info, backgroundColor: colors.infoSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, fontSize: 12 },
  file: { flexDirection: 'row', alignItems: 'center' }, fileIcon: { padding: 10, backgroundColor: colors.soft, borderRadius: 12 },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 16, backgroundColor: colors.background, opacity: 0.85 },
})
