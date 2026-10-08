import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { Linking } from 'react-native'
import type { ReviewRun } from '@govbiz/shared/domain/entities/CombinationReview'
import { ReviewResult } from './ReviewResult'
import { reviewRunFixture } from '../test/reviewFixtures'
import { colors } from '../ui'

const names = { 'BIZINFO:PBLN_100': '첫 사업', 'BIZINFO:PBLN_200': '둘째 사업' }
function show(run: ReviewRun, onSupplement = jest.fn()) {
  return render(<ReviewResult run={run} currentRevision={1} names={names} onRefresh={jest.fn()} onSupplement={onSupplement} />)
}
/** 웹 결과 화면 시험과 같은 판정 조합입니다: 신청 · 협약 정보 부족, 선정 근거 부족, 확약 충돌, 수행 제한, 교부 허용. */
function judgedRun(): ReviewRun {
  const run = reviewRunFixture('SUCCEEDED')
  const judgments = ['NEEDS_FACTS', 'INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE', 'NEEDS_FACTS', 'RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE'] as const
  run.analysis!.summary = '모의 분석입니다. 기관 확인이 필요합니다.'
  run.analysis!.pairs[0].stages.forEach((stage, index) => Object.assign(stage, {
    judgment: judgments[index], scope: '동일 목적 사업비에 한정', questions: ['지원 목적이 동일한가요?'], requiresInstitutionConfirmation: index < 4,
  }))
  return run
}
const stageButtons = () => screen.getAllByRole('button', { name: /^\d단계 / })
const expandedStates = () => stageButtons().map(button => button.props.accessibilityState.expanded)
const questionItems = () => screen.getAllByTestId('review-question').map(item => within(item).getAllByText(/.+/).map(node => node.props.children).join(' '))
const stageRow = (stage: string) => within(screen.getByTestId(`stage-0-${stage}`))

test('run snapshots, questions, stages, exact citations and collection limits are readable', () => {
  const run = reviewRunFixture('SUCCEEDED')
  render(<ReviewResult run={run} currentRevision={2} names={names} onRefresh={jest.fn()} onSupplement={jest.fn()} />)
  expect(screen.getByText(/입력 변경 전의 결과/)).toBeTruthy()
  const first = within(screen.getByTestId('comparison-program-1'))
  const second = within(screen.getByTestId('comparison-program-2'))
  expect(first.getByText('사업 1')).toBeTruthy()
  expect(first.getByText('첫 사업')).toBeTruthy()
  expect(first.queryByText('둘째 사업')).toBeNull()
  expect(second.getByText('사업 2')).toBeTruthy()
  expect(second.getByText('둘째 사업')).toBeTruthy()
  // 정보 부족뿐이고 참여 상태가 모두 미확인이라 결론은 "아직 정할 수 없어요"이고, 모든 단계 줄이 접혀 있어요.
  expect(screen.getByText('두 공고를 함께 진행해도 되는지 아직 정할 수 없어요')).toBeTruthy()
  expect(screen.getByText('공고에서 서로를 막는 조항은 찾지 못했고, 내 참여 상태가 모두 미확인이에요.')).toBeTruthy()
  expect(expandedStates()).toEqual(Array(6).fill(false))
  expect(questionItems()).toEqual(['신청 같은 비용인가요?'])
  fireEvent.press(screen.getByRole('button', { name: /^1단계 신청 확인 필요 · 사용자 정보 부족/ }))
  expect(stageRow('APPLICATION').getByText('과제·비용 관계를 확인해 주세요.')).toBeTruthy()
  fireEvent.press(stageRow('APPLICATION').getByRole('button', { name: '근거 원문 1개 보기 ▾' }))
  expect(stageRow('APPLICATION').getByText('동일 비용을 중복 지원하지 않습니다.')).toBeTruthy()
  expect(stageRow('APPLICATION').getByText('사업 1 · 모의-공고.pdf · 3쪽 · 비용 제한')).toBeTruthy()
  const sources = screen.getByRole('button', { name: '공식 원문 1개 · 판단 한계 2개' })
  expect(sources.props.accessibilityState.expanded).toBe(false)
  expect(screen.queryByText('• 미수집 자료가 있습니다.')).toBeNull()
  fireEvent.press(sources)
  expect(screen.getByText('• 미수집 자료가 있습니다.')).toBeTruthy()
  expect(screen.getByText('• 전체 지원 이력을 확인하지 않았습니다.')).toBeTruthy()
  expect(screen.getByText(/두 공고 사이의 제한만 봤어요/)).toBeTruthy()
})

test('untrusted source destinations cannot be opened', async () => {
  const run = reviewRunFixture('SUCCEEDED')
  run.evidence!.documents[0].sourcePageUrl = 'https://user:secret@example.test/private'
  const opening = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  show(run)
  fireEvent.press(screen.getByRole('button', { name: /^1단계 신청/ }))
  fireEvent.press(stageRow('APPLICATION').getByRole('button', { name: '근거 원문 1개 보기 ▾' }))
  fireEvent.press(screen.getByText('공식 원문 확인'))
  await screen.findByText('공식 원문을 열지 못했어요. 다시 시도해 주세요.')
  expect(opening).not.toHaveBeenCalled()
  opening.mockRestore()
})

test('leads with a fixed conclusion and stage band, then priority questions, collapsed stage rows and folded sources', () => {
  const onSupplement = jest.fn()
  show(judgedRun(), onSupplement)
  // 결론 → 먼저 확인할 것 → 단계별 판단 순서입니다(맨 위 비교 대상 카드는 실행 당시 입력이라 그대로 둬요).
  expect(screen.getAllByRole('header').map(node => node.props.children)).toEqual(['이 실행의 비교 대상', '함께 진행하면 문제가 될 수 있는 단계가 있어요', '먼저 확인할 것', '단계별 판단'])
  // 판정 다섯 가지를 주의(제한 · 충돌) · 확인 필요(정보 · 근거 부족) · 가능(범위 내 허용)으로 세고, 결론 문장은 판정 조합으로 정해요.
  expect(screen.getByText('주의 2')).toBeTruthy()
  expect(screen.getByText('확인 필요 3')).toBeTruthy()
  expect(screen.getByText('가능 1')).toBeTruthy()
  expect(screen.getByText('6단계 판단')).toBeTruthy()
  expect(screen.getByText('수행 단계에 공고가 정한 제한이 적용돼요. 확약 단계는 공고 내용이 서로 달라요.')).toBeTruthy()
  // 단계 색 띠는 신청 → 교부 순서이고 판정을 함께 읽어 줘요.
  expect(screen.getAllByTestId(/^band-0-/).map(cell => cell.props.accessibilityLabel)).toEqual(['신청 단계 확인 필요', '선정 단계 확인 필요', '확약 단계 주의', '협약 단계 확인 필요', '수행 단계 주의', '교부 단계 가능'])
  expect(screen.getByTestId('band-0-EXECUTION')).toHaveStyle({ backgroundColor: colors.warningSoft, color: colors.warning })
  expect(screen.getByTestId('band-0-FUNDING')).toHaveStyle({ backgroundColor: colors.soft, color: colors.primaryText })
  // AI 요약은 접어 두고 [요약 더 보기]로 펼쳐요.
  expect(screen.queryByText('모의 분석입니다. 기관 확인이 필요합니다.')).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '요약 더 보기 ▾' }))
  expect(screen.getByText('모의 분석입니다. 기관 확인이 필요합니다.')).toBeTruthy()
  expect(screen.getByRole('button', { name: '요약 접기 ▴' }).props.accessibilityState.expanded).toBe(true)
  // 같은 질문은 한 번만, 질문이 더 없으면 [모두 보기]가 없어요. 참여 상태 입력 단계로 가는 버튼이 있어요.
  expect(questionItems()).toEqual(['확약 지원 목적이 동일한가요?'])
  expect(screen.queryByRole('button', { name: /모두 보기/ })).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '참여 상태 입력하고 다시 보기' }))
  expect(onSupplement).toHaveBeenCalledTimes(1)
  // 주의(충돌 · 제한) 단계 줄만 펼쳐 두고, 근거 원문은 첫 주의 줄에서만 펼쳐요.
  expect(expandedStates()).toEqual([false, false, true, false, true, false])
  expect(stageRow('APPLICATION').getByText('동일 목적 사업비에 한정')).toBeTruthy()
  expect(stageRow('APPLICATION').getByText('질문 1 · 근거 1')).toBeTruthy()
  expect(stageRow('APPLICATION').getByText('기관 확인 필요')).toBeTruthy()
  expect(stageRow('FUNDING').queryByText('기관 확인 필요')).toBeNull()
  expect(stageRow('APPLICATION').queryByText('공식 원문 및 사실 관계를 확인해야 합니다.')).toBeNull()
  expect(stageRow('COMMITMENT').getByRole('button', { name: '근거 원문 1개 접기 ▴' }).props.accessibilityState.expanded).toBe(true)
  expect(stageRow('COMMITMENT').getByText('근거 1')).toBeTruthy()
  expect(stageRow('EXECUTION').getByRole('button', { name: '근거 원문 1개 보기 ▾' }).props.accessibilityState.expanded).toBe(false)
  expect(stageRow('EXECUTION').queryByText('근거 1')).toBeNull()
  // 접힌 줄을 누르면 펼치고, 펼친 줄을 누르면 접어요.
  fireEvent.press(stageButtons()[0])
  fireEvent.press(stageButtons()[2])
  expect(expandedStates()).toEqual([true, false, false, false, true, false])
  // 공식 원문 · 판단 한계는 한 줄로 접어 둬요.
  expect(screen.getByRole('button', { name: '공식 원문 1개 · 판단 한계 2개' }).props.accessibilityState.expanded).toBe(false)
  expect(screen.queryByText('공식 공고·원문 열기')).toBeNull()
})

test('shows one unseen question per stage first, at most six, and expands to every question once', () => {
  const run = judgedRun()
  run.analysis!.pairs[0].stages[0].questions = ['두 사업의 비용이 같나요?']
  run.analysis!.pairs[0].stages[1].questions = ['두 사업의 비용이 같나요?', '확약서를 제출했나요?', '협약 기간이 겹치나요?']
  const view = show(run)
  // 주의 단계(확약)의 질문이 먼저이고, 선정 단계는 앞에서 나온 질문을 건너뛰고 다음 질문을 골라요.
  expect(questionItems()).toEqual(['확약 지원 목적이 동일한가요?', '신청 두 사업의 비용이 같나요?', '선정 확약서를 제출했나요?'])
  fireEvent.press(screen.getByRole('button', { name: '질문 4개 모두 보기 ▾' }))
  expect(questionItems()).toHaveLength(4)
  expect(questionItems().filter(item => item.endsWith('두 사업의 비용이 같나요?'))).toHaveLength(1)
  expect(questionItems()).toContain('선정 협약 기간이 겹치나요?')
  expect(screen.getByRole('button', { name: '단계별 첫 질문만 보기 ▴' }).props.accessibilityState.expanded).toBe(true)
  view.unmount()

  // 사업 짝이 둘이면 단계가 12개라도 첫 질문은 6개까지만 보여요.
  const pairs = reviewRunFixture('SUCCEEDED')
  const pair = pairs.analysis!.pairs[0]
  pairs.analysis!.pairs = [pair, { ...pair, secondProgramIndex: 2 }].map((item, pairIndex) => ({
    ...item, stages: item.stages.map(stage => ({ ...stage, questions: [`사업 짝 ${pairIndex + 1}의 ${stage.stage} 질문`] })),
  }))
  show(pairs)
  expect(questionItems()).toHaveLength(6)
  fireEvent.press(screen.getByRole('button', { name: '질문 12개 모두 보기 ▾' }))
  expect(questionItems()).toHaveLength(12)
  // 사업 짝마다 색 띠와 단계 줄 묶음에 짝 이름을 붙여요.
  expect(screen.getAllByText('사업 1 × 사업 3')).toHaveLength(2)
  expect(screen.getAllByTestId(/^band-1-/)).toHaveLength(6)
})

test.each([
  ['RESTRICTION_APPLIES', '제한 적용', '주의', colors.warningSoft, colors.warning, true],
  ['CONFLICTING_EVIDENCE', '규정 충돌', '주의', colors.warningSoft, colors.warning, true],
  ['PERMISSION_IN_SCOPE', '명시된 범위 내 허용', '가능', colors.soft, colors.primaryText, false],
  ['NEEDS_FACTS', '사용자 정보 부족', '확인 필요', colors.infoSoft, colors.info, false],
  ['INSUFFICIENT_EVIDENCE', '공식 근거 부족', '확인 필요', colors.infoSoft, colors.info, false],
] as const)('%s shows its verdict badge and judgment label and opens only caution stages first', (judgment, label, verdict, backgroundColor, color, expanded) => {
  const run = reviewRunFixture('SUCCEEDED')
  run.analysis!.pairs[0].stages[0].judgment = judgment
  show(run)
  expect(screen.getByTestId('verdict-stage-0-APPLICATION')).toHaveTextContent(verdict)
  expect(screen.getByTestId('verdict-stage-0-APPLICATION')).toHaveStyle({ backgroundColor, color })
  expect(stageRow('APPLICATION').getByText(label)).toBeTruthy()
  const stage = screen.getByRole('button', { name: new RegExp(`^1단계 신청 ${verdict} · ${label}`) })
  expect(stage.props.accessibilityState.expanded).toBe(expanded)
  if (!expanded) fireEvent.press(stage)
  expect(stageRow('APPLICATION').getByText('과제·비용 관계를 확인해 주세요.')).toBeTruthy()
})

// 웹 시험과 같은 실제 공고 인용입니다. 글꼴 전용 문자 · 쪽 번호 · 출력 도장이 섞여 있어요.
const exclusions = [
  '◦ 지원 제외 대상에 해당하는 기업', '▪ 국세 체납 중인 기업 또는 대표자. 다만, 분납 계획에 따라 세금을 ', '성실하게 납부하는 경우 신청 가능',
  '▪ 신청 사업의 내용이 타 정부지원 사업 등을 통해 지원받은 내용과 ', '유사·중복되는 경우', `${String.fromCharCode(0xf06d)} 세금계산서 발생이 제한되는 간이사업자`,
  '- 4 -', '정책매장운영팀 1230013 2026/08/31-10:27:41', '□ 모집대상', '◦ 인천국제공항 출국장 정책면세점에 신규 입점을 희망하는 기업', '□ 선정규모', '◦ 5대 품목 비중별 고득점 순으로 선정',
].join('\n')

test('formats evidence quotes around related lines and opens the whole source block or the stored text', () => {
  const run = reviewRunFixture('SUCCEEDED')
  run.evidence!.blocks[0] = { ...run.evidence!.blocks[0], locator: 'PDF page 3 part 1', text: `${exclusions}\n◦ 지원기간은 거래계약일로부터 1년` }
  run.analysis!.pairs[0].stages[0].citations = [{ evidenceId: 'E1', quote: exclusions }]
  run.analysis!.pairs[0].stages[4].citations = [{ evidenceId: 'E1', quote: exclusions }]
  show(run)
  fireEvent.press(screen.getByRole('button', { name: /^1단계 신청/ }))
  fireEvent.press(stageRow('APPLICATION').getByRole('button', { name: '근거 원문 1개 보기 ▾' }))
  const stage = stageRow('APPLICATION')
  // 위치는 사용자 말로, 같은 인용을 고른 다른 단계를 함께 알려요.
  expect(stage.getByText('근거 1')).toBeTruthy()
  expect(stage.getByText('사업 1 · 모의-공고.pdf · 3쪽')).toBeTruthy()
  expect(stage.getByText('수행 단계에도 인용')).toBeTruthy()
  expect(stage.queryByText('신청서 서식')).toBeNull()
  // PDF 줄바꿈은 잇고, 글꼴 전용 문자 · 쪽 번호 · 출력 도장은 빼고, 관련 줄과 앞뒤 · 상위 항목만 남겨요. 관련 줄의 낱말만 강조해요.
  expect(stage.getByText(/세금을 성실하게 납부하는 경우 신청 가능/)).toBeTruthy()
  expect(stage.getAllByTestId('evidence-keyword').map(node => node.props.children)).toEqual(['지원 제외', '타 정부지원 사업', '중복'])
  expect(stage.queryByText(new RegExp(`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]|1230013|- 4 -`))).toBeNull()
  expect(stage.getByText('⋯ 4줄 접힘')).toBeTruthy()
  expect(stage.queryByText(/고득점 순으로 선정/)).toBeNull()
  expect(stage.getByText('뒤로 이어짐 …')).toBeTruthy()
  // 인용이 원문 조각 앞부분만 가져왔으므로 [이 부분 전체 보기]는 조각 전체를 정리해 보여 줘요.
  const expand = stage.getByRole('button', { name: '이 부분 전체 보기 ▾' })
  expect(expand.props.accessibilityState.expanded).toBe(false)
  fireEvent.press(expand)
  expect(stage.getByRole('button', { name: '간단히 보기 ▴' }).props.accessibilityState.expanded).toBe(true)
  expect(stage.getByText('인용 앞뒤를 포함한 3쪽 전체예요.')).toBeTruthy()
  expect(stage.getByText(/고득점 순으로 선정/)).toBeTruthy()
  expect(stage.getByText(/지원기간은 거래계약일로부터 1년/)).toBeTruthy()
  expect(stage.queryByText('뒤로 이어짐 …')).toBeNull()
  // [원문 그대로]는 저장된 인용을 글자 그대로 보여 줘요.
  const raw = stage.getByRole('button', { name: '원문 그대로' })
  expect(raw.props.accessibilityState.selected).toBe(false)
  fireEvent.press(raw)
  expect(stage.getByRole('button', { name: '원문 그대로' }).props.accessibilityState.selected).toBe(true)
  expect(stage.getByText(exclusions, { normalizer: text => text })).toBeTruthy()
  expect(stage.queryByRole('button', { name: /전체 보기|간단히 보기/ })).toBeNull()
  fireEvent.press(stage.getByRole('button', { name: '원문 그대로' }))
  expect(stage.getByRole('button', { name: '이 부분 전체 보기 ▾' })).toBeTruthy()
  expect(stage.getByText('⋯ 4줄 접힘')).toBeTruthy()
})

test('tags application form quotes and quotes cited by many stages, and expands an uncut quote to all its lines', () => {
  const run = reviewRunFixture('SUCCEEDED')
  const form = ['[서식 1] 참여 신청서', '□ 신청방법', '◦ 이메일 접수', '◦ 접수 기간', '◦ 문의처', '◦ 타 기관 지원을 받는 경우 중복지원 불가', '◦ 결과 통보', '◦ 협약', '◦ 사업비 지급', '2026년 월 일', '신청인 : (서명 또는 인)'].join('\n')
  run.evidence!.documents[0] = { ...run.evidence!.documents[0], fileName: '참여-신청서.hwpx', format: 'HWPX' }
  run.evidence!.blocks[0] = { ...run.evidence!.blocks[0], locator: 'HWPX section0 paragraphs 1-12', text: form }
  run.analysis!.pairs[0].stages.slice(0, 5).forEach(stage => { stage.citations = [{ evidenceId: 'E1', quote: form }] })
  show(run)
  fireEvent.press(screen.getByRole('button', { name: /^1단계 신청/ }))
  fireEvent.press(stageRow('APPLICATION').getByRole('button', { name: '근거 원문 1개 보기 ▾' }))
  const stage = stageRow('APPLICATION')
  expect(stage.getByText('사업 1 · 참여-신청서.hwpx · 문단 1–12')).toBeTruthy()
  expect(stage.getByText('신청서 서식')).toBeTruthy()
  expect(stage.getByText('다른 4개 단계에도 인용')).toBeTruthy()
  // 빈 날짜 · 서명란은 빼고, 관련 줄 앞뒤와 상위 □ 항목만 보여요. 잘리지 않은 인용이라 [전체 n줄 보기]예요.
  expect(stage.queryByText('[서식 1] 참여 신청서')).toBeNull()
  expect(stage.getByText('신청방법')).toBeTruthy()
  expect(stage.getAllByText(/^⋯ \d줄 접힘$/).map(node => node.props.children.join(''))).toEqual(['⋯ 1줄 접힘', '⋯ 2줄 접힘', '⋯ 2줄 접힘'])
  fireEvent.press(stage.getByRole('button', { name: '전체 9줄 보기 ▾' }))
  expect(stage.getByRole('button', { name: '간단히 보기 ▴' }).props.accessibilityState.expanded).toBe(true)
  expect(stage.getByText('[서식 1] 참여 신청서')).toBeTruthy()
  expect(stage.getByText('사업비 지급')).toBeTruthy()
  expect(stage.queryByText(/인용 앞뒤를 포함한/)).toBeNull()
  expect(stage.queryByText(/2026년 월 일|서명 또는 인/)).toBeNull()
})

test('an unknown outcome says when the block lifts and an expired one explains the cleanup', () => {
  const unknown = { ...reviewRunFixture('RUNNING'), status: 'UNKNOWN' as const, failureCode: 'RUN_OUTCOME_UNKNOWN' }
  const view = render(<ReviewResult run={unknown} currentRevision={1} names={{}} onRefresh={jest.fn()} onSupplement={jest.fn()} />)
  expect(screen.getByText(/30분 안에 실패로 정리되면 다시 분석할 수 있어요/)).toBeTruthy()
  expect(screen.queryByText(/운영자 확인/)).toBeNull()
  view.unmount()
  const expired = { ...reviewRunFixture('FAILED'), failureCode: 'RUN_OUTCOME_UNKNOWN_EXPIRED' }
  render(<ReviewResult run={expired} currentRevision={1} names={{}} onRefresh={jest.fn()} onSupplement={jest.fn()} />)
  expect(screen.getByText(/완료 여부를 끝내 확인하지 못해 실패로 정리했어요/)).toBeTruthy()
})
