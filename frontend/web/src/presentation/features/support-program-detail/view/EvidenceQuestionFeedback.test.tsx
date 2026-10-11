// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { EvidenceQuestionFeedback } from './EvidenceQuestionFeedback'

afterEach(cleanup)

// 실제 원문 덩어리처럼 Core 머리 줄과 줄 사이 빈 줄이 있고, 답을 받친 줄은 머리 정보 뒤에 있습니다.
const excerpt = [
  '공고명: 2026년 창업-BuS 프로그램 참여기업 모집 공고', '공식 원문: https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_1',
  '소관부처·지자체', '중소벤처기업부', '사업수행기관', '제주창조경제혁신센터', '신청기간', '예산 소진시까지', '사업개요',
  '직접 투자, TIPS 추천 검토, 투자 네트워크 연계를 통해 기업의 성공적인 스케일업을 지원합니다.',
  '☞ 예비창업자 또는 창업 7년 이내 스타트업', '- (중점분야) 우주ㆍ항공, 해양, 친환경ㆍ에너지, AIㆍ빅데이터',
].join('\n\n')

function renderAnswer(answer: string) {
  render(<EvidenceQuestionFeedback compact state={{ status: 'answered', answer: { answer, answerStatus: 'ANSWERED', citations: [{
    excerpt, sourceUrl: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_1', sourceLabel: '기업마당 상세 본문', chunkOrder: 0,
  }] } }} />)
  fireEvent.click(screen.getByRole('button', { name: '근거 원문 1건 보기' }))
  return document.querySelector('blockquote p')!
}

describe('EvidenceQuestionFeedback 근거 원문 미리보기', () => {
  it('접은 미리보기는 답과 겹치는 줄 한 줄 앞에서 시작하고, 전체 보기는 머리 줄을 뺀 처음부터 보여 준다', () => {
    const preview = renderAnswer('예비창업자 또는 창업 7년 이내 스타트업이 지원 대상입니다.')
    expect(preview.textContent).toBe('…\n직접 투자, TIPS 추천 검토, 투자 네트워크 연계를 통해 기업의 성공적인 스케일업을 지원합니다.\n'
      + '☞ 예비창업자 또는 창업 7년 이내 스타트업\n- (중점분야) 우주ㆍ항공, 해양, 친환경ㆍ에너지, AIㆍ빅데이터')
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    expect(preview.textContent?.startsWith('소관부처·지자체\n중소벤처기업부')).toBe(true)
    expect(preview.textContent).not.toContain('공고명:')
    expect(preview.textContent).not.toContain('공식 원문:')
  })

  it('두 낱말 이상 겹치는 줄이 없으면 처음부터 보여 준다', () => {
    const preview = renderAnswer('문의는 담당 부서로 해 주세요.')
    expect(preview.textContent?.startsWith('소관부처·지자체\n중소벤처기업부')).toBe(true)
  })
})
