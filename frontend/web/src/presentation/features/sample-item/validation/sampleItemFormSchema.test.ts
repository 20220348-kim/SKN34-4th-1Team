import { describe, expect, it } from 'vitest'

import { sampleItemFormSchema, toSampleItem } from './sampleItemFormSchema'

describe('SampleItem form contract shared by Hook and Redux examples', () => {
  it('normalizes the same form values into one Domain item', () => {
    const values = sampleItemFormSchema.parse({
      category: 'BASIC',
      name: '  공통 예제  ',
      note: '  같은 payload  ',
    })

    expect(toSampleItem(values)).toEqual({
      category: 'BASIC',
      name: '공통 예제',
      note: '같은 payload',
    })
  })

  it('converts empty optional text to null', () => {
    const values = sampleItemFormSchema.parse({
      category: '',
      name: '예제',
      note: '   ',
    })

    expect(toSampleItem(values)).toEqual({
      category: null,
      name: '예제',
      note: null,
    })
  })
})
