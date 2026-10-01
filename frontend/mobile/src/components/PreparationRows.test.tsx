import { fireEvent, render, screen } from '@testing-library/react-native'
import { router } from 'expo-router'
import { ProgramPreparationSection, ReviewRow } from './PreparationRows'
import { mobileReview, reviewRunFixture } from '../test/reviewFixtures'

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }))
jest.mock('./usePreparationWorkspace', () => ({ usePreparationWorkspace: () => ({ loading: false, preparations: [], reviews: [], preparationError: null, reviewError: null, refresh: jest.fn() }) }))

test('current execution summaries open the native owned run and format UTC timestamps in Seoul', () => {
  const run = { ...reviewRunFixture('SUCCEEDED'), startedAt: '2026-09-30T15:30:00Z' }
  render(<ReviewRow item={{ review: mobileReview, latestRun: run }} />)
  expect(screen.getByText('2개 공고 · 10.01 실행 · 결과 보기')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('동시 신청 검토 열기'))
  expect(router.push).toHaveBeenCalledWith({ pathname: '/all/reviews/[id]', params: { id: '5', runId: '6' } })
})
test('old input results remain visibly stale and do not claim a current run link', () => {
  render(<ReviewRow item={{ review: { ...mobileReview, inputRevision: 2 }, latestRun: reviewRunFixture('SUCCEEDED') }} />)
  expect(screen.getByText('입력 변경')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('동시 신청 검토 열기'))
  expect(router.push).toHaveBeenCalledWith({ pathname: '/all/reviews/[id]', params: { id: '5' } })
})
test('a saved program starts native selection with a public composite identity only', () => {
  render(<ProgramPreparationSection identity={{ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_100' }} token="owner" />)
  fireEvent.press(screen.getByText('중복 검토 요청'))
  expect(router.push).toHaveBeenCalledWith({ pathname: '/all/reviews/new', params: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_100' } })
})
