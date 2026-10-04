// Synthetic HTTP responses for both restore browser tests; no model or DB calls.
export function ragFixture() {
  const observation = { answer: '청년 사업자 지원', answer_status: 'ANSWERED', retrieved_chunk_ids: ['chunk-a'],
    context_chunk_ids: ['chunk-a'], cited_chunk_ids: ['chunk-a'], trace_id: null, failure: null }
  const material = {
    schema_version: 1, evaluation_scope: 'source-chunks-retrieval-answer', reference_source: 'ai-authored-not-human-reviewed', baseline_eligible: false,
    material_sha256: 'a'.repeat(64), fixture_sha256: 'b'.repeat(64), candidate_capture_sha256: 'c'.repeat(64), reference_capture_sha256: 'd'.repeat(64),
    candidate_measurement_kind: 'integration-stub-replay', reference_measurement_kind: 'synthetic-contract-check',
    cases: ['R01', 'R02'].map((id, index) => ({
      case_id: id, question: index ? '신청 기한은?' : '지원 대상은?', document_id: `BIZINFO:TEST-${id}`,
      source_url: 'https://example.invalid/notice', content: `<script>원문 ${id}</script>\n한글 공고`, content_sha256: 'e'.repeat(64), chunk_version: 'v1',
      chunks: [{ id: 'chunk-a', order: 0, text: '청년 사업자' }, { id: 'chunk-b', order: 1, text: '신청 기한 없음' }],
      expected_status: 'ANSWERED', expected_evidence: [{ chunk_id: 'chunk-a', quote: '청년 사업자' }],
      candidate: index ? { ...observation, answer: null, answer_status: null, cited_chunk_ids: null, failure: { stage: 'answer', code: 'timeout' } } : { ...observation },
      reference: { ...observation, answer: '<img src=x onerror=alert(1)> 근거가 부족합니다.', answer_status: 'INSUFFICIENT_EVIDENCE', cited_chunk_ids: [] },
    })),
  }
  return {
    spec: { dataset: { fixture_sha256: material.fixture_sha256, case_ids: material.cases.map((item) => item.case_id) },
      evaluation: { sha256: 'f'.repeat(64) }, generation: null,
      candidate_sha256: material.candidate_capture_sha256, reference_sha256: material.reference_capture_sha256 },
    state: {
      material, reviewer_id: 'core:1', review_version: 0,
      baseline: { version: 0, run_id: null, assessment_id: null, selected: false, history: [] },
      reference_review: { rubric: { version: 'rag-reference-review-v1', scope: 'this-run-all-cases', description: '전체 사례 검토' }, fixture_sha256: material.fixture_sha256,
        case_ids: material.cases.map((item) => item.case_id), approved: false, current_id: null, can_revoke: false, history: [] },
      quality: { status: 'NOT_EVALUATED', is_current: false, current_id: null, input_sha256: '1'.repeat(64), baseline_eligible: false,
        policy: { definition: { version: 'rag-review-quality-v2', scope: 'source-chunks-retrieval-answer', pass_enabled: false, baseline_eligible: false, reference_review_supported: true }, code_sha256: '2'.repeat(64) }, history: [] },
      rubric: { version: 'rag-case-review-v1', criteria: [
        { key: 'retrieval', label: '검색 적합성', description: '질문에 맞는 검색' },
        { key: 'answer', label: '답변 정확성', description: '원문과 일치하는 답변' },
        { key: 'citation', label: '인용 적합성', description: '주장의 근거' },
      ] }, case_reviews: [],
    },
  }
}
