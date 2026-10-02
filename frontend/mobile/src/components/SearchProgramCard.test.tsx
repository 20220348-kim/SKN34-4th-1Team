import { Linking } from 'react-native'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { SearchProgramCard } from './SearchProgramCard'
import { programDetail } from '../test/preparationFixtures'

const program = { ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null }
test('unevaluated results do not fabricate scores or evidence and retain the compound detail identity', () => {
  const open = jest.fn()
  render(<SearchProgramCard program={program} onOpen={open} />)
  expect(screen.getByText('자격 미평가')).toBeTruthy()
  expect(screen.queryByText(/관련도 \d/)).toBeNull()
  fireEvent.press(screen.getByLabelText(`${program.title}, 상세 보기`))
  expect(open).toHaveBeenCalledWith({ sourceCode: program.sourceCode, sourceProgramId: program.id })
})
test('official-link failures remain explicit', async () => {
  const link = jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('unavailable'))
  render(<SearchProgramCard program={program} onOpen={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('원문 보기'))
  await screen.findByText('공식 원문을 열지 못했습니다. 다시 시도해 주세요.')
  expect(link).toHaveBeenCalledWith(program.sourceUrl)
  link.mockRestore()
})
