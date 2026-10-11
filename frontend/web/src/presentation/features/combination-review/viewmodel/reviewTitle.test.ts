import { describe, expect, it } from 'vitest'

import { reviewAutoTitle, shortProgramName } from './reviewTitle'

describe('검토 자동 제목', () => {
  it('공고 제목에서 지역 꼬리표 · 연도 · 공통 꼬리를 빼고 길면 줄인다', () => {
    expect(shortProgramName('[경북] 2026년 제조업AI융합기반조성사업 경북AX랩 활용기업 모집 공고')).toBe('제조업AI융합기반조성사업 경북AX…')
    expect(shortProgramName('2026년 서울창업센터 관악 X SK에코플랜트 오픈이노베이션 프로그램 참여기업 모집')).toBe('서울창업센터 관악 X SK에코플랜…')
    expect(shortProgramName('청년창업 사업화 지원 공고')).toBe('청년창업 사업화 지원')
    expect(shortProgramName('2026 SVC Seoul 멤버십(확장형) 모집공고')).toBe('SVC Seoul 멤버십(확장형)')
  })

  it('꼬리를 다 빼서 비면 원래 제목을 쓴다', () => {
    expect(shortProgramName('모집 공고')).toBe('모집 공고')
  })

  it('"사업 1 짧은 이름 X 사업 2 짧은 이름 검토"로 만든다', () => {
    expect(reviewAutoTitle('청년창업 사업화 지원 공고', '딥테크 성장 지원 공고')).toBe('청년창업 사업화 지원 X 딥테크 성장 지원 검토')
  })
})
