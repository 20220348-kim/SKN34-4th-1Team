import { reviewStages, unknownParticipation, unknownRelation, type CombinationReview, type ReviewRun } from '@govbiz/shared/domain/entities/CombinationReview'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'

export const reviewTimeFixture = '2026-10-01T09:00:00+09:00'
export const reviewRequestKey = '00000000-0000-4000-8000-000000000001'
export const reviewPrograms: SupportProgram[] = ['PBLN_100', 'PBLN_200', 'PBLN_300'].map((id, index) => ({
  sourceCode: 'BIZINFO', id, title: `검토 사업 ${index + 1}`, organization: '모의 기관', summary: '공식 API 요약 테스트',
  regions: ['전국'], categories: ['기술'], targetDescription: '중소기업', applicationPeriod: '2026.10.01 ~ 2026.10.20',
  applicationStartDate: '2026-10-01', applicationEndDate: '2026-10-20', status: 'OPEN', sourceName: '기업마당',
  sourceUrl: 'https://example.test/program', matchedReasons: [], recommendationScore: null, eligibilityReview: null,
}))
export const mobileReview: CombinationReview = { id: 5, title: '동시 신청 검토', inputRevision: 1,
  createdAt: reviewTimeFixture, updatedAt: reviewTimeFixture, programs: reviewPrograms.slice(0, 2).map(program => ({
    sourceCode: program.sourceCode, sourceProgramId: program.id, subProgramId: null, participation: unknownParticipation(),
  })) }
export function reviewRunFixture(status: ReviewRun['status'] = 'QUEUED'): ReviewRun {
  return { id: 6, reviewId: 5, inputRevision: 1, requestKey: reviewRequestKey, status,
    failureCode: status === 'FAILED' ? 'SOURCE_UNAVAILABLE' : null, startedAt: reviewTimeFixture,
    finishedAt: ['QUEUED', 'RUNNING'].includes(status) ? null : reviewTimeFixture,
    input: { title: mobileReview.title, programs: mobileReview.programs, additionalFacts: '', asOfDate: '2026-10-01' },
    evidence: status === 'SUCCEEDED' ? { reviewStatus: 'AUTOMATIC_UNREVIEWED', coverageWarnings: ['미수집 자료가 있습니다.'],
      documents: [{ programIndex: 0, sourceUrl: 'https://example.test/source.pdf', sourcePageUrl: 'https://example.test/notice',
        fileName: '모의-공고.pdf', format: 'PDF', rawHash: 'a'.repeat(64), textHash: 'b'.repeat(64), parserVersion: 'test', fetchedAt: reviewTimeFixture }],
      blocks: [{ id: 'E1', programIndex: 0, documentHash: 'a'.repeat(64), locator: '3쪽 · 비용 제한', text: '동일 비용을 중복 지원하지 않습니다.' }],
    } : null,
    configuration: status === 'SUCCEEDED' ? { contractVersion: 'test', model: 'stub-no-paid-call', promptVersion: 'test' } : null,
    analysis: status === 'SUCCEEDED' ? { summary: '추가 사실 확인이 필요합니다.', limitations: ['전체 지원 이력을 확인하지 않았습니다.'],
      pairs: [{ firstProgramIndex: 0, secondProgramIndex: 1, stages: reviewStages.map(stage => ({ stage, judgment: 'NEEDS_FACTS',
        scope: '동일 비용', explanation: '과제·비용 관계를 확인해 주세요.', questions: ['같은 비용인가요?'], requiresInstitutionConfirmation: false,
        citations: [{ evidenceId: 'E1', quote: '동일 비용을 중복 지원하지 않습니다.' }],
      })) }],
    } : null,
  }
}

/** 신청 자격 항목 한 줄을 그대로 인용해 [앞뒤 원문 보기]가 생기는 원문 조각이에요. */
export const answerApplyQuote = '◦ 중복지원은 최근 2년 이내 동일제품에 대한 동일내용 지원 여부로 판단합니다.'

/**
 * 세 질문 방식(combination-review-v3) 실행이에요. 웹 시험과 같은 판정 조합으로, 신청은 조건부(조건 2개), 함께 수행은 기관 확인
 * (물어볼 문장 · 걸리면 생기는 일), 같은 과제·비용은 불가(걸리면 생기는 일)이고 근거는 두 사업의 원문 조각에서 골라요.
 */
export function answerRunFixture(): ReviewRun {
  const base = reviewRunFixture('SUCCEEDED')
  const document = base.evidence!.documents[0]
  return { ...base, id: 31, requestKey: '00000000-0000-4000-8000-000000000031',
    input: { ...base.input, additionalFacts: '확약 제출일은 확인 필요', relation: unknownRelation() },
    evidence: { ...base.evidence!,
      documents: [document, { ...document, programIndex: 1, fileName: '모집공고.pdf', rawHash: 'c'.repeat(64) }],
      blocks: [
        { id: 'E0', programIndex: 0, documentHash: 'a'.repeat(64), locator: 'PDF page 3 part 1', text: ['□ 신청 자격', answerApplyQuote, '□ 신청방법', '◦ 이메일 접수'].join('\n') },
        { id: 'E1', programIndex: 1, documentHash: 'c'.repeat(64), locator: 'PDF page 7 part 1', text: '단, 중복지원 기간이 겹치지 않는 경우 지원가능합니다. 협약 후 확인되면 협약을 해약합니다.' },
        { id: 'E2', programIndex: 1, documentHash: 'c'.repeat(64), locator: 'PDF page 9 part 1', text: '동일한 소비액 인정항목에 대해서는 중복 정산 불가하며 해당 금액을 환수합니다.' },
      ] },
    configuration: { contractVersion: 'combination-review-v3', model: 'stub-no-paid-call', promptVersion: 'test-v3' },
    analysis: { summary: '세 질문 모의 분석입니다.', limitations: ['전체 지원 이력을 확인하지 않았습니다.'], pairs: [{ firstProgramIndex: 0, secondProgramIndex: 1, stages: [], answers: [
      { question: 'APPLY', verdict: 'CONDITIONAL', explanation: '최근 같은 제품으로 지원받았는지에 따라 달라요.', institutionQuestion: '', consequences: [],
        citations: [{ evidenceId: 'E0', quote: answerApplyQuote }],
        conditions: [
          { condition: '최근 2년 안에 같은 제품으로 같은 내용의 지원을 받았다면', result: 'NOT_ALLOWED', citations: [{ evidenceId: 'E0', quote: '최근 2년 이내 동일제품에 대한 동일내용 지원' }] },
          { condition: '그 밖의 경우', result: 'ALLOWED', citations: [] },
        ] },
      { question: 'CONCURRENT', verdict: 'ASK_INSTITUTION', explanation: '기간 기준이 공고마다 달라 기관 판단이 필요해요.', institutionQuestion: '두 사업의 협약 기간이 일부 겹치면 함께 수행할 수 있나요?', conditions: [],
        citations: [{ evidenceId: 'E1', quote: '중복지원 기간이 겹치지 않는 경우 지원가능합니다.' }],
        consequences: [{ moment: 'AGREEMENT', action: '협약 후 확인되면 협약 해약', citations: [{ evidenceId: 'E1', quote: '협약 후 확인되면 협약을 해약합니다.' }] }] },
      { question: 'SAME_SUBJECT', verdict: 'NOT_ALLOWED', explanation: '같은 비용 항목은 두 번 정산할 수 없어요.', institutionQuestion: '', conditions: [],
        citations: [{ evidenceId: 'E2', quote: '동일한 소비액 인정항목에 대해서는 중복 정산 불가' }],
        consequences: [{ moment: 'SETTLEMENT', action: '해당 금액 환수', citations: [{ evidenceId: 'E2', quote: '해당 금액을 환수합니다.' }] }] },
    ] }] },
  }
}
