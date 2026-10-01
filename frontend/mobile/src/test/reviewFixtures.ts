import { reviewStages, unknownParticipation, type CombinationReview, type ReviewRun } from '@govbiz/shared/domain/entities/CombinationReview'
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
