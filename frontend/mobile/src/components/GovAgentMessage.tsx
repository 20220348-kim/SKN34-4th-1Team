import { useRef, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import type { ChatMessage } from '@govbiz/shared/domain/entities/ChatConversation'
import type { GovAgentApplication, GovAgentReview } from '@govbiz/shared/domain/entities/GovAgent'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApplicationPreparationNewScreen } from '../screens/ApplicationPreparationNewScreen'
import { CombinationReviewEditorScreen } from '../screens/CombinationReviewScreens'
import { Button, Notice, StatusBadge, colors, styles } from '../ui'
import type { PartnerRecruitmentConditions } from '@govbiz/shared/domain/entities/PartnerRecruitmentRecommendation'
import { GovPartnerBrief } from './GovPartnerBrief'

/** 근거와 업무 카드를 표시하며, 실행·요청 복구는 기존 신청 준비·검토 화면이 소유합니다. */
export function GovAgentMessage({ message, live, active, disabled, onLogin, onOpenProgram, onOpenApplication, onOpenReview,
  onOpenPartners, onOpenRecruitment, onCompany, onCreateRecruitment, onReviewSaved, onWorkingChange }: {
  message: ChatMessage; live: boolean; active: boolean; disabled: boolean
  onLogin(): void; onOpenProgram(identity: SupportProgramIdentity): void
  onOpenApplication?(application: GovAgentApplication): void; onOpenReview?(review: GovAgentReview): void; onOpenPartners?(conditions: PartnerRecruitmentConditions): void
  onCompany?(): void; onCreateRecruitment?(program: SupportProgramIdentity): void
  onOpenRecruitment?(id: number): void
  onReviewSaved(id: number): Promise<void>; onWorkingChange(busy: boolean): void
}) {
  const application = message.govApplication, review = message.govReview
  const [open, setOpen] = useState(live && Boolean(application || review) && !application?.preparationId && !review?.reviewId)
  const mounted = useRef(open)
  const initialReviewId = useRef(review?.reviewId ?? null)
  const current = useRef({ live, active }); current.current = { live, active }
  const [expanded, setExpanded] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const evidence = message.govEvidence
  function showWork() { mounted.current = true; setOpen(true) }
  async function openSource(url: string) {
    setLinkError(null)
    try { await Linking.openURL(url) }
    catch { if (current.current.active) setLinkError('근거 원문을 열지 못했어요. 다시 시도해 주세요.') }
  }
  const workOpen = live && open
  return <View style={local.content}>
    {evidence && <>
      <StatusBadge label={evidence.answer.answerStatus === 'ANSWERED' ? '원문 근거 포함' : '원문 근거 부족'} tone={evidence.answer.answerStatus === 'ANSWERED' ? 'success' : 'warning'} />
      <Text style={styles.muted}>{evidence.program.title}</Text>
      {evidence.answer.citations.length > 0 && <Button variant="ghost" size="small"
        label={`근거 원문 ${evidence.answer.citations.length}건 ${expanded ? '접기' : '보기'}`} onPress={() => setExpanded(!expanded)} />}
      {expanded && evidence.answer.citations.map((citation, index) => <View key={`${citation.chunkOrder}-${index}`} style={local.quote}>
        <Text selectable style={styles.body}>{citation.excerpt}</Text>
        <Button variant="ghost" label={`근거 ${index + 1} · ${citation.sourceLabel} ↗`} onPress={() => void openSource(citation.sourceUrl)} />
      </View>)}
    </>}
    {linkError && <Notice error>{linkError}</Notice>}
    {(application || review) && <View style={local.work} accessibilityLabel={application ? '대화 신청 문서' : '대화 중복 검토'}>
      <View style={local.header}><Text style={[styles.label, { flex: 1 }]}>{application ? '신청 문서' : '중복 검토'}</Text>
        <StatusBadge label={application?.preparationId ? `준비 ${application.preparationId}` : review?.reviewId ? `검토 ${review.reviewId}` : '작업'} />
        {workOpen && <Button label="접기" size="small" variant="ghost" disabled={disabled} onPress={() => setOpen(false)} />}
      </View>
      <View style={local.body}>
        <Text style={styles.heading}>{application?.program.title ?? review?.program?.title ?? '공고 두 개 고르기'}</Text>
        {live && mounted.current && <View style={!workOpen ? local.hidden : undefined}
          accessibilityElementsHidden={!workOpen} importantForAccessibility={workOpen ? 'auto' : 'no-hide-descendants'} pointerEvents={workOpen ? 'auto' : 'none'}>
          {application && <ApplicationPreparationNewScreen inline active={active && workOpen} disabled={disabled} initialProgram={application.program}
            onLogin={onLogin} onOpenProgram={onOpenProgram} onWorkingChange={onWorkingChange}
            onOpenForms={() => onOpenApplication?.(application)} onList={() => onOpenApplication?.(application)}
            onCreated={id => onOpenApplication?.({ ...application, preparationId: id })}
            onPendingDocument={id => onOpenApplication?.({ ...application, preparationId: id })} />}
          {review && <CombinationReviewEditorScreen inline active={active && workOpen} disabled={disabled} id={initialReviewId.current}
            initialProgram={review.program ?? undefined} initialStep={initialReviewId.current ? 'confirm' : 'selection'}
            onLogin={onLogin} onOpenProgram={onOpenProgram} onWorkingChange={onWorkingChange}
            onStepChange={(id, step) => {
              void onReviewSaved(id).then(() => {
                if (step === 'analysis' && current.current.live && current.current.active) onOpenReview?.({ ...review, reviewId: id })
              }).catch(() => { if (current.current.active) setLinkError('검토 연결을 대화 기록에 저장하지 못했어요. 다시 확인해 주세요.') })
            }} />}
        </View>}
        {!workOpen && (application
          ? <Button label={application.preparationId ? '이어서 쓰기' : live ? '입력칸 분석 보기' : '신청 문서 화면에서 이어서 보기'}
            variant="secondary" disabled={disabled} onPress={application.preparationId || !live ? () => onOpenApplication?.(application) : showWork} />
          : review && <Button label={live ? '검토 입력 이어서 보기' : '중복 검토 화면에서 이어서 보기'} variant="secondary"
            disabled={disabled} onPress={live ? showWork : () => onOpenReview?.(review)} />)}
      </View>
    </View>}
    {message.govPartners && <GovPartnerBrief key={JSON.stringify(message.govPartners.conditions)} conditions={message.govPartners.conditions}
      live={live} active={active} disabled={disabled} onOpenPartners={onOpenPartners} onOpenRecruitment={onOpenRecruitment}
      onCompany={onCompany} onCreateRecruitment={onCreateRecruitment} />}
  </View>
}

const local = StyleSheet.create({
  content: { gap: 10 }, work: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  body: { padding: 12, gap: 12 }, hidden: { display: 'none' },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.fieldBorder, paddingLeft: 12, gap: 8 },
})
