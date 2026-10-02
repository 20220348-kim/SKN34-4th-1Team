// @vitest-environment jsdom
import { asValue } from 'awilix/browser'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { ApplicationOnlineInputGuide } from './ApplicationOnlineInputGuide'
import { formatSavedApplicationAnswers } from '@govbiz/shared/domain/entities/ApplicationOnlineInputGuide'
import { applicationOnlineInputGuideSchema } from '@govbiz/shared/data/models/ApplicationOnlineInputGuideDto'
import fixture from '../../../../../../../evaluation/application-map/fixtures/synthetic-online-input-guide-v1.json'

const original = appContainer.resolve('applicationPreparationUseCase')
const guide = applicationOnlineInputGuideSchema.parse(fixture)
const load = vi.fn()
const copy = vi.fn()
beforeEach(() => {
  load.mockReset().mockResolvedValue(guide)
  copy.mockReset().mockResolvedValue(undefined)
  appContainer.register({ applicationPreparationUseCase: asValue({ onlineInputGuide: load }) })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true })
})
afterEach(() => { cleanup(); appContainer.register({ applicationPreparationUseCase: asValue(original) }); vi.restoreAllMocks() })

it('announces loading for screen readers, draws three bars after a short delay and styles a failure as an alert', async () => {
  let resolve!: (value: typeof guide) => void
  load.mockReturnValueOnce(new Promise<typeof guide>((done) => { resolve = done })).mockRejectedValueOnce(new Error('안내를 잠시 불러올 수 없습니다.'))
  const { rerender } = render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} defaultOpen />)
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('입력 안내를 불러오는 중입니다.')
  expect(status.className).toBe('sr-only')
  expect(document.querySelector('[aria-hidden="true"] [class*="animate-pulse"]')).toBeNull()
  await waitFor(() => expect(document.querySelectorAll('[aria-hidden="true"] [class*="animate-pulse"]')).toHaveLength(3))
  resolve(guide)
  expect(await screen.findByText('준비된 답변 5 / 8')).toBeTruthy()
  expect(document.querySelector('[aria-hidden="true"] [class*="animate-pulse"]')).toBeNull()

  rerender(<ApplicationOnlineInputGuide preparationId={31} inputRevision={1} defaultOpen />)
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('안내를 잠시 불러올 수 없습니다.')
  expect(alert.className).toContain('bg-danger-soft')
  expect(screen.getByRole('button', { name: '입력 안내 다시 불러오기' })).toBeTruthy()
})
it('renders ready answers independently of unverified external mapping', async () => {
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  expect(await screen.findByText('준비된 답변 5 / 8')).toBeTruthy()
  expect(screen.getAllByText('준비 완료')).toHaveLength(5)
  expect(screen.getAllByText('입력 형태 미확인: 외부 신청 화면의 해당 문항을 확인해 직접 붙여넣어주세요.')).toHaveLength(5)
  expect(screen.getAllByRole('button', { name: /저장 답변 복사$/ })).toHaveLength(5)
  expect(screen.queryByRole('button', { name: '지원 분야 저장 답변 복사' })).toBeNull()
  expect(screen.queryByRole('button', { name: '필수 미응답 저장 답변 복사' })).toBeNull()
  expect(screen.getAllByText('답변 필요')).toHaveLength(2)
  expect(screen.getByText('확인 필요')).toBeTruthy()
  expect(screen.queryByRole('link', { name: '공식 신청처 열기' })).toBeNull()
})
it('copies individual stored Fact and exact full payload, excluding invalid/missing values', async () => {
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  fireEvent.click(await screen.findByRole('button', { name: '기업명 저장 답변 복사' }))
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('주식회사 합성테크'))
  fireEvent.click(screen.getByRole('button', { name: '저장된 확정 답변 전체 복사' }))
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('Q. 기업명\nA. 주식회사 합성테크\n\nQ. 대표자명\nA. 가상대표\n\nQ. 사업자등록번호\nA. 000-00-00000\n\nQ. 지원동기\nA. 합성 평가용 지원동기입니다.\n\nQ. 업종\nA. 정보통신업'))
  expect(await screen.findByText('복사됨')).toBeTruthy()
})
it('reports clipboard failure', async () => {
  copy.mockRejectedValueOnce(new Error('denied'))
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  fireEvent.click(await screen.findByRole('button', { name: '기업명 저장 답변 복사' }))
  expect(await screen.findByText('복사에 실패했습니다. 직접 선택하여 복사해주세요.')).toBeTruthy()
})
it('downloads BOM UTF-8 TXT with the same payload and a safe generated filename', async () => {
  let blob: Blob | undefined
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn((value: Blob) => { blob = value; return 'blob:test' }), configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  let filename = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  fireEvent.click(await screen.findByRole('button', { name: '저장된 확정 답변 TXT 다운로드' }))
  expect(filename).toBe('application-answers-30.txt')
  expect(blob?.type).toBe('text/plain;charset=utf-8')
  const bytes = await new Promise<ArrayBuffer>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob!) })
  expect(Array.from(new Uint8Array(bytes).slice(0, 3))).toEqual([239, 187, 191])
  const content = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob!) })
  expect(content.replace(/^\uFEFF/, '')).toBe(formatSavedApplicationAnswers(guide))
})
it('renders a validated official link in a protected new tab', async () => {
  load.mockResolvedValueOnce({ ...guide, officialApplicationUrl: 'https://example.test/apply' })
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  const link = await screen.findByRole('link', { name: 'Google Form에서 신청하기' })
  expect(link.getAttribute('href')).toBe('https://example.test/apply')
  expect(link.getAttribute('rel')).toBe('noreferrer')
  expect(link.getAttribute('target')).toBe('_blank')
})
it('rejects a stale input revision and offers retry instead of exporting', async () => {
  load.mockResolvedValueOnce({ ...guide, inputRevision: 2 })
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '저장된 확정 답변 TXT 다운로드' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '입력 안내 다시 불러오기' }))
  expect(await screen.findByRole('button', { name: '기업명 저장 답변 복사' })).toBeTruthy()
})

it('shows direct processing only for an explicit noncopyable item', async () => {
  load.mockResolvedValueOnce({ ...guide, readyCount: 4, directInputCount: 1,
    items: guide.items.map((item, index) => index === 0 ? { ...item, status: 'DIRECT_INPUT', copyable: false } : item),
    savedAnswers: guide.savedAnswers.slice(1) })
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  expect(await screen.findByText('직접 처리 필요')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '기업명 저장 답변 복사' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '저장된 확정 답변 전체 복사' }))
  await waitFor(() => expect(copy).toHaveBeenCalled())
  expect(copy.mock.calls[0][0]).not.toContain('주식회사 합성테크')
})

it('shows real Google question order, choices and a safe direct-input state', async () => {
  load.mockResolvedValueOnce({ ...guide, totalCount: 2, readyCount: 1, needsReviewCount: 0, missingCount: 0,
    directInputCount: 1, externalMappingVerified: false,
    officialApplicationUrl: 'https://docs.google.com/forms/d/e/id/viewform',
    items: [
      { fieldId: 'company:name', sourceControlId: 'q-1', label: '실제 기업명 질문', required: true,
        status: 'READY', answer: '합성테크', inputMode: 'SHORT_TEXT', options: [], copyable: true },
      { fieldId: null, sourceControlId: 'q-2', label: '실제 복수 선택 질문', required: true,
        status: 'DIRECT_INPUT', answer: null, inputMode: 'MULTI_CHOICE', options: ['A', 'B'], copyable: false },
    ], savedAnswers: [{ fieldId: 'company:name', label: '실제 기업명 질문', answer: '합성테크' }] })
  render(<ApplicationOnlineInputGuide preparationId={30} inputRevision={1} />)
  expect(await screen.findByText('실제 기업명 질문')).toBeTruthy()
  expect(screen.getByText('실제 복수 선택 질문')).toBeTruthy()
  expect(screen.getByText('선택지: A, B')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '실제 복수 선택 질문 저장 답변 복사' })).toBeNull()
  const link = screen.getByRole('link', { name: 'Google Form에서 신청하기' })
  expect(link.getAttribute('target')).toBe('_blank')
  fireEvent.click(screen.getByRole('button', { name: '저장된 확정 답변 전체 복사' }))
  await waitFor(() => expect(copy).toHaveBeenCalledWith('Q. 실제 기업명 질문\nA. 합성테크'))
})
