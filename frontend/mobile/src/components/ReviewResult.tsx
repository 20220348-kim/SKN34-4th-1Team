import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { reviewStages, type ReviewRun, type RunStatus } from '@govbiz/shared/domain/entities/CombinationReview'
import { Button, Card, Notice, StatusBadge, colors, styles } from '../ui'

export const reviewRunLabels: Record<RunStatus, string> = { QUEUED: '분석 대기', RUNNING: '분석 중', SUCCEEDED: '분석 완료', FAILED: '분석 실패', INTERRUPTED: '분석 중단', UNKNOWN: '결과 확인 필요' }
const stageLabels = { APPLICATION: '신청', SELECTION: '선정', COMMITMENT: '확약', AGREEMENT: '협약', EXECUTION: '수행', FUNDING: '교부' }
const judgments = { RESTRICTION_APPLIES: '제한 적용', PERMISSION_IN_SCOPE: '명시된 범위 내 허용', NEEDS_FACTS: '사용자 정보 부족', INSUFFICIENT_EVIDENCE: '공식 근거 부족', CONFLICTING_EVIDENCE: '규정 충돌' }
const judgmentColors = {
  RESTRICTION_APPLIES: { backgroundColor: colors.dangerSoft, color: colors.danger },
  PERMISSION_IN_SCOPE: { backgroundColor: colors.soft, color: colors.primaryText },
  NEEDS_FACTS: { backgroundColor: colors.infoSoft, color: colors.info },
  INSUFFICIENT_EVIDENCE: { backgroundColor: colors.warningSoft, color: colors.warning },
  CONFLICTING_EVIDENCE: { backgroundColor: colors.warningSoft, color: colors.warning },
}
const dateFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const reviewTime = (value: string) => dateFormatter.format(new Date(value))
const statusTerms: Record<string, string> = { NOT_STARTED: '시작 전', IN_PROGRESS: '수행 중', COMPLETED: '완료', STOPPED: '중단', UNKNOWN: '미확인', YES: '예', NO: '아니오' }
const displayText = (text: string) => text.replace(/\b(?:NOT_STARTED|IN_PROGRESS|COMPLETED|STOPPED|UNKNOWN|YES|NO)\b/g, value => statusTerms[value] ?? value)

export function ReviewResult({ run, currentRevision, names, onSupplement, onRefresh }: {
  run: ReviewRun; currentRevision: number; names: Record<string, string>; onSupplement(): void; onRefresh(): void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [sources, setSources] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const questions = [...new Set(run.analysis?.pairs.flatMap(pair => pair.stages.flatMap(stage => stage.questions)).filter(Boolean) ?? [])]
  async function openSource(url: string) {
    setLinkError(null)
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid source')
      await Linking.openURL(url)
    } catch { setLinkError('공식 원문을 열지 못했어요. 다시 시도해 주세요.') }
  }
  return <View style={{ gap: 12 }}>
    <View style={styles.row}><StatusBadge label={reviewRunLabels[run.status]} tone={run.status === 'SUCCEEDED' ? 'success' : run.status === 'UNKNOWN' ? 'warning' : 'info'} />
      <Text style={styles.muted}>{reviewTime(run.startedAt)} 접수</Text></View>
    <Card><Text style={styles.heading}>이 실행의 비교 대상</Text><Text style={styles.label}>{run.input.title}</Text>
      {run.input.programs.map((program, index) => <View key={index} testID={`comparison-program-${index + 1}`} style={local.comparisonProgram}>
        <Text style={local.programNumber}>사업 {index + 1}</Text>
        <Text style={styles.body}>{names[`${program.sourceCode}:${program.sourceProgramId}`] ?? '공고명 확인 필요'}</Text>
      </View>)}
    </Card>
    {run.inputRevision !== currentRevision && <Notice>입력 변경 전의 결과예요. 현재 입력에 대한 결과가 아닙니다. 이전 결과는 이력에 보관돼요.</Notice>}
    {(run.status === 'QUEUED' || run.status === 'RUNNING') && <Card><Text style={styles.heading}>{run.status === 'QUEUED' ? '검토 요청이 접수됐어요' : '공식 자료 수집·분석 중이에요'}</Text>
      <Text style={styles.body}>다른 화면으로 이동해도 요청은 유지돼요. 새 분석을 요청하지 않아도 상태를 다시 확인할 수 있어요.</Text></Card>}
    {run.status === 'UNKNOWN' && <Notice error>분석 완료 여부를 확인하지 못했어요. 중복 과금을 막기 위해 새 분석을 잠시 막아 뒀어요. 30분 안에 실패로 정리되면 다시 분석할 수 있어요.</Notice>}
    {(run.status === 'FAILED' || run.status === 'INTERRUPTED') && <Notice error>분석을 완료하지 못했어요. 자료 수집·분석 실패는 허용이나 근거 부족 판단을 의미하지 않습니다.
      {run.failureCode?.startsWith('SOURCE_') ? ' 공식 원문 또는 첨부 자료를 확인해 주세요.' : run.failureCode === 'QUEUE_EXPIRED' ? ' 대기 시간 안에 분석이 시작되지 않았어요.' : run.failureCode === 'RUN_OUTCOME_UNKNOWN_EXPIRED' ? ' 완료 여부를 끝내 확인하지 못해 실패로 정리했어요. 필요하면 다시 분석해 주세요.' : ''}</Notice>}
    {run.analysis && <>
      <Card><Text style={styles.heading}>검토 요약</Text><Text style={styles.body}>{displayText(run.analysis.summary)}</Text></Card>
      <Card><Text style={styles.heading}>먼저 확인할 내용</Text>
        {questions.length ? questions.map((question, index) => <Text key={index} style={styles.body}>• {displayText(question)}</Text>) : <Text style={styles.muted}>현재 분석의 추가 확인 질문은 없어요.</Text>}
        <Button label="입력 보완하기" variant="secondary" onPress={onSupplement} /></Card>
      <Text style={styles.heading}>단계별 판단</Text>
      {run.analysis.pairs.map((pair, pairIndex) => <View key={pairIndex} style={{ gap: 10 }}>
        {run.analysis!.pairs.length > 1 && <Text style={styles.label}>사업 {pair.firstProgramIndex + 1} · 사업 {pair.secondProgramIndex + 1}</Text>}
        {reviewStages.map(stageName => {
          const stage = pair.stages.find(item => item.stage === stageName)!
          const key = `${run.id}:${pairIndex}:${stageName}`
          return <Card key={key}><Pressable accessibilityRole="button" accessibilityLabel={`${stageLabels[stageName]} · ${judgments[stage.judgment]}`}
            accessibilityState={{ expanded: open === key }} onPress={() => setOpen(open === key ? null : key)} style={local.stageHeader}>
            <Text style={styles.heading}>{stageLabels[stageName]}</Text>
            <View style={local.stageStatus}><Text testID={`judgment-${pairIndex}-${stageName}`} style={[styles.badge, local.judgmentBadge, judgmentColors[stage.judgment]]}>{judgments[stage.judgment]}</Text>
              <Text accessible={false} style={styles.muted}>{open === key ? '⌃' : '⌄'}</Text></View>
          </Pressable>
            {open === key && <><Text style={styles.label}>판단 범위</Text><Text style={styles.body}>{displayText(stage.scope)}</Text><Text style={styles.body}>{displayText(stage.explanation)}</Text>
              {stage.requiresInstitutionConfirmation && <Notice>기관 확인이 필요해요. 해석이 확정되지 않은 사항은 판단을 보류합니다.</Notice>}
              {stage.questions.map((question, index) => <Text key={index} style={styles.body}>• {displayText(question)}</Text>)}
              {stage.citations.map((citation, index) => {
                const block = run.evidence?.blocks.find(item => item.id === citation.evidenceId)
                const doc = run.evidence?.documents.find(item => item.programIndex === block?.programIndex && item.rawHash === block?.documentHash)
                return <View key={index} style={{ gap: 6 }}><Text style={styles.label}>공식 근거 · 수집 당시 원문</Text><Text style={styles.body}>“{citation.quote}”</Text>
                  {block && block.text !== citation.quote && <Text style={styles.body}>{block.text}</Text>}
                  <Text style={styles.muted}>사업 {(block?.programIndex ?? 0) + 1} · {block?.locator}</Text>
                  {doc && <Button label="공식 원문 확인" variant="secondary" onPress={() => void openSource(doc.sourcePageUrl ?? doc.sourceUrl)} />}</View>
              })}</>}
          </Card>
        })}
      </View>)}
      <Notice>공식 원문 기준의 AI 분석이며 사람이 검수한 정답이 아닙니다. 제한을 찾지 못한 것은 허용을 뜻하지 않으며, 범위 내 허용도 전체 신청 자격이나 동시 수혜를 보장하지 않습니다.</Notice>
    </>}
    {run.evidence && <Card><Button label={sources ? '공식 자료·분석 한계 접기' : '공식 자료·분석 한계 보기'} variant="ghost" onPress={() => setSources(!sources)} />
      {sources && <><Text style={styles.muted}>자동 수집 · 사람 미검수 · {run.input.asOfDate} 기준</Text>
        {run.evidence.documents.map((doc, index) => <View key={index} style={{ gap: 6 }}><Text style={styles.body}>사업 {doc.programIndex + 1} · {doc.fileName}</Text>
          <Button label="공식 공고·원문 열기" variant="secondary" onPress={() => void openSource(doc.sourcePageUrl ?? doc.sourceUrl)} /></View>)}
        {run.evidence.coverageWarnings.map((warning, index) => <Text style={styles.body} key={`warning-${index}`}>{warning}</Text>)}
        {run.analysis?.limitations.map((text, index) => <Text style={styles.body} key={`limit-${index}`}>{displayText(text)}</Text>)}
      </>}
    </Card>}
    {linkError && <Notice error>{linkError}</Notice>}
    <Button label="상태 다시 확인" variant="secondary" onPress={onRefresh} />
  </View>
}

const local = StyleSheet.create({
  comparisonProgram: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 7 },
  programNumber: { color: colors.primaryText, fontSize: 13, fontWeight: '600' },
  stageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 44 },
  stageStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  judgmentBadge: { flexShrink: 1 },
})
