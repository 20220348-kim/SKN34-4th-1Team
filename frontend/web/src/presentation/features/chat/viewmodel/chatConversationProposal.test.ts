import { describe, expect, it } from 'vitest'

import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../../../data/fixtures/supportProgramConversation'
import { createChatConversationProposal } from './chatConversationProposal'

type ProposalSource = Parameters<typeof createChatConversationProposal>[0]

describe('createChatConversationProposal', () => {
  it('보내지 않은 메시지가 있어도 조건은 표시하되 이전 제안의 확인 검색은 막는다', () => {
    expect(createChatConversationProposal(createSource({
      hasUnsentMessage: true,
      interpretation: { result: readyConversationProposal(seoulConversationContext) },
    }))).toMatchObject({ kind: 'ready', query: '사업화 지원', canConfirm: false, hasUnsentMessage: true,
      appliedConditions: expect.arrayContaining([{ label: '현재 소재지', value: '서울' }]) })
  })

  it('표시할 해석 결과와 미확정 질문이 없으면 제안을 만들지 않는다', () => {
    expect(createChatConversationProposal(createSource())).toBeNull()
  })

  it('처리 중에는 해석 결과와 미확정 질문이 있어도 숨긴다', () => {
    expect(createChatConversationProposal(createSource({
      isBusy: true,
      interpretation: { result: readyConversationProposal(seoulConversationContext) },
      pendingClarification: { question: '어느 지역인가요?', draftContext: emptyConversationContext },
    }))).toBeNull()
  })

  it('해석 결과를 미확정 질문보다 우선한다', () => {
    expect(createChatConversationProposal(createSource({
      interpretation: { result: readyConversationProposal(seoulConversationContext) },
      pendingClarification: { question: '이전 질문', draftContext: emptyConversationContext },
    }))).toMatchObject({ kind: 'ready', query: '사업화 지원' })
  })

  it('새 추가 확인 결과가 있으면 이전 미확정 질문 대신 새 질문만 표시한다', () => {
    expect(createChatConversationProposal(createSource({
      interpretation: { result: { status: 'CLARIFICATION_REQUIRED',
        clarificationQuestion: '어떤 지원이 필요한가요?', proposedContext: seoulConversationContext, changedFields: [] } },
      pendingClarification: { question: '이전 질문', draftContext: emptyConversationContext },
    }))).toEqual({ kind: 'clarification', question: '어떤 지원이 필요한가요?' })
  })

  it('미확정 질문만 있으면 원본을 바꾸거나 도메인 제안을 만들지 않고 질문만 제공한다', () => {
    const source = createSource({
      pendingClarification: { question: '어느 지역인가요?', draftContext: seoulConversationContext },
    })
    const before = structuredClone(source)

    expect(createChatConversationProposal(source)).toEqual({ kind: 'clarification', question: '어느 지역인가요?' })
    expect(source).toEqual(before)
    expect(source.interpretation.result).toBeUndefined()
  })

  it('현재 확정 조건보다 요청 당시 조건을 비교 기준으로 사용한다', () => {
    const display = createChatConversationProposal(createSource({
      confirmedContext: emptyConversationContext,
      interpretation: { request: { context: seoulConversationContext }, result: readyConversationProposal(seoulConversationContext) },
    }))

    expect(display).toMatchObject({ kind: 'ready', changes: [], hasRetainedConditions: true })
  })

  it('요청 당시 조건이 없으면 확정 조건을 기준으로 변경·해제·유지 및 적용 조건을 계산한다', () => {
    const proposed = { ...seoulConversationContext, query: '부산 지원사업', acceptingOnly: false,
      companyConditions: { ...seoulConversationContext.companyConditions, region: '부산', industry: null } }
    const display = createChatConversationProposal(createSource({
      confirmedContext: seoulConversationContext,
      interpretation: { result: readyConversationProposal(proposed) },
    }))

    expect(display).toEqual({
      kind: 'ready', query: '부산 지원사업', acceptingOnly: false, canConfirm: true, hasUnsentMessage: false,
      changes: [{ label: '현재 소재지', after: '부산' }, { label: '업종', after: null }, { label: '접수 상태', after: '전체' }],
      hasRetainedConditions: true,
      appliedConditions: [{ label: '현재 소재지', value: '부산' }, { label: '설립일', value: '2024-01-01' },
        { label: '지원 목적', value: '사업화' }],
    })
  })

  it.each([true, false])('기업 조건 없이 접수 중만 %s가 유지되면 기존 유지 안내 기준을 보존한다', (acceptingOnly) => {
    const context = { ...emptyConversationContext, query: '지원사업', acceptingOnly }

    expect(createChatConversationProposal(createSource({
      confirmedContext: context,
      interpretation: { result: readyConversationProposal(context) },
    }))).toMatchObject({ kind: 'ready', changes: [], appliedConditions: [], hasRetainedConditions: !acceptingOnly })
  })

  it.each([true, false])('검색 가능 여부 %s를 확인 버튼 상태에 반영한다', (canSearch) => {
    expect(createChatConversationProposal(createSource({
      canSearch, interpretation: { result: readyConversationProposal(seoulConversationContext) },
    }))).toMatchObject({ kind: 'ready', canConfirm: canSearch })
  })

  it('조건 차이를 계산해도 입력 객체와 변경 필드를 수정하지 않는다', () => {
    const source = structuredClone(createSource({
      interpretation: { request: { context: emptyConversationContext }, result: readyConversationProposal(seoulConversationContext) },
    }))
    const before = structuredClone(source)
    Object.freeze(source.confirmedContext.companyConditions)
    Object.freeze(source.interpretation.request!.context.companyConditions)
    Object.freeze(source.interpretation.result!.proposedContext.companyConditions)
    Object.freeze(source.interpretation.result!.changedFields)

    expect(createChatConversationProposal(source)).toMatchObject({ kind: 'ready', hasRetainedConditions: false })
    expect(source).toEqual(before)
  })
})

function createSource(overrides: Partial<ProposalSource> = {}): ProposalSource {
  return { isBusy: false, confirmedContext: emptyConversationContext, interpretation: {},
    pendingClarification: null, canSearch: true, hasUnsentMessage: false, ...overrides }
}
