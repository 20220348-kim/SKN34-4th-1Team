import { fireEvent, render, screen } from '@testing-library/react-native'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import { preparation, programDetail } from '../test/preparationFixtures'
import { SavedProgramPipeline } from './SavedProgramPipeline'

const saved: SavedSupportProgram = { savedAt: '2026-10-05', program: {
  ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null,
} }
const callbacks = () => ({ onOpenProgram: jest.fn(), onOpenStage: jest.fn(), onNewDocument: jest.fn() })

test('starts with the first populated stage and shows only that stage while keeping document identity', () => {
  const actions = callbacks()
  const applied = { ...preparation, id: 11, formTitle: '별도 작성본', progressStage: 'APPLIED' as const }
  const hidden = { ...preparation, id: 12, sourceCode: 'KSTARTUP', formTitle: '담지 않은 사업의 문서' }
  render(<SavedProgramPipeline items={[saved]} preparations={[preparation, applied, hidden]} busy={false} {...actions} />)

  expect(screen.getByRole('tab', { name: '준비 중 1건' }).props.accessibilityState.selected).toBe(true)
  expect(screen.getByText('사업계획서')).toBeTruthy()
  expect(screen.queryByText('별도 작성본')).toBeNull()
  expect(screen.queryByText('담지 않은 사업의 문서')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '지원 완료 1건' }))
  expect(screen.queryByText('사업계획서')).toBeNull()
  expect(screen.getByText('별도 작성본')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('별도 작성본 단계 바꾸기'))
  expect(actions.onOpenStage).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }, 11)
  fireEvent.press(screen.getByLabelText('테스트 지원사업 상세 보기'))
  expect(actions.onOpenProgram).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'P/123' })
})

test('interest starts preparation for the full source identity and empty stages offer no creation action', () => {
  const actions = callbacks()
  const other = { ...saved, program: { ...saved.program, sourceCode: 'KSTARTUP', title: '다른 제공처 공고' } }
  render(<SavedProgramPipeline items={[saved, other]} preparations={[preparation]} busy={false} {...actions} />)

  expect(screen.getByRole('tab', { name: '관심 1건' }).props.accessibilityState.selected).toBe(true)
  expect(screen.queryByText('사업계획서')).toBeNull()
  fireEvent.press(screen.getByLabelText('다른 제공처 공고 신청 문서 작성'))
  expect(actions.onNewDocument).toHaveBeenCalledWith({ sourceCode: 'KSTARTUP', sourceProgramId: 'P/123' })
  fireEvent.press(screen.getByRole('tab', { name: '결과 0건' }))
  expect(screen.getByText('아직 결과를 기록한 신청 문서가 없어요.')).toBeTruthy()
  expect(screen.queryByText('신청 문서 작성')).toBeNull()
  expect(actions.onNewDocument).toHaveBeenCalledTimes(1)
})

test('keeps the chosen stage after an update, refreshes counts, and disables only stage mutation while busy', () => {
  const actions = callbacks()
  const view = render(<SavedProgramPipeline items={[saved]} preparations={[preparation]} busy={true} {...actions} />)
  expect(screen.getByLabelText('사업계획서 단계 바꾸기').props.accessibilityState.disabled).toBe(true)
  fireEvent.press(screen.getByLabelText('사업계획서 단계 바꾸기'))
  expect(actions.onOpenStage).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('테스트 지원사업 상세 보기'))
  expect(actions.onOpenProgram).toHaveBeenCalledTimes(1)

  view.rerender(<SavedProgramPipeline items={[saved]} preparations={[{ ...preparation, progressStage: 'DOCUMENT_REVIEW' }]}
    busy={false} {...actions} />)
  expect(screen.getByRole('tab', { name: '준비 중 0건' }).props.accessibilityState.selected).toBe(true)
  expect(screen.getByText('준비 중인 신청 문서가 없어요.')).toBeTruthy()
  expect(screen.queryByText('사업계획서')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '심사 중 1건' }))
  expect(screen.getByText('서류 심사')).toBeTruthy()
  expect(screen.getByLabelText('사업계획서 단계 바꾸기').props.accessibilityState.disabled).toBe(false)
})

test('counts both result documents and distinguishes their recorded outcome', () => {
  const actions = callbacks()
  render(<SavedProgramPipeline items={[saved]} preparations={[
    { ...preparation, progressStage: 'SELECTED' },
    { ...preparation, id: 10, formTitle: '다른 작성본', progressStage: 'REJECTED' },
  ]} busy={false} {...actions} />)
  expect(screen.getByRole('tab', { name: '결과 2건' }).props.accessibilityState.selected).toBe(true)
  expect(screen.getByText('선정')).toBeTruthy()
  expect(screen.getByText('미선정')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('다른 작성본 단계 바꾸기'))
  expect(actions.onOpenStage).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }, 10)
})
