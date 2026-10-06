import { describe, expect, it } from 'vitest'

import { isAssistantHiddenOn } from './assistantConversation'

describe('assistant launcher placement', () => {
  it('hides the launcher on chat screens whose composer it would cover and on standalone auth screens', () => {
    for (const path of ['/', '/app/chat', '/app/chat/', '/login', '/signup', '/app/welcome', '/examples/sample-item/hook']) {
      expect(isAssistantHiddenOn(path)).toBe(true)
    }
  })

  it('keeps the launcher on other screens, including ones with bottom bars that lift it instead', () => {
    for (const path of ['/pricing', '/partners', '/app/saved-programs', '/app/combination-reviews/new', '/app/application-preparations/12', '/app/support-programs/detail']) {
      expect(isAssistantHiddenOn(path)).toBe(false)
    }
  })
})
