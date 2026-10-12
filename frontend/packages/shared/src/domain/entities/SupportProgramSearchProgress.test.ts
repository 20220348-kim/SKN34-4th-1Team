import { describe, expect, it } from 'vitest'

import {
  formatSupportProgramSearchElapsed, supportProgramSearchElapsedSeconds, supportProgramSearchSteps, supportProgramSearchWaitNote,
} from './SupportProgramSearchProgress'

describe('AI 검색 대기 단계', () => {
  it('조건 정리만 끝난 단계로 두고 서버가 하는 공고 찾기·자격 확인은 보통 걸리는 시간과 함께 진행 중으로 둔다', () => {
    expect(supportProgramSearchSteps.map(({ label, state }) => [label, state])).toEqual([
      ['조건 정리', 'done'], ['공고 찾기', 'running'], ['자격 확인', 'running'],
    ])
    expect(supportProgramSearchSteps.filter((step) => step.state === 'running').every((step) => step.note.startsWith('보통 '))).toBe(true)
  })

  it('지난 시간을 초 단위로 버리고 시계가 거꾸로 가면 0초로 둔다', () => {
    expect(supportProgramSearchElapsedSeconds(1_000, 13_999)).toBe(12)
    expect(supportProgramSearchElapsedSeconds(5_000, 4_000)).toBe(0)
    expect([0, 12, 60, 65].map(formatSupportProgramSearchElapsed)).toEqual(['0초', '12초', '1분', '1분 5초'])
  })

  it('10초 전에는 안내가 없고, 그 뒤 보통 걸리는 시간을, 45초부터는 늦어지고 있음을 알린다', () => {
    expect(supportProgramSearchWaitNote(9)).toBeNull()
    expect(supportProgramSearchWaitNote(10)).toContain('보통 30초 안팎 걸려요')
    expect(supportProgramSearchWaitNote(44)).toContain('보통 30초 안팎 걸려요')
    expect(supportProgramSearchWaitNote(45)).toBe('평소보다 오래 걸리고 있어요. 조금만 더 기다려 주세요.')
  })
})
