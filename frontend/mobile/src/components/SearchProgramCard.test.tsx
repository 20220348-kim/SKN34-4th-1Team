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
test('programs the server moved back for another region show the tag notice without changing the eligibility badge', () => {
  const otherRegion = { ...program, regions: ['경북', '전남'], regionTagMismatch: true }
  const { rerender } = render(<SearchProgramCard program={otherRegion} onOpen={jest.fn()} />)
  expect(screen.getByText('다른 지역 한정일 수 있음')).toBeTruthy()
  expect(screen.getByText(/회사 소재지와 공고 분류 지역\(경북 · 전남\)이 달라요\. 그래서 결과 뒤쪽에 두었어요\./)).toBeTruthy()
  expect(screen.getByText('자격 미평가')).toBeTruthy()

  rerender(<SearchProgramCard program={otherRegion} />)
  expect(screen.getByText('다른 지역 한정일 수 있음')).toBeTruthy()
  expect(screen.queryByText(/결과 뒤쪽에 두었어요/)).toBeNull()

  rerender(<SearchProgramCard program={{ ...otherRegion, regionTagMismatch: false }} onOpen={jest.fn()} />)
  expect(screen.queryByText('다른 지역 한정일 수 있음')).toBeNull()
})
const kStartup = { sourceCode: 'KSTARTUP', id: '179197', sourceName: 'K-Startup', evidenceQuestionSupported: false,
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=179197' }
test('a program the server grouped from two sources names both and opens each official page', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  render(<SearchProgramCard program={{ ...program, alsoPostedBy: [kStartup] }} onOpen={jest.fn()} />)
  expect(screen.getByText('기업마당·K-Startup 함께 게시')).toBeTruthy()
  expect(screen.queryByLabelText('원문 보러가기')).toBeNull()
  fireEvent.press(screen.getByLabelText('기업마당 원문 보러가기'))
  fireEvent.press(screen.getByLabelText('K-Startup 원문 보러가기'))
  expect(open).toHaveBeenNthCalledWith(1, program.sourceUrl)
  expect(open).toHaveBeenNthCalledWith(2, kStartup.sourceUrl)
  open.mockRestore()
})
test('the question action is offered only for programs that accept official-source questions', () => {
  const ask = jest.fn()
  const supported = { ...program, evidenceQuestionSupported: true }
  const { rerender } = render(<SearchProgramCard program={supported} onOpen={jest.fn()} onAsk={ask} signedIn />)
  fireEvent.press(screen.getByLabelText(`${program.title}, 이 공고에 질문하기`))
  expect(ask).toHaveBeenLastCalledWith({ sourceCode: program.sourceCode, sourceProgramId: program.id })

  rerender(<SearchProgramCard program={supported} onOpen={jest.fn()} onAsk={ask} />)
  fireEvent.press(screen.getByLabelText(`${program.title}, 로그인하고 질문하기`))
  expect(ask).toHaveBeenCalledTimes(2)

  // K-Startup 칸이라도 함께 묶인 기업마당 게시물이 질문을 받으면 그 게시물로 묻습니다.
  const bizInfo = { ...kStartup, sourceCode: 'BIZINFO', id: 'PBLN_1', sourceName: '기업마당', evidenceQuestionSupported: true,
    sourceUrl: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_1' }
  rerender(<SearchProgramCard program={{ ...program, sourceCode: 'KSTARTUP', sourceName: 'K-Startup', evidenceQuestionSupported: false,
    alsoPostedBy: [bizInfo] }} onOpen={jest.fn()} onAsk={ask} signedIn />)
  fireEvent.press(screen.getByLabelText(`${program.title}, 이 공고에 질문하기`))
  expect(ask).toHaveBeenLastCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1' })

  rerender(<SearchProgramCard program={{ ...program, evidenceQuestionSupported: false }} onOpen={jest.fn()} onAsk={ask} signedIn />)
  expect(screen.queryByLabelText(/질문하기/)).toBeNull()
  rerender(<SearchProgramCard program={supported} />)
  expect(screen.queryByLabelText(/질문하기/)).toBeNull()
})
test('official-link failures remain explicit', async () => {
  const link = jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('unavailable'))
  render(<SearchProgramCard program={program} onOpen={jest.fn()} />)
  fireEvent.press(screen.getByRole('link', { name: '원문 보러가기' }))
  await screen.findByText('공식 원문을 열지 못했습니다. 다시 시도해 주세요.')
  expect(link).toHaveBeenCalledWith(program.sourceUrl)
  link.mockRestore()
})

test('the compact source link opens the official page while CNTRADE still identifies its notice list', async () => {
  const link = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  const view = render(<SearchProgramCard program={program} onOpen={jest.fn()} />)
  fireEvent.press(screen.getByRole('link', { name: '원문 보러가기' }))
  expect(link).toHaveBeenCalledWith(program.sourceUrl)
  view.rerender(<SearchProgramCard program={{ ...program, sourceCode: 'CNTRADE_NOTICE', sourceUrl: 'https://cntrade.chungnam.go.kr/notices' }} onOpen={jest.fn()} />)
  fireEvent.press(screen.getByRole('link', { name: '공식 공지 목록 보러가기' }))
  expect(link).toHaveBeenLastCalledWith('https://cntrade.chungnam.go.kr/notices')
  link.mockRestore()
})

test('a different known classification region is a caution, never an ineligibility verdict', () => {
  const props = { onOpen: jest.fn(), searchRegion: '경기도 화성시' }
  const view = render(<SearchProgramCard program={{ ...program, regions: ['부산'] }} {...props} />)
  expect(screen.getByText(/검색 지역\(경기\)과 공고 분류 지역\(부산\)이 달라요/)).toBeTruthy()
  expect(screen.queryByText('신청 불가')).toBeNull()
  view.rerender(<SearchProgramCard program={{ ...program, regions: ['부산', '전국'] }} {...props} />)
  expect(screen.queryByText(/다른 지역 조건 확인 필요/)).toBeNull()
  view.rerender(<SearchProgramCard program={{ ...program, regions: ['부산'] }} {...props} searchRegion="알 수 없는 지역" />)
  expect(screen.queryByText(/다른 지역 조건 확인 필요/)).toBeNull()
  view.rerender(<SearchProgramCard program={{ ...program, regions: ['경기'] }} {...props} />)
  expect(screen.queryByText(/다른 지역 조건 확인 필요/)).toBeNull()
  view.rerender(<SearchProgramCard program={{ ...program, regions: ['부산', '미확정'] }} {...props} />)
  expect(screen.queryByText(/다른 지역 조건 확인 필요/)).toBeNull()
})
