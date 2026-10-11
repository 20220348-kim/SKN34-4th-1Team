import { assistantCardDestination, assistantDestination, assistantOrigin, programIdentity, programQuestionDestination } from './assistantNavigation'

test('screen context uses canonical routes and selects only a validated detail identity', () => {
  expect(assistantOrigin('/', {})).toEqual({ path: '/', context: { route: '/app/chat', programSelected: false }, program: null })
  expect(assistantOrigin('/program', { sourceCode: 'BIZINFO', sourceProgramId: 'P/한글:123' })).toEqual({ path: '/program', context: { route: '/app/support-programs/detail', programSelected: true }, program: { sourceCode: 'BIZINFO', sourceProgramId: 'P/한글:123' } })
  expect(assistantOrigin('/all/preparation/12', { sourceCode: 'BIZINFO', sourceProgramId: 'P123' }).context.programSelected).toBe(false)
  expect(programIdentity('BIZINFO', ' bad ')).toBeNull()
  expect(programIdentity('BIZINFO', 'a\n')).toBeNull()
})

test('query-driven page labels stay local while the assistant HTTP context remains unchanged', () => {
  const browse = assistantOrigin('/all/collab', { management: '0' })
  const manage = assistantOrigin('/all/collab', { management: '1' })
  expect(browse.pageLabel).toBe('파트너 모집')
  expect(manage.pageLabel).toBe('파트너 관리')
  expect(browse.context).toEqual(manage.context)
  expect(manage.context).toEqual({ route: '/app/partners', programSelected: false })
  expect(manage.context).not.toHaveProperty('pageLabel')
  const result = assistantOrigin('/all/reviews/12', { step: 'analysis', runId: '30' })
  expect(result.pageLabel).toBe('검토 결과')
  expect(result.context).toEqual({ route: '/app/combination-reviews', programSelected: false })
})
test.each(['https://evil.test/app/chat', '//evil.test/app/chat', '/app/unknown', '/app/chat?mode=filter&mode=filter', '/app/chat?execute=1', '/app/proposals?box=sent', '/app/chat#fragment', '/app/partners/detail?recruitmentId=9007199254740993'])('unsafe or unsupported destination %s is rejected', to => expect(assistantDestination(to)).toBeNull())
test('search and personal workflow links are mapped without copying web paths', () => {
  expect(assistantDestination('/app/chat')).toEqual({ pathname: '/(tabs)', params: { mode: 'ai' } })
  expect(assistantDestination('/app/chat?mode=filter')).toEqual({ pathname: '/(tabs)', params: { mode: 'filter' } })
  expect(assistantDestination('/app/proposals')).toEqual({ pathname: '/(tabs)/all/collab', params: { management: '1', view: 'box', box: 'received', mine: '0' } })
  expect(assistantDestination('/app/profile', { company: true })).toBe('/(tabs)/all/company')
})
test('card kind and composite identity must match the linked item', () => {
  const card = { kind: 'PROGRAM' as const, id: 'BIZINFO:P/한글:123', title: '공고', subtitle: null, reason: '지원 대상', quote: null,
    to: '/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=P%2F%ED%95%9C%EA%B8%80%3A123' }
  expect(assistantCardDestination(card)).toEqual({ pathname: '/program', params: { sourceCode: 'BIZINFO', sourceProgramId: 'P/한글:123' } })
  expect(assistantCardDestination({ ...card, id: 'KSTARTUP:P/한글:123' })).toBeNull()
  expect(assistantCardDestination({ ...card, kind: 'RECRUITMENT', id: '123' })).toBeNull()
})
test('program questions retain the selected identity without putting the question in the URL', () => {
  const origin = assistantOrigin('/program', { sourceCode: 'BIZINFO', sourceProgramId: 'P123' })
  expect(programQuestionDestination(origin)).toEqual({ pathname: '/program', params: { sourceCode: 'BIZINFO', sourceProgramId: 'P123' } })
  expect(programQuestionDestination(assistantOrigin('/', {}))).toBeNull()
})
