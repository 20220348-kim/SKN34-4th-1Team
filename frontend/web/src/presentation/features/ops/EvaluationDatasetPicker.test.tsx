// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getEvaluationCatalog, type EvaluationCatalog } from '../../../data/ops/opsApi'
import { EvaluationDatasetPicker } from './EvaluationDatasetPicker'
import registeredJson from '../../../../../../backend/ops-service/apps/evaluations/capture_catalog.json?raw'

type Dataset = EvaluationCatalog['datasets'][number]
let datasets: Dataset[]

beforeAll(async () => {
  const registered = JSON.parse(registeredJson) as Dataset[]
  const response = { datasets: registered.map((item) => ({
    id: item.id, label: item.label, case_ids: item.case_ids, selection_guide: item.selection_guide,
    evaluation_scope: item.evaluation_scope ?? 'fixed-answer-context-only', fixture: item.fixture,
    captures: item.captures.map(({ id, label }) => ({ id, label })), baseline: null, live_config: null,
    execution_profiles: { replay: 'a'.repeat(64), live: null },
  })) }
  // Repository registration is normalized to the public API contract; no server or model is called.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })))
  try { datasets = (await getEvaluationCatalog()).datasets }
  finally { vi.unstubAllGlobals() }
})
afterEach(cleanup)

const mount = (items = datasets, value = items[0]?.id ?? '', disabled = false, onChange = vi.fn()) =>
  render(<EvaluationDatasetPicker datasets={items} value={value} disabled={disabled} onChange={onChange} />)
const showComposition = () => {
  fireEvent.click(screen.getByText('등록 자료 구성 보기'))
  return within(screen.getByRole('table', { name: '등록된 평가 자료 구성' }))
}

describe('평가 자료 선택 안내', () => {
  it('현재 등록된 10개 자료를 용도별 2·4·4개로 설명하고 모든 자료의 목적과 사례 수를 보여준다', () => {
    mount()
    expect(screen.getByText('등록된 평가 자료 10개')).toBeTruthy()
    const cards = within(screen.getByRole('list', { name: '평가 자료 용도 안내' })).getAllByRole('listitem')
    expect(cards.map((card) => card.querySelector('p')?.textContent)).toEqual(['실제 품질 평가용 2개', '개발 검증용 4개', '과거 자료 4개'])
    expect(screen.getByText(/같은 질문이 여러 묶음에 포함될 수 있습니다/)).toBeTruthy()
    expect(screen.getByText(/모든 자료를 실행할 필요는 없습니다/)).toBeTruthy()
    expect(screen.getByText(/고정 원문 안의 근거 검색까지 확인하려면 RAG 자료/)).toBeTruthy()

    const table = showComposition()
    expect(table.getAllByRole('row')).toHaveLength(datasets.length + 1)
    datasets.forEach((dataset) => {
      const row = within(table.getByRole('rowheader', { name: dataset.selection_guide!.title }).closest('tr')!)
      expect(row.getByText(`${dataset.case_ids.length}개`)).toBeTruthy()
      expect(row.getByText(dataset.selection_guide!.purpose)).toBeTruthy()
    })
  })

  it('서버 목록의 개수가 달라지면 전체·분류 개수를 갱신하고 선택을 자동 변경하지 않는다', () => {
    const onChange = vi.fn()
    const view = mount(datasets, datasets[0].id, false, onChange)
    const subset = datasets.slice(0, 2)
    view.rerender(<EvaluationDatasetPicker datasets={subset} value={datasets[0].id} disabled={false} onChange={onChange} />)
    expect(screen.getByText('등록된 평가 자료 2개')).toBeTruthy()
    expect(screen.queryByText('등록된 평가 자료 10개')).toBeNull()
    const cards = within(screen.getByRole('list', { name: '평가 자료 용도 안내' })).getAllByRole('listitem')
    expect(cards.map((card) => card.querySelector('p')?.textContent)).toEqual(['실제 품질 평가용 0개', '개발 검증용 1개', '과거 자료 1개'])
    expect(screen.getByRole('combobox', { name: '평가 자료' })).toHaveProperty('value', datasets[0].id)
    expect(showComposition().getAllByRole('row')).toHaveLength(3)
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([undefined, null])('용도 설명이 %s인 자료도 전체 수·선택 목록·구성 표에서 누락하지 않는다', (guide) => {
    const unknown = { ...datasets[0], id: 'unclassified-material', label: '새로 등록된 설명 없는 자료', selection_guide: guide, case_ids: ['N01', 'N02'] }
    mount([...datasets, unknown], unknown.id)
    expect(screen.getByText('등록된 평가 자료 11개')).toBeTruthy()
    expect(screen.getByText(/분류 확인 필요 1개 · 용도 설명이 없는 자료도 전체 개수에 포함/)).toBeTruthy()
    const select = screen.getByRole('combobox', { name: '평가 자료' })
    expect(select).toHaveProperty('value', unknown.id)
    expect(within(select).getByRole('group', { name: '분류 확인 필요' })).toBeTruthy()
    expect(within(select).getByRole('option', { name: unknown.label })).toBeTruthy()
    const selected = within(screen.getByRole('region', { name: '선택한 평가 자료 설명' }))
    expect(selected.getByRole('heading', { name: unknown.label })).toBeTruthy()
    expect(selected.getByText(/자료 이름만으로 실제 품질 평가용인지 판단하지 마세요/)).toBeTruthy()
    expect(selected.getByText('질문 2개')).toBeTruthy()
    const table = showComposition()
    expect(table.getAllByRole('row')).toHaveLength(12)
    const row = within(table.getByRole('rowheader', { name: unknown.label }).closest('tr')!)
    expect(row.getByText('분류 확인 필요')).toBeTruthy()
    expect(row.getByText('용도 설명이 제공되지 않았습니다.')).toBeTruthy()
  })

  it('현재 선택과 비활성 상태를 유지하고 설명 펼치기로 실행이나 자료 변경을 하지 않는다', () => {
    const selected = datasets.find((item) => item.selection_guide?.category === 'quality')!
    const onChange = vi.fn()
    mount(datasets, selected.id, true, onChange)
    const select = screen.getByRole('combobox', { name: '평가 자료' })
    expect(select).toHaveProperty('disabled', true)
    expect(select).toHaveProperty('value', selected.id)
    showComposition()
    expect(select).toHaveProperty('disabled', true)
    expect(select).toHaveProperty('value', selected.id)
    expect(onChange).not.toHaveBeenCalled()
    const explanation = within(screen.getByRole('region', { name: '선택한 평가 자료 설명' }))
    expect(explanation.getByText(selected.selection_guide!.purpose)).toBeTruthy()
    expect(explanation.getByText(selected.selection_guide!.material)).toBeTruthy()
    expect(explanation.getByText(selected.selection_guide!.limitations)).toBeTruthy()
    expect(explanation.getByText(`질문 ${selected.case_ids.length}개`)).toBeTruthy()
    expect(explanation.getByText(/자료 분류는 검토 승인이나 품질 합격을 뜻하지 않습니다/)).toBeTruthy()
  })

  it('사용자가 다른 자료를 선택한 경우에만 기존 변경 콜백을 호출한다', () => {
    const onChange = vi.fn()
    mount(datasets, datasets[0].id, false, onChange)
    const next = datasets.find((item) => item.selection_guide?.category === 'quality')!
    fireEvent.change(screen.getByRole('combobox', { name: '평가 자료' }), { target: { value: next.id } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(next.id)
  })
})
