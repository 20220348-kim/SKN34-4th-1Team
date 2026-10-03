import { describe, expect, it } from 'vitest'

import { isReviewStepScreen } from './assistantConversation'

describe('assistant launcher placement', () => {
  it('lifts the launcher only on combination review input screens with the step bar', () => {
    expect(isReviewStepScreen('/app/combination-reviews/new')).toBe(true)
    expect(isReviewStepScreen('/app/combination-reviews/12')).toBe(true)
    expect(isReviewStepScreen('/app/combination-reviews/12/')).toBe(true)
    expect(isReviewStepScreen('/app/combination-reviews')).toBe(false)
    expect(isReviewStepScreen('/app/combination-reviews/12/runs/30')).toBe(false)
  })
})
