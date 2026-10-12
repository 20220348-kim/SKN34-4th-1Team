import { describe, expect, it } from 'vitest'

import { supportProgramExclusionCountsDtoSchema, supportProgramSearchResponseDtoSchema } from '../../data/models/SupportProgramDto'
import { chatConversationSnapshotSchema } from '../../data/models/ChatConversationDto'
import type { SupportProgramConversationContext } from './SupportProgramConversation'
import {
  relaxSupportProgramSearch, supportProgramSearchRelaxations, supportProgramZeroResultExplanation,
} from './SupportProgramSearchRelaxation'

const context: SupportProgramConversationContext = {
  query: 'AI 창업 자금', acceptingOnly: true,
  companyConditions: { region: '서울특별시', industry: '정보통신업', establishedOn: null, foundedYear: 2021, supportPurpose: '사업화' },
}

describe('결과가 없을 때의 조건 빼기', () => {
  it('뺀 후보가 있는 조건만 많은 순서로 보여 주고 마감·예정 포함은 수 없이 마지막에 둔다', () => {
    const relaxations = supportProgramSearchRelaxations(context, { candidateCount: 20, lowRelevance: 14, target: 2, region: 4 })
    expect(relaxations).toEqual([
      { kind: 'REGION', label: '지역 조건 빼고 찾기', excludedCount: 4 },
      { kind: 'COMPANY_PROFILE', label: '업종·설립 조건 빼고 찾기', excludedCount: 2 },
      { kind: 'ACCEPTING_ONLY', label: '마감·예정 공고도 찾기', excludedCount: null },
    ])
  })

  it('그 사유로 뺀 후보가 0건이면 도움이 되지 않으므로 그 조건 빼기는 보이지 않는다', () => {
    expect(supportProgramSearchRelaxations(context, { candidateCount: 20, lowRelevance: 20, target: 0, region: 0 }).map((item) => item.kind))
      .toEqual(['ACCEPTING_ONLY'])
    expect(supportProgramSearchRelaxations({ ...context, acceptingOnly: false }, { candidateCount: 0, lowRelevance: 0, target: 0, region: 0 }))
      .toEqual([])
  })

  it('수를 모르면 조건이 있는 빼기를 모두 수 없이 보이고, 회사 조건이 없으면 지역·업종 빼기도 없다', () => {
    expect(supportProgramSearchRelaxations(context, null).map(({ kind, excludedCount }) => [kind, excludedCount])).toEqual([
      ['REGION', null], ['COMPANY_PROFILE', null], ['ACCEPTING_ONLY', null],
    ])
    const onlyFounding = { ...context, companyConditions: { region: null, industry: null, establishedOn: '2021-03-15', supportPurpose: null } }
    expect(supportProgramSearchRelaxations(onlyFounding, undefined).map((item) => item.label)).toEqual(['설립 조건 빼고 찾기', '마감·예정 공고도 찾기'])
  })

  it('고른 조건만 지우고 검색어·나머지 조건은 그대로 둔 새 조건과 바뀐 항목을 만든다', () => {
    expect(relaxSupportProgramSearch(context, 'REGION')).toEqual({
      context: { ...context, companyConditions: { ...context.companyConditions, region: null } }, changedFields: ['REGION'],
    })
    expect(relaxSupportProgramSearch(context, 'COMPANY_PROFILE')).toEqual({
      context: { ...context, companyConditions: { ...context.companyConditions, industry: null, establishedOn: null, foundedYear: null } },
      changedFields: ['INDUSTRY', 'FOUNDED_YEAR'],
    })
    const { context: relaxed, changedFields } = relaxSupportProgramSearch(context, 'ACCEPTING_ONLY')
    expect(relaxed).toEqual({ ...context, acceptingOnly: false })
    expect(relaxed.companyConditions).not.toBe(context.companyConditions)
    expect(changedFields).toEqual(['ACCEPTING_ONLY'])
  })
})

describe('결과가 없을 때의 사유 안내', () => {
  it('센 사유를 그대로 적고 원인을 하나로 단정하지 않는다', () => {
    expect(supportProgramZeroResultExplanation({ candidateCount: 20, lowRelevance: 14, target: 2, region: 4 }))
      .toBe('관련 후보 20건을 살펴봤지만 요청과 관련이 낮은 공고 14건, 지원 대상이 회사 조건과 맞지 않는 공고 2건, 회사 지역과 맞지 않는 공고 4건이라 추천하지 않았어요.')
    expect(supportProgramZeroResultExplanation({ candidateCount: 3, lowRelevance: 0, target: 0, region: 3 }))
      .toBe('관련 후보 3건을 살펴봤지만 회사 지역과 맞지 않는 공고 3건이라 추천하지 않았어요.')
  })

  it('후보가 없으면 그렇게 알리고, 수를 모르면 안내하지 않는다', () => {
    expect(supportProgramZeroResultExplanation({ candidateCount: 0, lowRelevance: 0, target: 0, region: 0 })).toBe('검색어와 관련된 공고 후보를 찾지 못했어요.')
    expect(supportProgramZeroResultExplanation(null)).toBeNull()
    expect(supportProgramZeroResultExplanation(undefined)).toBeNull()
  })
})

describe('검색 응답과 대화 기록의 제외 후보 수', () => {
  const response = { query: 'AI', programs: [], totalCount: 0, resultToken: null, expiresAt: null }

  it('제외 수가 없던 응답도 받고, 뺀 후보가 살펴본 후보보다 많으면 거부한다', () => {
    expect(supportProgramSearchResponseDtoSchema.parse(response).exclusionCounts).toBeUndefined()
    expect(supportProgramSearchResponseDtoSchema.parse({ ...response, exclusionCounts: null }).exclusionCounts).toBeNull()
    const counts = { candidateCount: 5, lowRelevance: 3, target: 1, region: 1 }
    expect(supportProgramSearchResponseDtoSchema.parse({ ...response, exclusionCounts: counts }).exclusionCounts).toEqual(counts)
    expect(supportProgramExclusionCountsDtoSchema.safeParse({ ...counts, region: 2 }).success).toBe(false)
    expect(supportProgramExclusionCountsDtoSchema.safeParse({ ...counts, target: -1 }).success).toBe(false)
  })

  it('대화 기록에 저장한 결과 메시지의 제외 수를 다시 열 때도 버리지 않고 읽는다', () => {
    const snapshot = {
      schemaVersion: 1, messages: [
        { id: 'question', role: 'user', text: 'AI 창업 자금' },
        { id: 'answer', role: 'assistant', text: '없음', programs: [], totalCount: 0,
          exclusionCounts: { candidateCount: 20, lowRelevance: 20, target: 0, region: 0 } },
      ],
      searchOptions: { acceptingOnly: true }, conversationQuery: 'AI 창업 자금', confirmedSearch: null, lastSearch: null,
      pendingProposal: null, pendingClarification: null, searchStatus: 'idle', searchError: null, interpretation: { status: 'idle' },
    }
    expect(chatConversationSnapshotSchema.parse(snapshot).messages[1]!.exclusionCounts)
      .toEqual({ candidateCount: 20, lowRelevance: 20, target: 0, region: 0 })
  })
})
