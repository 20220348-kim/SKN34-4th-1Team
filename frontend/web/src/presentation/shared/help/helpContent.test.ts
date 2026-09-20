import { describe, expect, it } from 'vitest'

import { appPaths, publicPaths } from '../routes/appPaths'
import { findHelpEntry, helpActionHref, helpEntries, helpEntriesForRoute, helpEntriesForSurface } from './helpContent'

const knownPaths = new Set<string>(Object.values(appPaths).filter((path) => !path.includes(':')))
const pathOf = (to: string) => to.split('?')[0] ?? ''

describe('도움말 항목', () => {
  it('id가 겹치지 않고 related는 실제 있는 항목만 가리킨다', () => {
    const ids = helpEntries.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of helpEntries) {
      for (const related of entry.related) {
        expect(findHelpEntry(related), `${entry.id}의 related ${related}`).toBeDefined()
        expect(related).not.toBe(entry.id)
      }
    }
  })

  it('표시에 쓰는 문구를 비워 두지 않는다', () => {
    for (const entry of helpEntries) {
      expect(entry.title.trim(), entry.id).not.toBe('')
      expect(entry.question.trim(), entry.id).not.toBe('')
      expect(entry.summary.trim(), entry.id).not.toBe('')
      expect(entry.body.length, entry.id).toBeGreaterThan(0)
      expect(entry.body.every((paragraph) => paragraph.trim() !== ''), entry.id).toBe(true)
      expect(entry.surfaces.length, entry.id).toBeGreaterThan(0)
      expect(entry.updatedOn, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('막히는 지점은 다음에 갈 곳을 반드시 준다', () => {
    for (const entry of helpEntries.filter((candidate) => candidate.category === 'blocker')) {
      expect(entry.action, entry.id).not.toBeNull()
      expect(entry.action?.label.trim(), entry.id).not.toBe('')
    }
  })

  it('routes와 action은 실제 화면 경로만 쓴다', () => {
    for (const entry of helpEntries) {
      for (const route of entry.routes) expect(knownPaths.has(route), `${entry.id}의 route ${route}`).toBe(true)
      if (entry.action !== null) expect(knownPaths.has(pathOf(entry.action.to)), `${entry.id}의 action ${entry.action.to}`).toBe(true)
    }
  })

  it('준비 중 기능을 다루는 항목은 무엇이 안 되는지 함께 적는다', () => {
    const preparing = findHelpEntry('feature-status-preparing')
    expect(preparing?.limitation).not.toBeNull()
    expect(preparing?.body.some((paragraph) => paragraph.includes('저장되지 않습니다'))).toBe(true)
    // 관심 공고함은 정식 기능이므로 준비 중이라고 안내하지 않는다.
    expect(preparing?.body.some((paragraph) => paragraph.includes('관심 공고함은 아직'))).toBe(false)
  })
})

describe('화면별 추천 질문', () => {
  it('공개 랜딩과 작업 채팅이 같은 질문을 낸다', () => {
    const fromLanding = helpEntriesForRoute(publicPaths.landing).map((entry) => entry.id)
    expect(helpEntriesForRoute(appPaths.chat).map((entry) => entry.id)).toEqual(fromLanding)
    expect(fromLanding).toContain('search-score-meaning')
  })

  it('하위 경로에서도 해당 화면의 질문을 낸다', () => {
    const ids = helpEntriesForRoute(`${appPaths.combinationReviews}/new`, 5).map((entry) => entry.id)
    expect(ids).toContain('review-save-vs-run')
    expect(ids).toContain('review-input-revision')
    expect(ids).not.toContain('search-score-meaning')
  })

  it('화면을 지정한 항목이 먼저, 화면과 무관한 항목이 나중에 온다', () => {
    const ids = helpEntriesForRoute(appPaths.profile, 5).map((entry) => entry.id)
    expect(ids[0]).toBe('partner-write-requires-company')
    expect(ids).toContain('feature-status-preparing')
    expect(ids.indexOf('feature-status-preparing')).toBeGreaterThan(0)
  })

  it('아는 화면이 없어도 화면과 무관한 항목은 남고 개수 제한을 지킨다', () => {
    expect(helpEntriesForRoute(appPaths.adminAccounts).map((entry) => entry.id)).toEqual(['feature-status-preparing'])
    expect(helpEntriesForRoute(appPaths.proposals).map((entry) => entry.id)).toEqual(['proposal-box', 'feature-status-preparing'])
    expect(helpEntriesForRoute(appPaths.chat, 2)).toHaveLength(2)
  })

  it('챗봇 표면에 없는 항목은 추천하지 않는다', () => {
    const chatbotIds = new Set(helpEntriesForSurface('chatbot').map((entry) => entry.id))
    for (const entry of helpEntriesForRoute(appPaths.chat, 99)) expect(chatbotIds.has(entry.id)).toBe(true)
  })
})

describe('도움말이 안내하는 경로', () => {
  it('작업 화면에서는 내부 경로를 그대로 쓴다', () => {
    expect(helpActionHref(appPaths.profile, true)).toBe(appPaths.profile)
    expect(helpActionHref(`${appPaths.chat}?mode=filter`, true)).toBe(`${appPaths.chat}?mode=filter`)
  })

  it('공개 화면에서는 대응하는 공개 경로로 바꾸고 질의 문자열을 유지한다', () => {
    expect(helpActionHref(appPaths.chat, false)).toBe(publicPaths.landing)
    expect(helpActionHref(`${appPaths.chat}?mode=filter`, false)).toBe(`${publicPaths.landing}?mode=filter`)
    expect(helpActionHref(appPaths.pricing, false)).toBe(publicPaths.pricing)
    expect(helpActionHref(appPaths.partners, false)).toBe(publicPaths.partners)
  })

  it('공개 대응이 없는 화면은 그대로 두어 기존 경로 보호가 로그인으로 안내하게 한다', () => {
    expect(helpActionHref(appPaths.profile, false)).toBe(appPaths.profile)
    expect(helpActionHref(appPaths.combinationReviews, false)).toBe(appPaths.combinationReviews)
  })
})
