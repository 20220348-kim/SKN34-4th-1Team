import { describe, expect, it } from 'vitest'

import { applicationProgressStages } from './entities/ApplicationPreparation'
import { applicationProgressStageLabels, daysUntil, ddayTone, formatDate, formatDday, programStatusLabels } from './labels'

// 2026-10-04 08:30 서울(전날 23:30 UTC)
const seoulMorning = new Date('2026-10-03T23:30:00Z')

describe('표시 문구', () => {
  it('공고 상태와 진행 단계를 기준 문서의 이름으로 쓴다', () => {
    expect(programStatusLabels).toEqual({ OPEN: '접수 중', UPCOMING: '접수 예정', CLOSED: '접수 마감', UNKNOWN: '상태 확인 필요' })
    expect(applicationProgressStages.map((stage) => applicationProgressStageLabels[stage]))
      .toEqual(['준비 중', '제출 완료', '서류 심사', '발표 심사', '선정', '미선정'])
  })

  it('D-day는 남은 날·당일·지난 날을 나눠 쓴다', () => {
    expect(formatDday(3)).toBe('D-3')
    expect(formatDday(0)).toBe('오늘 마감')
    expect(formatDday(-1)).toBe('마감')
  })

  it('남은 날은 서울 달력 기준으로 세고 읽을 수 없는 날짜는 null이다', () => {
    expect(daysUntil('2026-10-04', seoulMorning)).toBe(0)
    expect(daysUntil('2026-10-07', seoulMorning)).toBe(3)
    expect(daysUntil('2026-10-03', seoulMorning)).toBe(-1)
    expect(daysUntil('2027-01-01', seoulMorning)).toBe(89)
    for (const value of [null, undefined, '', '2026-02-30', '2026-10-04T00:00:00Z', '2026.10.04']) {
      expect(daysUntil(value, seoulMorning)).toBeNull()
    }
  })

  it('날짜는 2026.10.02로 쓰고 올해 생략은 요청할 때만 한다', () => {
    expect(formatDate('2026-10-02')).toBe('2026.10.02')
    // 시각은 서울 날짜로 바꿉니다(UTC 15:30 = 서울 다음 날 00:30).
    expect(formatDate('2026-10-01T15:30:00Z')).toBe('2026.10.02')
    expect(formatDate(new Date('2026-10-01T15:30:00Z'))).toBe('2026.10.02')
    expect(formatDate('2026-10-02', { omitCurrentYear: true, now: seoulMorning })).toBe('10.02')
    expect(formatDate('2025-12-31', { omitCurrentYear: true, now: seoulMorning })).toBe('2025.12.31')
    expect(formatDate('공고문 참조')).toBe('공고문 참조')
    expect(formatDate('2026-02-30')).toBe('2026-02-30')
    expect(formatDate(new Date(Number.NaN))).toBe('')
  })
})

describe('ddayTone', () => {
  it('colors 7 days or less red, up to 30 days yellow, later green and past deadlines gray', () => {
    expect([0, 7].map(ddayTone)).toEqual(['urgent', 'urgent'])
    expect([8, 30].map(ddayTone)).toEqual(['soon', 'soon'])
    expect([31, 120].map(ddayTone)).toEqual(['later', 'later'])
    expect(ddayTone(-1)).toBe('closed')
  })
})
