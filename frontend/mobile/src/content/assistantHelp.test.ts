import { assistantHelpEntries, assistantHelpInput, assistantPageHelp } from './assistantHelp'

test.each([
  ['/', '지원사업 검색', 'mobile-search-confirm'], ['/saved', '관심 공고함', 'mobile-saved-programs'],
  ['/report', '기업 맞춤 리포트', 'mobile-reports'], ['/program', '공고 상세', 'mobile-program-question'],
  ['/all/preparation/new', '새 문서', 'mobile-application-documents'],
  ['/all/preparation/12', '답변 입력', 'mobile-document-answers'], ['/all/preparation/12/review', '답변 검토', 'mobile-document-answers'],
  ['/all/preparation/12/documents', '신청 문서 초안', 'mobile-document-job'], ['/all/preparation/12/online', '구글폼 입력 도우미', 'mobile-online-form'],
  ['/all/reviews/new', '새 검토', 'mobile-combination-review'], ['/all/settings', '알림 설정', 'mobile-report-settings'],
  ['/all/company', '기업 프로필', 'mobile-company-registration'], ['/all/account', '내 프로필', 'mobile-account'],
  ['/all/collab', '파트너 모집', 'mobile-partners'], ['/all/pricing', '요금제', 'mobile-pricing'],
] as const)('questions for %s belong to that page and reference existing help entries', (path, label, firstId) => {
  const result = assistantPageHelp(path, true)
  expect(result.label).toBe(label)
  expect(result.questions[0].id).toBe(firstId)
  expect(result.questions.length).toBeLessThanOrEqual(3)
  expect(new Set(result.questions.map(entry => entry.id)).size).toBe(result.questions.length)
})
test('a missing or invalid program selection never offers a selected-program action', () => {
  expect(assistantPageHelp('/program', false).questions.some(entry => entry.contextual)).toBe(false)
})
test('all topics remain in the HTTP help catalog while UI-only metadata stays local', () => {
  const input = assistantHelpInput()
  expect(input).toHaveLength(assistantHelpEntries.length)
  expect(input.length).toBeLessThanOrEqual(40)
  expect(new Set(input.map(entry => entry.id)).size).toBe(input.length)
  for (const entry of input) {
    expect(entry).not.toHaveProperty('topic'); expect(entry).not.toHaveProperty('contextual'); expect(entry).not.toHaveProperty('companyAction')
    expect(entry.body.join('').length).toBeLessThanOrEqual(600)
  }
})
