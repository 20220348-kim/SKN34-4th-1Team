import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../fixtures/supportProgramConversation'
import { supportProgramInterpretationDtoSchema, toSupportProgramInterpretation } from './SupportProgramConversationDto'

afterEach(() => vi.useRealTimers())

describe('대화 해석 응답 계약', () => {
  const ready = readyConversationProposal(seoulConversationContext)
  it('확정 상태와 미확정 초안을 엄격하게 구분하고 필수 null 필드를 보존한다', () => {
    expect(supportProgramInterpretationDtoSchema.parse(ready)).toEqual(ready)
    expect(supportProgramInterpretationDtoSchema.parse({ status: 'CLARIFICATION_REQUIRED', proposedContext: emptyConversationContext,
      clarificationQuestion: '정확한 설립일을 알려주세요.', changedFields: [] }).proposedContext).toEqual(emptyConversationContext)
    const domain = toSupportProgramInterpretation(supportProgramInterpretationDtoSchema.parse(ready))
    expect(domain).toEqual(ready)
    expect(domain.proposedContext.companyConditions).not.toBe(ready.proposedContext.companyConditions)
    expect(domain.changedFields).not.toBe(ready.changedFields)
  })

  it('설명 답변과 이전 서버의 answer 누락을 검증하며 조건 제안과 구분한다', () => {
    const answered = { ...ready, status: 'ANSWERED', answer: '대구 무역 검색 결과는 0건입니다.\n접수 상태를 바꿔 볼 수 있어요.' }
    expect(supportProgramInterpretationDtoSchema.parse(answered)).toEqual(answered)
    const { answer: _answer, ...legacy } = ready
    expect(supportProgramInterpretationDtoSchema.parse(legacy).answer).toBeNull()
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...answered, answer: '😀'.repeat(500) }).success).toBe(true)
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...answered, answer: '답변\r\n조건\t확인' }).success).toBe(true)
  })

  it.each([
    { status: 'ANSWERED' },
    { status: 'ANSWERED', answer: '' },
    { status: 'ANSWERED', answer: ' \n ' },
    { status: 'ANSWERED', answer: '😀'.repeat(501) },
    { status: 'ANSWERED', answer: '답변\u200b' },
    { status: 'ANSWERED', answer: '답변\u0000' },
    { status: 'ANSWERED', answer: '답변', clarificationQuestion: '확인할까요?' },
    { answer: 'READY에 답변 금지' },
    { status: 'CLARIFICATION_REQUIRED', clarificationQuestion: '지역은?', answer: '답변 금지' },
    { status: 'UNKNOWN' },
    { proposedContext: { ...seoulConversationContext, query: null } },
    { proposedContext: { ...seoulConversationContext, query: '' } },
    { proposedContext: { ...seoulConversationContext, query: '   ' } },
    { proposedContext: { ...seoulConversationContext, acceptingOnly: 'true' } },
    { proposedContext: { ...seoulConversationContext, companyConditions: { region: '서울' } } },
    { clarificationQuestion: '질문과 READY를 함께 보낼 수 없습니다.' },
    { status: 'CLARIFICATION_REQUIRED', clarificationQuestion: null },
    { status: 'CLARIFICATION_REQUIRED', clarificationQuestion: ' ' },
    { status: 'CLARIFICATION_REQUIRED', clarificationQuestion: '질문\n' },
    { changedFields: ['REGION', 'REGION'] },
    { changedFields: ['REGION', 'QUERY'] },
    { changedFields: ['UNSUPPORTED'] },
  ])('필드 누락·상태 모순·잘못된 변경 필드를 거부한다 (%#)', (overrides) => {
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...ready, ...overrides }).success).toBe(false)
  })

  it('새 계약은 코드 포인트가 아닌 UTF-16 길이로 검증한다', () => {
    const parseQuery = (query: string) => supportProgramInterpretationDtoSchema.safeParse({ ...ready,
      proposedContext: { ...seoulConversationContext, query } }).success
    expect(parseQuery('😀'.repeat(250))).toBe(true)
    expect(parseQuery('😀'.repeat(251))).toBe(false)
    expect(parseQuery('사업화\n지원\t')).toBe(true)
    expect(parseQuery('사업화\u200b')).toBe(false)
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...ready, proposedContext: {
      ...seoulConversationContext, companyConditions: { ...seoulConversationContext.companyConditions, region: '😀'.repeat(26) },
    } }).success).toBe(false)
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...ready, status: 'CLARIFICATION_REQUIRED',
      clarificationQuestion: '😀'.repeat(81) }).success).toBe(false)
  })

  it.each(['2024-02-30', '1899-12-31', '9999-01-01', '2024-1-1', ' 2024-01-01', '2024-01-01 '])('실제 서울 날짜 계약을 어긴 설립일을 거부한다: %s', (establishedOn) => {
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...ready, proposedContext: {
      ...seoulConversationContext, companyConditions: { ...seoulConversationContext.companyConditions, establishedOn },
    } }).success).toBe(false)
  })

  it('UTC 날짜와 다른 서울 오늘을 허용하며 조건의 제어문자는 거부한다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T16:00:00Z'))
    const companyConditions = { ...seoulConversationContext.companyConditions, establishedOn: '2026-09-07' }
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...ready, proposedContext: { ...seoulConversationContext, companyConditions } }).success).toBe(true)
    expect(supportProgramInterpretationDtoSchema.safeParse({ ...ready, proposedContext: {
      ...seoulConversationContext, companyConditions: { ...companyConditions, region: '\t서울' },
    } }).success).toBe(false)
  })
})
