import type { CombinationReview, ReviewRun } from '../../../../domain/entities/CombinationReview'

export const reviewFixture: CombinationReview = {
  id: 12, title: '창업 지원사업 검토', inputRevision: 2, createdAt: '2026-09-09T09:00:00+09:00', updatedAt: '2026-09-09T10:00:00+09:00',
  programs: ['PBLN_100', 'PBLN_200'].map((sourceProgramId) => ({ sourceCode: 'BIZINFO', sourceProgramId, subProgramId: null,
    participation: { applicationSubmitted: 'UNKNOWN', selected: 'YES', commitmentSubmitted: 'NO', agreementSigned: 'UNKNOWN', executionStatus: 'IN_PROGRESS', fundingReceived: 'UNKNOWN' } })),
}
export const runFixture: ReviewRun = {
  id: 30, reviewId: 12, inputRevision: 1, requestKey: '00000000-0000-4000-8000-000000000001', status: 'SUCCEEDED',
  input: { title: '과거 검토 입력', programs: [...reviewFixture.programs].reverse(), additionalFacts: '확약 제출일은 확인 필요', asOfDate: '2026-09-09' },
  evidence: {
    reviewStatus: 'AUTOMATIC_UNREVIEWED', coverageWarnings: ['기관의 별도 협약 지침은 확보하지 않았습니다.'],
    documents: [{ programIndex: 0, sourceUrl: 'https://www.bizinfo.go.kr/example.pdf', sourcePageUrl: 'https://www.bizinfo.go.kr/example', fileName: '공식-원문-모의.pdf', format: 'PDF', rawHash: 'a'.repeat(64), textHash: 'b'.repeat(64), parserVersion: 'fixture-v1', fetchedAt: '2026-09-09T09:00:00+09:00' }],
    blocks: [{ id: 'E0', programIndex: 0, documentHash: 'a'.repeat(64), locator: 'PDF 3쪽, 문단 2', text: '동일 목적의 사업비는 중복 지원하지 않습니다.' }],
  },
  configuration: { contractVersion: 'fixture-v1', model: 'mock-no-paid-call', promptVersion: 'fixture-v1' },
  analysis: { summary: '모의 분석입니다. 기관 확인이 필요합니다.', limitations: ['가상 응답이며 실제 규정 해석 결과가 아닙니다.'], pairs: [{ firstProgramIndex: 0, secondProgramIndex: 1,
    stages: (['APPLICATION', 'SELECTION', 'COMMITMENT', 'AGREEMENT', 'EXECUTION', 'FUNDING'] as const).map((stage, i) => ({ stage,
      judgment: (['NEEDS_FACTS', 'INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE', 'NEEDS_FACTS', 'RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE'] as const)[i],
      scope: '동일 목적 사업비에 한정', explanation: '공식 원문 및 사실 관계를 확인해야 합니다.', questions: ['지원 목적이 동일한가요?'], requiresInstitutionConfirmation: i < 4,
      citations: [{ evidenceId: 'E0', quote: '동일 목적의 사업비는 중복 지원하지 않습니다.' }],
    })),
  }] }, failureCode: null, startedAt: '2026-09-09T09:00:00+09:00', finishedAt: '2026-09-09T09:01:00+09:00',
}

/**
 * 세 질문 방식(combination-review-v3) 실행입니다. 신청은 조건부(조건 2개), 함께 수행은 기관 확인(물어볼 문장 · 걸리면 생기는 일),
 * 같은 과제·비용은 불가(걸리면 생기는 일)이고, 근거는 두 사업의 원문 조각에서 고릅니다.
 */
export const answerRunFixture: ReviewRun = {
  ...runFixture, id: 31, inputRevision: 2, requestKey: '00000000-0000-4000-8000-000000000031',
  input: { ...runFixture.input, programs: reviewFixture.programs, relation: { sameProject: 'UNKNOWN', sameCost: 'UNKNOWN' } },
  evidence: {
    ...runFixture.evidence!,
    documents: [runFixture.evidence!.documents[0]!, { ...runFixture.evidence!.documents[0]!, programIndex: 1, fileName: '모집공고.pdf', rawHash: 'c'.repeat(64) }],
    blocks: [
      { id: 'E0', programIndex: 0, documentHash: 'a'.repeat(64), locator: 'PDF 3쪽, 문단 2', text: '중복지원은 최근 2년 이내 동일제품에 대한 동일내용 지원 여부로 판단합니다.' },
      { id: 'E1', programIndex: 1, documentHash: 'c'.repeat(64), locator: 'PDF 7쪽, 문단 1', text: '단, 중복지원 기간이 겹치지 않는 경우 지원가능합니다. 협약 후 확인되면 협약을 해약합니다.' },
      { id: 'E2', programIndex: 1, documentHash: 'c'.repeat(64), locator: 'PDF 9쪽, 문단 3', text: '동일한 소비액 인정항목에 대해서는 중복 정산 불가하며 해당 금액을 환수합니다.' },
    ],
  },
  configuration: { contractVersion: 'combination-review-v3', model: 'mock-no-paid-call', promptVersion: 'fixture-v3' },
  analysis: {
    summary: '세 질문 모의 분석입니다.', limitations: ['가상 응답이며 실제 규정 해석 결과가 아닙니다.'],
    pairs: [{ firstProgramIndex: 0, secondProgramIndex: 1, stages: [], answers: [
      { question: 'APPLY', verdict: 'CONDITIONAL', explanation: '최근 같은 제품으로 지원받았는지에 따라 달라요.', institutionQuestion: '', consequences: [],
        citations: [{ evidenceId: 'E0', quote: '중복지원은 최근 2년 이내 동일제품에 대한 동일내용 지원 여부로 판단합니다.' }],
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
    ] }],
  },
}
