import { describe, expect, it } from 'vitest'

import { companyRegions } from './Company'
import { nationwideRegion, regionNames, toRegionName } from './Region'

describe('Region', () => {
  it('공고 분류는 광역 시·도 16개와 전국이며 가나다순이다', () => {
    expect(regionNames).toHaveLength(18)
    expect(regionNames).toContain(nationwideRegion)
    expect([...regionNames]).toEqual([...regionNames].sort((left, right) => left.localeCompare(right, 'ko')))
  })

  it('프로필 소재지 정식 명칭은 모두 공고 분류 이름으로 바뀐다', () => {
    for (const fullName of companyRegions) {
      const region = toRegionName(fullName)
      expect(region).not.toBe(fullName)
      expect(regionNames).toContain(region)
    }
    expect(toRegionName('전라남도')).toBe('전남')
    expect(toRegionName('광주광역시')).toBe('광주')
  })

  it('모르는 값은 그대로 돌려준다', () => {
    expect(toRegionName('전국')).toBe('전국')
    expect(toRegionName('해외')).toBe('해외')
  })
})
