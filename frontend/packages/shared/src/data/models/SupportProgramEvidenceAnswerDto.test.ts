import { describe, expect, it } from 'vitest'

import { parseSupportProgramEvidenceAnswerDto, toSupportProgramEvidenceAnswer } from './SupportProgramEvidenceAnswerDto'

const kStartupUrl = 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178927'
const citation = { excerpt: '제출서류: 참가신청서 1부, 발표자료 1부', sourceUrl: kStartupUrl, chunkOrder: 2 }
const answer = { answer: '참가신청서와 발표자료를 제출합니다.', answerStatus: 'ANSWERED', citations: [{ ...citation, sourceLabel: 'K-Startup 상세 본문' }] }

describe('원문 근거 답변 인용의 원문 이름', () => {
  it('K-Startup 공식 상세 인용의 원문 이름을 도메인으로 복사한다', () => {
    const domain = toSupportProgramEvidenceAnswer(parseSupportProgramEvidenceAnswerDto(answer, 'KSTARTUP'))

    expect(domain.citations).toEqual([{ ...citation, sourceLabel: 'K-Startup 상세 본문' }])
  })

  it('원문 이름이 없거나 비었거나 너무 긴 인용과 다른 제공처 주소의 인용은 거부한다', () => {
    for (const citations of [
      [citation],
      [{ ...citation, sourceLabel: '   ' }],
      [{ ...citation, sourceLabel: '가'.repeat(81) }],
    ]) {
      expect(() => parseSupportProgramEvidenceAnswerDto({ ...answer, citations }, 'KSTARTUP')).toThrow()
    }
    expect(() => parseSupportProgramEvidenceAnswerDto(answer, 'BIZINFO')).toThrow()
  })
})
