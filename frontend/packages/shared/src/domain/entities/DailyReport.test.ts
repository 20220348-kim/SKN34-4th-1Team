import { describe, expect, it } from 'vitest'

import { sendHourLabel } from './DailyReport'

describe('sendHourLabel', () => {
  it.each([
    [0, '오전 0시'],
    [8, '오전 8시'],
    [11, '오전 11시'],
    [12, '오후 12시'],
    [13, '오후 1시'],
    [23, '오후 11시'],
  ])('%i시는 %s로 적는다', (hour, label) => {
    expect(sendHourLabel(hour)).toBe(label)
  })
})
