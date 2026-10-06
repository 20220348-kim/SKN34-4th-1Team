import { describe, expect, it } from 'vitest'
import { applicationDraftMode, isWritableApplicationAnswer } from './ApplicationDocumentGeneration'

describe('answers eligible for document writing in web and mobile', () => {
  it.each([undefined, null, '', '  ', '미정', ' 미정 '])('excludes an undecided or empty answer %s', value => {
    expect(isWritableApplicationAnswer({}, value)).toBe(false)
  })

  it('includes an actual answer only when the field permits automatic writing', () => {
    expect(isWritableApplicationAnswer({}, '테스트 기업')).toBe(true)
    expect(isWritableApplicationAnswer({ documentWritable: true }, '  계획 수립  ')).toBe(true)
    expect(isWritableApplicationAnswer({ documentWritable: false }, '계획 수립')).toBe(false)
  })
})

describe('the same draft policy in web and mobile', () => {
  it('keeps an empty form as the original without requiring an answer', () => {
    expect(applicationDraftMode([])).toBe('original')
  })

  it.each([undefined, null, '', '  ', '미정', ' 미정 '])('uses the original for empty or undecided answers %s', value => {
    expect(applicationDraftMode([{ field: {}, value }, { field: { documentWritable: false }, value }])).toBe('original')
  })

  it('allows writing the provided answer while other questions remain empty', () => {
    expect(applicationDraftMode([{ field: {}, value: '계획 수립' }, { field: {}, value: '' }, { field: {}, value: '미정' }])).toBe('writing')
  })

  it('does not classify manual-only provided answers as an empty original', () => {
    expect(applicationDraftMode([{ field: { documentWritable: false }, value: '직접 작성할 답변' }, { field: {}, value: '' }])).toBe('manualOnly')
  })

  it.each([false, true])('uses writing when a writable answer accompanies manual answers, reversed=%s', reversed => {
    const answers = [{ field: { documentWritable: false }, value: '수동 답변' }, { field: { documentWritable: true }, value: '  기업명  ' }]
    expect(applicationDraftMode(reversed ? answers.reverse() : answers)).toBe('writing')
  })
})
