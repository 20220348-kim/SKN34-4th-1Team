import { describe, expect, it } from 'vitest'

import { getSupportProgramSearchReturnTo, isApplicationPreparationsReturnTo, isReportsReturnTo, isWorkspaceListReturnTo, supportProgramBackLabel } from './supportProgramNavigation'

describe('supportProgramNavigation', () => {
  it('returns to the application document list with only a known status filter', () => {
    expect(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/application-preparations' })).toBe('/app/application-preparations')
    expect(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/application-preparations?status=done' })).toBe('/app/application-preparations?status=done')
    expect(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/application-preparations?status=in_progress' })).toBe('/app/application-preparations?status=in_progress')
    expect(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/application-preparations?status=<script>' })).toBe('/app/application-preparations')
    expect(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/application-preparations/12' })).toBe('/')
  })

  it('treats the document list like the saved-programs list for the back row and label', () => {
    const returnTo = getSupportProgramSearchReturnTo({ searchReturnTo: '/app/application-preparations?status=done' })
    expect(isApplicationPreparationsReturnTo(returnTo)).toBe(true)
    expect(isWorkspaceListReturnTo(returnTo)).toBe(true)
    expect(supportProgramBackLabel(returnTo)).toBe('신청 문서 작성으로 돌아가기')
    expect(isWorkspaceListReturnTo(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/chat' }))).toBe(false)
    expect(supportProgramBackLabel(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/saved-programs' }))).toBe('관심 공고함으로 돌아가기')
  })

  it('returns to the company report and drops any query', () => {
    const returnTo = getSupportProgramSearchReturnTo({ searchReturnTo: '/app/reports' })
    expect(returnTo).toBe('/app/reports')
    expect(isReportsReturnTo(returnTo)).toBe(true)
    expect(isWorkspaceListReturnTo(returnTo)).toBe(true)
    expect(supportProgramBackLabel(returnTo)).toBe('기업 맞춤 리포트로 돌아가기')
    expect(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/reports?settings=open' })).toBe('/app/reports')
    expect(getSupportProgramSearchReturnTo({ searchReturnTo: '/app/reports/1' })).toBe('/')
  })
})
