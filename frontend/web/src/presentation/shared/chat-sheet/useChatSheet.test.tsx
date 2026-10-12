// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter, type NavigateFunction, useNavigate } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import { useChatSheetRouting } from './useChatSheet'

afterEach(cleanup)

const detail = '/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_1'
const question = '/app/support-programs/detail/question?sourceCode=BIZINFO&sourceProgramId=PBLN_1'

let navigateTo: NavigateFunction
let sheet: ReturnType<typeof useChatSheetRouting>
function Probe() {
  navigateTo = useNavigate()
  sheet = useChatSheetRouting()
  return null
}

function start(path: string) {
  render(<MemoryRouter initialEntries={[path]}><Probe /></MemoryRouter>)
}

it('opens every sheet screen over the chat', async () => {
  start('/app/chat')
  await act(async () => navigateTo('/app/application-preparations/12'))
  expect(sheet.background?.pathname).toBe('/app/chat')
  expect(sheet.kind).toBe('신청 문서')
})

it('opens the program detail and question over other work screens but keeps destination screens full page', async () => {
  start('/app/application-preparations')
  await act(async () => navigateTo(detail))
  // 목록 위에 같은 시트로 열고, 목록은 뒤에 그대로 둡니다.
  expect(sheet.background?.pathname).toBe('/app/application-preparations')
  expect(sheet.kind).toBe('공고 상세')
  // 시트 안에서 원문 질문으로 옮겨도 같은 시트입니다.
  await act(async () => navigateTo(question))
  expect(sheet.background?.pathname).toBe('/app/application-preparations')
  expect(sheet.kind).toBe('원문 질문')

  // 신청 문서 · 검토처럼 그 자체가 목적지인 화면은 목록에서 열면 전체 화면입니다.
  cleanup()
  start('/app/application-preparations')
  await act(async () => navigateTo('/app/application-preparations/12'))
  expect(sheet.background).toBeNull()
  start('/app/combination-reviews')
  await act(async () => navigateTo('/app/combination-reviews/3'))
  expect(sheet.background).toBeNull()
})

it('does not stack a sheet on a full-page detail, an address replacement or a public page', async () => {
  start(detail)
  await act(async () => navigateTo(question))
  expect(sheet.background).toBeNull()
  cleanup()
  start('/app/saved-programs')
  await act(async () => navigateTo(detail, { replace: true }))
  expect(sheet.background).toBeNull()
  cleanup()
  start('/')
  await act(async () => navigateTo('/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_1'))
  expect(sheet.background).toBeNull()
})
