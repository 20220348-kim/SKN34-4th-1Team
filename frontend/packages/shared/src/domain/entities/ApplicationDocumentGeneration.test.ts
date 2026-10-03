import { describe, expect, it } from 'vitest'
import { isWritableApplicationAnswer } from './ApplicationDocumentGeneration'

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
