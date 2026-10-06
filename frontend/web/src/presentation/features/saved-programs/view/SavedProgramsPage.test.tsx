// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { SavedProgramsPage } from './SavedProgramsPage'
import { createCalendarPreview } from '../viewmodel/savedProgramCalendar'
import { chooseOption, optionLabels } from '../../../../test/selectField'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('관심 공고를 내부 스크롤 없이 달력과 페이지 목록으로 확인한다', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-10T03:00:00Z'))
  render(<MemoryRouter><SavedProgramsPage initial={{ today: '2026-09-10', programs: createCalendarPreview('2026-09-10') }} /></MemoryRouter>)
  // 기본 보기는 목록이고, 세그먼트는 제목 옆 왼쪽에 목록 · 달력 · 진행 관리 순서입니다.
  expect(screen.getByRole('tabpanel', { name: '관심 공고 목록' })).toBeTruthy()
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['목록', '달력', '진행 관리'])
  fireEvent.click(screen.getByRole('tab', { name: '달력' }))
  expect(screen.getByRole('table', { name: '2026년 9월 접수 일정' })).toBeTruthy()
  expect(screen.queryByRole('region', { name: '달력 내부 스크롤' })).toBeNull()
  expect(screen.queryByRole('link', { name: /지원사업 찾기/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /공고 찾기/ })).toBeNull()
  expect(screen.getByRole('button', { name: '오늘' })).toBeTruthy()
  expect(document.querySelector('time[aria-current="date"]')?.textContent).toBe('10')
  const crowdedDay = within(screen.getByRole('table')).getByRole('list', { name: /2026-09-11 접수 일정/ })
  expect(within(crowdedDay).getAllByTitle(/지원/)[0]?.classList.contains('overflow-hidden')).toBe(true)
  expect(within(crowdedDay).getAllByTitle(/지원/)[0]?.querySelector('[class*="text-ellipsis"]')).toBeTruthy()
  fireEvent.click(within(crowdedDay).getByRole('button', { name: /건 더보기/ }))
  const dialog = screen.getByRole('dialog', { name: /2026-09-11/ })
  expect(within(dialog).getByRole('list', { name: '2026-09-11 전체 접수 일정' }).children).toHaveLength(4)
  fireEvent.click(within(dialog).getByRole('button', { name: '2페이지' }))
  expect(within(dialog).getByRole('button', { name: '2페이지' }).getAttribute('aria-current')).toBe('page')
  expect(within(dialog).getByRole('list', { name: '2026-09-11 전체 접수 일정' }).children).toHaveLength(4)
  fireEvent.click(within(dialog).getByRole('button', { name: '전체 공고 닫기' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  // 칸 안 막대는 두 줄까지만 보이고 나머지는 "+n건 더보기"입니다. 막대에는 색과 함께 글자가 붙습니다.
  expect(within(crowdedDay).getAllByRole('listitem')).toHaveLength(3)
  expect(within(screen.getByRole('table')).getAllByText('접수 시작').length).toBeGreaterThan(0)
  expect(within(screen.getByRole('table')).getAllByText('접수 마감').length).toBeGreaterThan(0)
  expect(within(screen.getByRole('table')).queryByText('시')).toBeNull()
  expect(within(screen.getByRole('table')).queryByRole('link')).toBeNull()
  // 지역·분야·대상은 드롭다운을 펼쳐 체크박스로 여러 개를 함께 고릅니다. 고르는 동안 목록은 닫히지 않습니다.
  fireEvent.click(screen.getByRole('button', { name: '분야' }))
  const categoryGroup = within(screen.getByRole('group', { name: '분야' }))
  fireEvent.click(categoryGroup.getByRole('checkbox', { name: '사업화' }))
  expect(screen.getByText(/표시 공고/).textContent).toContain('4건 / 전체 24건')
  fireEvent.click(categoryGroup.getByRole('checkbox', { name: '수출' }))
  expect(screen.getByText(/표시 공고/).textContent).toContain('8건 / 전체 24건')
  expect(screen.getByRole('button', { name: /분야 · 수출/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /분야 · 사업화/ }))
  expect(screen.getByText(/표시 공고/).textContent).toContain('4건 / 전체 24건')
  fireEvent.click(categoryGroup.getByRole('checkbox', { name: '전체 분야' }))
  expect(screen.getByText(/표시 공고/).textContent).toContain('24건 / 전체 24건')
  fireEvent.click(categoryGroup.getByRole('checkbox', { name: '사업화' }))
  expect(screen.getByRole('button', { name: '분야' }).textContent).toContain('1')
  fireEvent.keyDown(screen.getByRole('group', { name: '분야' }), { key: 'Escape' })
  expect(screen.queryByRole('group', { name: '분야' })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox', { name: '공고명 또는 기관명' }), { target: { value: '서울경제' } })
  fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }))
  fireEvent.click(screen.getByRole('tab', { name: '목록' }))
  expect(screen.getByRole('tabpanel', { name: '관심 공고 목록' })).toBeTruthy()
  // 넓은 화면은 표 한 벌만 그립니다. 행마다 [관심 공고에서 빼기]가 있고 상세는 제목 링크로 갑니다.
  expect(screen.getAllByRole('article')).toHaveLength(8)
  expect(screen.getAllByRole('button', { name: '관심 공고에서 빼기' })).toHaveLength(8)
  expect(screen.queryByRole('link', { name: '상세 보기' })).toBeNull()
  expect(screen.getByRole('navigation', { name: '관심 공고 페이지' })).toBeTruthy()
  const firstPage = screen.getByRole('button', { name: '1페이지' })
  expect(firstPage.classList.contains('text-white')).toBe(true)
  expect(firstPage.classList.contains('text-ink-muted')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '2페이지' }))
  expect(screen.getByRole('button', { name: '2페이지' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(screen.getByRole('tab', { name: '달력' }))
  // 연도 목록과 월 이동은 같은 2000~2100년 범위입니다.
  const yearOptions = optionLabels(screen.getByRole('combobox', { name: '달력 연도' }))
  expect(yearOptions).toHaveLength(101)
  expect(yearOptions[0]).toBe('2000년')
  expect(yearOptions[100]).toBe('2100년')
  expect(screen.queryByRole('button', { name: '다음 연도' })).toBeNull()
  chooseOption(screen.getByRole('combobox', { name: '달력 연도' }), '2027')
  expect(screen.getByRole('table', { name: '2027년 9월 접수 일정' })).toBeTruthy()
  expect(screen.queryByText('이 달에 표시할 관심 공고가 없습니다.')).toBeNull()
  chooseOption(screen.getByRole('combobox', { name: '달력 월' }), '12')
  fireEvent.click(screen.getByRole('button', { name: '다음 달' }))
  expect(screen.getByRole('table', { name: '2028년 1월 접수 일정' })).toBeTruthy()
})

it.each([2031, 2050, 2100])('관심 공고 달력에서 %i년을 직접 선택하고 오늘로 돌아온다', (year) => {
  render(<MemoryRouter><SavedProgramsPage initial={{ today: '2026-10-05', programs: createCalendarPreview('2026-10-05') }} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('tab', { name: '달력' }))
  chooseOption(screen.getByRole('combobox', { name: '달력 연도' }), String(year))
  expect(screen.getByRole('table', { name: `${year}년 10월 접수 일정` })).toBeTruthy()
  chooseOption(screen.getByRole('combobox', { name: '달력 월' }), '12')
  if (year === 2100) {
    expect((screen.getByRole('button', { name: '다음 달' }) as HTMLButtonElement).disabled).toBe(true)
  } else {
    fireEvent.click(screen.getByRole('button', { name: '다음 달' }))
    expect(screen.getByRole('table', { name: `${year + 1}년 1월 접수 일정` })).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('button', { name: '오늘' }))
  expect(screen.getByRole('table', { name: '2026년 10월 접수 일정' })).toBeTruthy()
})

it('관심 공고 목록은 날짜가 아니라 서버 접수 상태를 표시한다', () => {
  const base = createCalendarPreview('2026-09-10')[0]!
  const programs = (['OPEN', 'UPCOMING', 'CLOSED', 'UNKNOWN'] as const).map((status, index) => ({
    ...base,
    id: `${base.id}-${index}`,
    startDate: '2099-01-01',
    endDate: '2099-12-31',
    status,
  }))
  render(<MemoryRouter><SavedProgramsPage initial={{ today: '2026-09-10', programs }} /></MemoryRouter>)

  expect(screen.getByText('접수 중')).toBeTruthy()
  expect(screen.getByText('접수 예정')).toBeTruthy()
  expect(screen.getByText('접수 마감')).toBeTruthy()
  expect(screen.getByText('상태 확인 필요')).toBeTruthy()
})

it('진행 관리를 열 때 실제 신청 준비 건만 준비 중 단계에 표시한다', async () => {
  const list = vi.fn().mockResolvedValue({
    items: [{
      id: 41,
      inputRevision: 3,
      progressStage: 'PREPARING' as const,
      progressRevision: 1,
      progressStageUpdatedAt: '2026-09-13T09:20:00+09:00',
      sourceCode: 'BIZINFO',
      sourceProgramId: 'PBLN_41',
      serviceField: 'MARKETING' as const,
      programTitle: '해외 진출 역량 강화 지원사업',
      formTitle: '참여기업 신청서',
      updatedAt: '2026-09-13T09:20:00+09:00',
    }],
    nextBeforeId: null,
  })
  const updateProgress = vi.fn().mockResolvedValue({
    progressStage: 'APPLIED',
    progressRevision: 2,
    progressStageUpdatedAt: '2026-09-13T10:00:00+09:00',
    updatedAt: '2026-09-13T10:00:00+09:00',
  })

  // 신청 준비를 시작하면 서버가 관심 공고함에도 담아 두므로, 준비 건의 공고는 관심 공고 목록에도 있습니다.
  const preparedProgram = {
    id: 'BIZINFO:PBLN_41',
    sourceCode: 'BIZINFO',
    sourceProgramId: 'PBLN_41',
    title: '해외 진출 역량 강화 지원사업',
    organization: '중소벤처기업부',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    status: 'OPEN' as const,
    region: '전국',
    category: '수출',
    target: '중소기업',
  }

  render(<MemoryRouter><SavedProgramsPage
    initial={{ today: '2026-09-13', programs: [preparedProgram] }}
    preparationUseCase={{ list, updateProgress }}
  /></MemoryRouter>)

  // 목록의 "진행 단계" 열도 신청 준비 건을 쓰므로 목록에서 이미 한 번 읽고, 진행 관리로 가도 다시 읽지 않습니다.
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: '해외 진출 역량 강화 지원사업 진행 단계: 준비 중' })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '진행 관리' }))
  expect(list).toHaveBeenCalledTimes(1)

  const board = screen.getByLabelText('지원사업 파이프라인')
  // 7단계 데이터는 그대로 두고 보드는 5열(심사 중 = 서류 · 발표, 결과 = 선정 · 미선정)로 묶습니다.
  expect(within(board).getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
    '관심', '준비 중', '제출 완료', '심사 중', '결과',
  ])
  expect(within(board).getAllByRole('article')).toHaveLength(1)
  expect(within(board).getByRole('link', { name: '해외 진출 역량 강화 지원사업' }).getAttribute('href'))
    .toBe('/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_41')
  expect(screen.getByRole('form', { name: '관심 공고 필터' })).toBeTruthy()

  // 카드의 [단계 바꾸기] → 옆 패널에서 라디오를 고르고 [저장]해야 바뀝니다.
  fireEvent.click(screen.getByRole('button', { name: '해외 진출 역량 강화 지원사업 단계 바꾸기' }))
  const panel = screen.getByRole('dialog', { name: '진행 단계 바꾸기' })
  expect((within(panel).getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(panel).getByRole('radio', { name: /제출 완료/ }))
  fireEvent.click(within(panel).getByRole('button', { name: '저장' }))
  await waitFor(() => expect(updateProgress).toHaveBeenCalledWith(41, {
    expectedProgressRevision: 1,
    progressStage: 'APPLIED',
  }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '진행 단계 바꾸기' })).toBeNull())
  expect(within(screen.getByRole('region', { name: '제출 완료' })).getByRole('article')).toBeTruthy()
})

it('진행 관리의 관심 단계는 세 건만 보이고 더보기 팝업에서 네 건씩 번호로 이동한다', async () => {
  const programs = createCalendarPreview('2026-09-10').slice(0, 5)
  const list = vi.fn().mockResolvedValue({ items: [], nextBeforeId: null })
  render(<MemoryRouter><SavedProgramsPage
    initial={{ today: '2026-09-10', programs }}
    preparationUseCase={{ list, updateProgress: vi.fn() }}
  /></MemoryRouter>)
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  // 신청 준비가 없는 관심 공고의 단계 배지는 "관심"이고, 패널은 안내와 [신청 문서 작성]만 보여 줍니다.
  fireEvent.click(screen.getAllByRole('button', { name: /진행 단계: 관심/ })[0]!)
  const stagePanel = screen.getByRole('dialog', { name: '진행 단계 바꾸기' })
  expect(within(stagePanel).queryByRole('radio')).toBeNull()
  expect(within(stagePanel).queryByRole('button', { name: '저장' })).toBeNull()
  fireEvent.click(within(stagePanel).getByRole('button', { name: '취소' }))
  expect(screen.queryByRole('dialog', { name: '진행 단계 바꾸기' })).toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: '진행 관리' }))
  const interest = screen.getByRole('region', { name: '관심' })
  expect(within(interest).getAllByRole('article')).toHaveLength(3)
  fireEvent.click(within(interest).getByRole('button', { name: '+2건 더보기' }))
  const dialog = screen.getByRole('dialog', { name: /관심 · 5건/ })
  expect(within(dialog).getAllByRole('article')).toHaveLength(4)
  expect(within(dialog).getByRole('button', { name: '1페이지' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(within(dialog).getByRole('button', { name: '2페이지' }))
  expect(within(dialog).getAllByRole('article')).toHaveLength(1)
})
