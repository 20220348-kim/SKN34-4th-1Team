import { describe, expect, it } from 'vitest'
import { applicationOnlineInputGuideSchema } from './ApplicationOnlineInputGuideDto'
import { formatSavedApplicationAnswers } from '../../domain/entities/ApplicationOnlineInputGuide'

const guide = { preparationId: 30, inputRevision: 1, totalCount: 3, readyCount: 1, needsReviewCount: 1, missingCount: 1, directInputCount: 0,
  externalMappingVerified: false, officialApplicationUrl: null, items: [
    { fieldId: 'company:name', label: '기업명', required: true, status: 'READY', answer: '합성테크', inputMode: 'UNKNOWN', options: [], copyable: true },
    { fieldId: 'company:missing', label: '계획', required: true, status: 'MISSING', answer: null, inputMode: 'UNKNOWN', options: [], copyable: false },
    { fieldId: 'company:choice', label: '업종', required: true, status: 'NEEDS_REVIEW', answer: '오류값', inputMode: 'UNKNOWN', options: ['AI', 'SaaS'], copyable: false },
  ], savedAnswers: [{ fieldId: 'company:name', label: '기업명', answer: '합성테크' }] }

describe('saved answer export contract', () => {
  it('fixes Q/A formatting and excludes missing and invalid choices', () => {
    expect(formatSavedApplicationAnswers(applicationOnlineInputGuideSchema.parse(guide))).toBe('Q. 기업명\nA. 합성테크')
  })
  it('requires savedAnswers to equal all READY fields and copyable to match status', () => {
    expect(applicationOnlineInputGuideSchema.safeParse({ ...guide, savedAnswers: [] }).success).toBe(false)
    expect(applicationOnlineInputGuideSchema.safeParse({ ...guide, items: guide.items.map((item) => ({ ...item, copyable: false })) }).success).toBe(false)
  })
  it('rejects wrong counts, duplicates and unconfirmed exports', () => {
    expect(applicationOnlineInputGuideSchema.safeParse({ ...guide, readyCount: 0 }).success).toBe(false)
    expect(applicationOnlineInputGuideSchema.safeParse({ ...guide, savedAnswers: [...guide.savedAnswers, guide.savedAnswers[0]] }).success).toBe(false)
    expect(applicationOnlineInputGuideSchema.safeParse({ ...guide, savedAnswers: [{ fieldId: 'company:choice', label: '업종', answer: '오류값' }] }).success).toBe(false)
  })
  it.each(['javascript:alert(1)', 'data:text/html,a', 'file:///tmp/file', 'https://name:secret@example.test'])('rejects unsafe external URL %s', (url) => {
    expect(applicationOnlineInputGuideSchema.safeParse({ ...guide, officialApplicationUrl: url }).success).toBe(false)
  })
  it.each(['https://example.test/apply', 'http://example.test/apply'])('allows HTTP(S) links %s', (url) => {
    expect(applicationOnlineInputGuideSchema.safeParse({ ...guide, officialApplicationUrl: url }).success).toBe(true)
  })
  it('accepts Google question identity and rejects a READY checkbox answer', () => {
    const items = [{ fieldId: 'company:name', sourceControlId: 'gpub-v1:1:id', label: '실제 질문', required: true,
      status: 'READY', answer: '합성테크', inputMode: 'SHORT_TEXT', options: [], copyable: true }]
    const google = { ...guide, totalCount: 1, readyCount: 1, needsReviewCount: 0, missingCount: 0,
      externalMappingVerified: true, officialApplicationUrl: 'https://docs.google.com/forms/d/e/id/viewform',
      items, savedAnswers: [{ fieldId: 'company:name', label: '실제 질문', answer: '합성테크' }] }
    expect(applicationOnlineInputGuideSchema.safeParse(google).success).toBe(true)
    expect(applicationOnlineInputGuideSchema.safeParse({ ...google, items: [{ ...items[0], inputMode: 'MULTI_CHOICE' }] }).success).toBe(false)
    expect(applicationOnlineInputGuideSchema.safeParse({ ...google, items: [{ ...items[0], fieldId: null }] }).success).toBe(false)
  })
})
