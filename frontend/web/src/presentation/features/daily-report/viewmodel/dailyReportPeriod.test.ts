import { describe, expect, it } from 'vitest'
import { readReportPeriod, reportToday } from './dailyReportPeriod'

describe('리포트 접수 기간', () => {
  it('서울 날짜로 오늘을 정한다', () => {
    expect(reportToday(new Date('2026-09-09T15:30:00Z'))).toBe('2026-09-10')
    expect(reportToday(new Date('2026-09-09T14:59:59Z'))).toBe('2026-09-09')
  })

  it('기간 안이면 접수 중과 남은 날을, 마감일이면 0을 돌려준다', () => {
    expect(readReportPeriod('2026-09-01 ~ 2026-09-30', '2026-09-27')).toEqual({ status: 'OPEN', daysLeft: 3 })
    expect(readReportPeriod('2026.09.01~2026.09.30', '2026-09-30')).toEqual({ status: 'OPEN', daysLeft: 0 })
  })

  it('시작 전은 접수 예정, 지난 기간은 접수 마감이다', () => {
    expect(readReportPeriod('2026-09-10 ~ 2026-09-30', '2026-09-09')).toEqual({ status: 'UPCOMING', daysLeft: null })
    expect(readReportPeriod('2026-09-01 ~ 2026-09-30', '2026-10-01')).toEqual({ status: 'CLOSED', daysLeft: null })
  })

  it('상시·예산 소진 시까지는 마감 없는 접수 중으로 본다', () => {
    expect(readReportPeriod('예산 소진 시까지', '2026-09-09')).toEqual({ status: 'OPEN', daysLeft: null })
    expect(readReportPeriod('상시 접수', '2026-09-09')).toEqual({ status: 'OPEN', daysLeft: null })
    expect(readReportPeriod('상시 접수 (접수 종료)', '2026-09-09')).toBeNull()
  })

  it('띄어쓰기만 다른 수시 접수 표현은 접수 중으로 보되 다른 낱말을 상시·수시로 읽지 않는다', () => {
    for (const period of ['모집 완료 시까지', '모집완료시', '모집 마감 시까지', '예산소진시 까지', '선착순 마감', '연중 상시 모집']) {
      expect(readReportPeriod(period, '2026-09-09'), period).toEqual({ status: 'OPEN', daysLeft: null })
    }
    for (const period of ['참가 기업 100개사 이상 시 조기 마감', '70점 이상시 선정', '온라인 접수시 유의사항', '상시근로자 5인 이상',
      '접수 마감 시간 18:00', '선착순 접수 (조기 마감되었습니다)']) {
      expect(readReportPeriod(period, '2026-09-09'), period).toBeNull()
    }
  })

  it('읽을 수 없는 기간은 추측하지 않는다', () => {
    expect(readReportPeriod('', '2026-09-09')).toBeNull()
    expect(readReportPeriod('추후 공지', '2026-09-09')).toBeNull()
    expect(readReportPeriod('2026-02-30 ~ 2026-03-10', '2026-03-01')).toBeNull()
    expect(readReportPeriod('2026-09-30 ~ 2026-09-01', '2026-09-09')).toBeNull()
  })
})
