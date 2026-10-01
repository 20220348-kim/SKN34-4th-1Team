import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { ReviewResult } from './ReviewResult'
import { reviewRunFixture } from '../test/reviewFixtures'
import { colors } from '../ui'

test('run snapshots, questions, stages, exact citations and collection limits are readable', () => {
  const run = reviewRunFixture('SUCCEEDED')
  render(<ReviewResult run={run} currentRevision={2} names={{ 'BIZINFO:PBLN_100': '첫 사업', 'BIZINFO:PBLN_200': '둘째 사업' }} onRefresh={jest.fn()} onSupplement={jest.fn()} />)
  expect(screen.getByText(/입력 변경 전의 결과/)).toBeTruthy()
  const first = within(screen.getByTestId('comparison-program-1'))
  const second = within(screen.getByTestId('comparison-program-2'))
  expect(first.getByText('사업 1')).toBeTruthy()
  expect(first.getByText('첫 사업')).toBeTruthy()
  expect(first.queryByText('둘째 사업')).toBeNull()
  expect(second.getByText('사업 2')).toBeTruthy()
  expect(second.getByText('둘째 사업')).toBeTruthy()
  expect(screen.getByText('• 같은 비용인가요?')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('신청 · 사용자 정보 부족'))
  expect(screen.getByText('“동일 비용을 중복 지원하지 않습니다.”')).toBeTruthy()
  expect(screen.getByText('사업 1 · 3쪽 · 비용 제한')).toBeTruthy()
  fireEvent.press(screen.getByText('공식 자료·분석 한계 보기'))
  expect(screen.getByText('미수집 자료가 있습니다.')).toBeTruthy()
  expect(screen.getByText('전체 지원 이력을 확인하지 않았습니다.')).toBeTruthy()
})
test('untrusted source destinations cannot be opened', async () => {
  const run = reviewRunFixture('SUCCEEDED')
  run.evidence!.documents[0].sourcePageUrl = 'https://user:secret@example.test/private'
  const opening = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  render(<ReviewResult run={run} currentRevision={1} names={{}} onRefresh={jest.fn()} onSupplement={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('신청 · 사용자 정보 부족'))
  fireEvent.press(screen.getByText('공식 원문 확인'))
  await screen.findByText('공식 원문을 열지 못했어요. 다시 시도해 주세요.')
  expect(opening).not.toHaveBeenCalled()
  opening.mockRestore()
})

test.each([
  ['RESTRICTION_APPLIES', '제한 적용', colors.dangerSoft, colors.danger],
  ['PERMISSION_IN_SCOPE', '명시된 범위 내 허용', colors.soft, colors.primaryText],
  ['NEEDS_FACTS', '사용자 정보 부족', colors.infoSoft, colors.info],
  ['INSUFFICIENT_EVIDENCE', '공식 근거 부족', colors.warningSoft, colors.warning],
  ['CONFLICTING_EVIDENCE', '규정 충돌', colors.warningSoft, colors.warning],
] as const)('%s retains its semantic label/color and expandable stage detail', (judgment, label, backgroundColor, color) => {
  const run = reviewRunFixture('SUCCEEDED')
  run.analysis!.pairs[0].stages[0].judgment = judgment
  render(<ReviewResult run={run} currentRevision={1} names={{}} onRefresh={jest.fn()} onSupplement={jest.fn()} />)
  expect(screen.getByTestId('judgment-0-APPLICATION')).toHaveTextContent(label)
  expect(screen.getByTestId('judgment-0-APPLICATION')).toHaveStyle({ backgroundColor, color })
  const stage = screen.getByLabelText(`신청 · ${label}`)
  expect(stage.props.accessibilityState.expanded).toBe(false)
  fireEvent.press(stage)
  expect(screen.getByLabelText(`신청 · ${label}`).props.accessibilityState.expanded).toBe(true)
  expect(screen.getByText('과제·비용 관계를 확인해 주세요.')).toBeTruthy()
})
