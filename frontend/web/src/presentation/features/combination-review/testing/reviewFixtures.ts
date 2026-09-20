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
