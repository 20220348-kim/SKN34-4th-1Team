import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from 'expo-router'
import { useHeaderHeight, usePreventRemove } from 'expo-router/react-navigation'
import * as Crypto from 'expo-crypto'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationDraftMode } from '@govbiz/shared/domain/entities/ApplicationDocumentGeneration'
import { useAuth } from '../auth/session'
import { readPendingPreparation, savePendingPreparation, clearPendingPreparation } from '../auth/preparationPending'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { getApiBaseUrl } from '../api/client'
import { applicationAnswerKey, applicationFactValue, useApplicationPreparationEditor } from '../components/useApplicationPreparationEditor'
import { PreparationAccess, PreparationSteps, preparationUi } from '../components/ApplicationPreparationUi'
import { PartnerSheet } from '../components/PartnerSheet'
import { Button, Card, Field, Notice, Page, StatusBadge, colors, styles } from '../ui'

type Props = { id: number; reviewing?: boolean; initialQuestion?: string; onLogin(): void; onReview(): void; onEditor(question?: string): void; onDocuments(jobId?: number): void; onReanalyze(identity: { sourceCode: string; sourceProgramId: string }): void }
export function ApplicationPreparationEditorScreen(props: Props) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <PreparationAccess onLogin={props.onLogin} />
  return <OwnedEditor key={`${auth.session.accessToken}:${props.id}`} token={auth.session.accessToken} email={auth.session.account.email} {...props} />
}
function OwnedEditor({ token, email, id, reviewing, initialQuestion, onReview, onEditor, onDocuments, onReanalyze }: Props & { token: string; email: string }) {
  const vm = useApplicationPreparationEditor(id, token)
  const navigation = useNavigation()
  const headerHeight = useHeaderHeight()
  const useCase = useMemo(() => applicationPreparationUseCase(token), [token])
  const [questionKey, setQuestionKey] = useState(initialQuestion ?? '')
  const [sheet, setSheet] = useState<'questions' | 'conflict' | null>(null)
  const [generating, setGenerating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [hasPending, setHasPending] = useState(false)
  const request = useRef<AbortController | null>(null)
  const guard = useRef(false)
  useEffect(() => () => request.current?.abort(), [])
  const scroll = useRef<ScrollView | null>(null)
  useEffect(() => { if (initialQuestion !== undefined) { setQuestionKey(initialQuestion); scroll.current?.scrollTo({ y: 0, animated: false }) } }, [initialQuestion])
  const questions = vm.preparation?.form.sections.flatMap(section => section.fields.map(field => ({ section, field, key: applicationAnswerKey(section.key, field.key) }))) ?? []
  const index = Math.max(0, questions.findIndex(question => question.key === questionKey || question.field.key === questionKey))
  const current = questions[index]
  const dirty = Object.keys(vm.pending).length > 0
  usePreventRemove(dirty || vm.saving, ({ data }) => {
    void vm.flush().then(saved => { if (saved) {
      // 루트 Stack 복귀는 해당 Stack에서 재실행해야 source가 하위 작성 경로로 바뀌지 않습니다.
      let dispatcher = navigation
      while (data.action.target && dispatcher.getState()?.key !== data.action.target) {
        const parent = dispatcher.getParent()
        if (!parent) break
        dispatcher = parent
      }
      dispatcher.dispatch(data.action)
    } else Alert.alert('답변을 먼저 저장해 주세요', '입력한 내용은 이 화면에 남아 있어요. 저장 상태를 확인한 뒤 다시 이동해 주세요.') })
  })
  const missing = questions.filter(question => question.field.required && question.field.documentWritable !== false && !vm.value(question.section, question.field.key).trim())
  const draftMode = applicationDraftMode(questions.map(question => ({ field: question.field, value: vm.value(question.section, question.field.key) })))
  const unknown = questions.filter(question => vm.value(question.section, question.field.key).trim() === '미정').length
  async function move(target: number | 'review') {
    if (!await vm.flush()) return
    if (target === 'review') { onReview(); return }
    setQuestionKey(questions[target]?.key ?? ''); setSheet(null); scroll.current?.scrollTo({ y: 0, animated: false })
  }
  async function generate() {
    if (guard.current) return
    const base = getApiBaseUrl()
    const controller = new AbortController(); request.current = controller
    guard.current = true; setGenerating(true); setActionError(null)
    try {
      if (!await vm.flush() || controller.signal.aborted) return
      const detail = vm.latest(); if (!detail) return
      const [files, jobs, previous] = await Promise.all([useCase.documents(id, controller.signal), useCase.documentJobs(id, controller.signal), readPendingPreparation(base, email)])
      if (controller.signal.aborted) return
      if (files.some(file => file.inputRevision === detail.inputRevision)) { onDocuments(); return }
      const active = jobs.find(job => job.status === 'QUEUED' || job.status === 'RUNNING')
      if (active) { onDocuments(active.id); return }
      if (jobs.some(job => job.status === 'UNKNOWN')) { setActionError('이전 생성 결과를 아직 확인하지 못했어요. 새 초안 생성을 시작하지 않았어요.'); return }
      const record = previous ?? { kind: 'document' as const, preparationId: id, expectedRevision: detail.inputRevision, requestKey: Crypto.randomUUID() }
      if (record.kind !== 'document' || record.preparationId !== id || record.expectedRevision !== detail.inputRevision) { setActionError('다른 입력 버전의 미확인 요청이 있어요. 생성 결과 화면에서 기존 요청부터 확인해 주세요.'); return }
      await savePendingPreparation(base, email, record)
      if (controller.signal.aborted) return
      setHasPending(true)
      const job = await useCase.submitDocumentJob(id, record.expectedRevision, controller.signal, record.requestKey)
      await clearPendingPreparation(base, email); setHasPending(false)
      if (!controller.signal.aborted) onDocuments(job.id)
    } catch (cause) {
      if (!controller.signal.aborted) {
        setActionError(cause instanceof Error ? cause.message : '문서 생성 요청을 확인하지 못했어요.')
        if (cause instanceof ApplicationPreparationError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
          await clearPendingPreparation(base, email).then(() => setHasPending(false)).catch(error => setActionError(error instanceof Error ? error.message : '보관 요청을 확인하지 못했어요.'))
        }
      }
    } finally { guard.current = false; if (!controller.signal.aborted) setGenerating(false) }
  }
  if (vm.loading && !vm.preparation) return <Page><ActivityIndicator accessibilityLabel="작성 문항 불러오는 중" color={colors.primary} /></Page>
  if (!vm.preparation) return <Page><Notice error>{vm.error ?? '신청문서를 확인하지 못했어요.'}</Notice><Button label="다시 확인" onPress={vm.retry} /></Page>
  const value = current ? vm.value(current.section, current.field.key) : ''
  const readonly = current?.field.documentWritable === false
  const blocked = vm.saving || vm.conflict || Boolean(vm.saveError) || generating
  return <KeyboardAvoidingView testID="application-preparation-keyboard-container" style={{ flex: 1 }}
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={headerHeight}>
    <ScrollView ref={scroll} contentContainerStyle={preparationUi.scroll} keyboardShouldPersistTaps="handled">
      <PreparationSteps active={reviewing ? 2 : 1} />
      {vm.error && <Notice error>{vm.error}</Notice>}
      <View style={styles.row}><Text style={[styles.muted, { flex: 1 }]}>{reviewing ? '답변 최종 검토' : current?.section.title}</Text>
        <Button label="항목 목록" variant="ghost" onPress={() => setSheet('questions')} /></View>
      <Text accessibilityLiveRegion="polite" style={styles.muted}>{vm.saving ? '저장 중…' : vm.saveError ? '저장 확인 필요' : dirty ? '입력 중' : vm.savedAt ? '저장됨' : '저장된 답변'}</Text>
      {vm.saveError && <><Notice error>{vm.saveError}</Notice><Button label={vm.conflict ? '최신 답변과 비교' : '저장 다시 시도'} variant="secondary"
        onPress={() => vm.conflict ? setSheet('conflict') : void vm.flush()} /></>}
      {actionError && <Notice error>{actionError}</Notice>}
      {reviewing ? <>
        <Text style={styles.title}>답변을 마지막으로 확인해 주세요</Text>
        <Notice>{missing.length ? `필수 답변 ${missing.length}개가 비어 있어요.` : `필수 답변을 저장했어요. 미정인 답변 ${unknown}개는 자동으로 기입하지 않아요.`}</Notice>
        {missing.length > 0 && <Notice>비워 둔 채로도 초안을 만들 수 있어요. 비운 질문은 문서에 빈칸으로 남아요.</Notice>}
        {questions.map(question => <Card key={question.key}><Text style={styles.heading}>{question.field.label}</Text><Text style={styles.muted}>{vm.value(question.section, question.field.key) || '아직 답변하지 않았어요.'}</Text>
          {question.field.documentWritable === false && <Notice>이 답변은 원본 파일에서 직접 작성해야 해요.</Notice>}
          <Button label="수정" accessibilityLabel={`${question.field.label} 수정`} variant="ghost" disabled={blocked} onPress={() => { void vm.flush().then(saved => { if (saved) onEditor(question.key) }) }} /></Card>)}
        <Notice>{draftMode === 'writing' ? '저장된 답변만 공식 양식에 기입해요. 비운 질문과 미정은 빈칸으로 남아요.'
          : draftMode === 'manualOnly' ? '저장된 답변 중 양식에 자동으로 기입할 수 있는 것이 없어 초안을 만들지 못할 수 있어요. 원문 양식에 직접 옮겨 적어 주세요.'
            : '입력한 답변이 없거나 모두 미정이에요. 초안을 만들면 답변을 기입하지 않은 공식 양식 그대로 저장돼요. AI를 호출하지 않아요.'}</Notice>
        <Text style={styles.muted}>{draftMode === 'original' ? '원본 양식을 저장한 뒤 직접 작성할 수 있어요.' : '답변 기입에는 유료 AI 호출이 발생할 수 있어요.'} 제출 전 파일을 직접 확인해 주세요.</Text>
      </> : current ? <>
        <View style={{ height: 5, backgroundColor: colors.track, borderRadius: 8 }}><View style={{ height: 5, width: `${(index + 1) / questions.length * 100}%`, borderRadius: 8, backgroundColor: colors.primary }} /></View>
        <Card><View style={styles.row}><Text style={[styles.muted, { flex: 1 }]}>질문 {index + 1} / {questions.length}</Text><StatusBadge label={current.field.required ? '필수' : '선택'} tone={current.field.required ? 'warning' : 'neutral'} /></View>
          <Text style={styles.title}>{current.field.label}</Text><Notice>{current.field.guidance}</Notice>
          {readonly ? <><Notice>이 항목은 자동 기입을 지원하지 않아요. 원본 파일에서 직접 작성해 주세요.</Notice><Text style={styles.body}>{value || '저장된 답변이 없어요.'}</Text>
            <Button label="입력칸별 양식 다시 확인" variant="secondary" onPress={() => onReanalyze({ sourceCode: vm.preparation!.form.sourceCode, sourceProgramId: vm.preparation!.form.sourceProgramId })} /></>
            : current.field.options?.length ? current.field.options.map(option => <Pressable key={option} accessibilityRole="radio" accessibilityState={{ checked: value === option }}
              onPress={() => vm.change(current.key, option)} style={[styles.input, value === option && { backgroundColor: colors.soft }]}><Text style={styles.body}>{value === option ? '● ' : '○ '}{option}</Text></Pressable>)
              : <Field label="내 답변" multiline maxLength={2000} value={value} placeholder="답변을 입력해 주세요." onChangeText={next => vm.change(current.key, next)} style={{ minHeight: 156, textAlignVertical: 'top' }} />}
          {!readonly && <><Text style={styles.muted}>{Array.from(value).length} / 2,000</Text><View style={styles.row}>
            <Button label="아직 미정이에요" variant="ghost" onPress={() => vm.change(current.key, '미정')} />
            <Button label="답변 지우기" variant="ghost" onPress={() => vm.change(current.key, '')} /></View></>}
        </Card><Text style={styles.muted}>입력을 멈추면 자동으로 저장돼요. 모르는 내용은 미정으로 남겨도 괜찮아요.</Text>
      </> : <Notice>작성할 문항이 없어요. 공식 원문에서 양식을 확인해 주세요.</Notice>}
      <Button label="공식 공고 원문" variant="ghost" onPress={() => void Linking.openURL(vm.preparation!.form.sourceUrl).catch(() => setActionError('공식 공고 원문을 열지 못했어요.'))} />
    </ScrollView>
    <View style={[preparationUi.footer, local.footer]}>{reviewing
      ? <><Button label={hasPending ? '같은 생성 요청으로 확인' : '공식 양식으로 초안 만들기'} busy={generating} disabled={blocked} onPress={() => void generate()} />
        <Button label="생성 결과 보기" variant="ghost" disabled={generating} onPress={() => onDocuments()} /></>
      : <View style={local.navigation}><Button label="이전" variant="secondary" style={local.navigationButton} disabled={index === 0 || blocked} onPress={() => void move(index - 1)} />
        <Button label={index === questions.length - 1 ? '답변 검토하기' : '다음'} style={local.navigationButton} disabled={blocked || !questions.length} onPress={() => void move(index === questions.length - 1 ? 'review' : index + 1)} /></View>}
      {!reviewing && index !== questions.length - 1 && <Button label="여기까지 작성하고 검토" variant="ghost" disabled={blocked || !questions.length} onPress={() => void move('review')} />}
    </View>
    <PartnerSheet visible={sheet === 'questions'} title="작성 항목" onClose={() => setSheet(null)} actions={<Button label="닫기" variant="secondary" onPress={() => setSheet(null)} />}>{questions.map((question, q) => <Button key={question.key}
      label={`${q + 1}. ${question.field.label}${vm.value(question.section, question.field.key) ? ' · 저장 답변 있음' : ''}`} variant="secondary" onPress={() => reviewing ? onEditor(question.key) : void move(q)} />)}</PartnerSheet>
    <PartnerSheet visible={sheet === 'conflict'} title="답변 변경 확인" onClose={() => setSheet(null)} actions={<><Button label="저장된 답변 사용" variant="secondary" onPress={() => { void vm.resolveConflict(false).then(() => setSheet(null)) }} />
      <Button label="내 답변으로 저장" onPress={() => { void vm.resolveConflict(true).then(saved => { if (saved) setSheet(null) }) }} /></>}>{questions.filter(question => Object.hasOwn(vm.pending, question.key)).map(question => <Card key={question.key}>
        <Text style={styles.heading}>{question.field.label}</Text><Text style={styles.label}>지금 입력한 답변</Text><Text style={styles.body}>{vm.pending[question.key] || '답변 삭제'}</Text>
        <Text style={styles.label}>서버에 저장된 답변</Text><Text style={styles.body}>{applicationFactValue(question.section, question.field.key) || '비어 있음'}</Text></Card>)}</PartnerSheet>
  </KeyboardAvoidingView>
}

const local = StyleSheet.create({
  // 하단 탭이 안전 영역을 확보하므로 버튼 박스에는 기본 여백만 둔다.
  footer: { paddingTop: 8, paddingBottom: 8, flexShrink: 0 },
  navigation: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  navigationButton: { flex: 1 },
})
