import { describe, expect, it } from 'vitest'

import { supportProgramPostedTogetherLabel, supportProgramQuestionTarget, type SupportProgram, type SupportProgramPosting } from './SupportProgram'

const program: SupportProgram = {
  sourceCode: 'KSTARTUP', id: '179197', title: 'AI 창업 지원', organization: '창업진흥원', summary: '사업 내용',
  categories: [], regions: ['서울'], targetDescription: '창업기업', applicationPeriod: '2026-10-01 ~ 2026-10-31',
  applicationStartDate: '2026-10-01', applicationEndDate: '2026-10-31', status: 'OPEN', sourceName: 'K-Startup',
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=179197',
  matchedReasons: [], recommendationScore: 80, eligibilityReview: null,
}
const bizInfo: SupportProgramPosting = {
  sourceCode: 'BIZINFO', id: 'PBLN_1', sourceName: '기업마당', evidenceQuestionSupported: true,
  sourceUrl: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_1',
}

describe('검색 결과 한 칸에 묶인 같은 공고', () => {
  it('묶인 제공처 이름을 이 칸의 제공처부터 이어 붙이고 묶음이 없으면 표시하지 않는다', () => {
    expect(supportProgramPostedTogetherLabel({ ...program, alsoPostedBy: [bizInfo] })).toBe('K-Startup·기업마당 함께 게시')
    expect(supportProgramPostedTogetherLabel(program)).toBeNull()
    expect(supportProgramPostedTogetherLabel({ ...program, alsoPostedBy: [] })).toBeNull()
  })

  it('원문 질문은 이 칸의 공고를 먼저 쓰고, 받지 않으면 질문을 받는 같은 공고 게시물로 연다', () => {
    expect(supportProgramQuestionTarget({ ...program, evidenceQuestionSupported: true, alsoPostedBy: [bizInfo] }))
      .toEqual({ sourceCode: 'KSTARTUP', sourceProgramId: '179197' })
    expect(supportProgramQuestionTarget({ ...program, alsoPostedBy: [bizInfo] }))
      .toEqual({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1' })
    expect(supportProgramQuestionTarget({ ...program, alsoPostedBy: [{ ...bizInfo, evidenceQuestionSupported: false }] })).toBeNull()
    expect(supportProgramQuestionTarget(program)).toBeNull()
  })
})
