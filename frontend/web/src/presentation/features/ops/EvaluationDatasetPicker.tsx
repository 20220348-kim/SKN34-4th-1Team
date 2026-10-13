import { useId } from 'react'
import type { OpsSession } from '../../../data/ops/opsApi'
import { workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'

const categories = [
  { id: 'quality', label: '실제 품질 평가용', description: '실제 공고로 답변이나 문단 검색의 품질을 확인합니다.' },
  { id: 'development', label: '개발 검증용', description: '가상 자료·모의 응답으로 채점과 오류 처리를 확인합니다.' },
  { id: 'historical', label: '과거 자료', description: '이전 자료 버전이나 저장 기록을 비교·재현합니다.' },
] as const

export function EvaluationDatasetPicker({ datasets, value, disabled, onChange }: {
  datasets: OpsSession['datasets']; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const id = useId()
  const selected = datasets.find((dataset) => dataset.id === value)
  const guide = selected?.selection_guide
  const category = categories.find((item) => item.id === guide?.category)
  const groups = categories.map((item) => ({ ...item, datasets: datasets.filter((dataset) => dataset.selection_guide?.category === item.id) }))
  const unclassified = datasets.filter((dataset) => !dataset.selection_guide)
  const option = (dataset: OpsSession['datasets'][number]) => <option key={dataset.id} value={dataset.id}>
    {dataset.selection_guide ? `${dataset.selection_guide.title} · ${dataset.case_ids.length}문제` : dataset.label}
  </option>

  return <div className="grid min-w-0 gap-4 md:col-span-2">
    <div>
      <label htmlFor={id} className="text-sm font-semibold">평가 자료</label>
      <p id={`${id}-help`} className="mt-1 text-sm leading-6 text-ink-muted">공고 원문·질문·채점 조건을 묶은 시험 자료입니다. 확인하려는 목적에 맞게 선택하세요.</p>
    </div>
    <ul aria-label="평가 자료 용도 안내" className="grid list-none gap-2 p-0 sm:grid-cols-3">
      {groups.map((group) => <li key={group.id} className={`min-w-0 rounded-xl border p-3 ${category?.id === group.id ? 'border-brand-primary bg-brand-soft' : 'border-line bg-surface-muted'}`}>
        <p className="text-sm font-semibold">{group.label} <span className="ml-1 font-normal text-ink-muted">{group.datasets.length}개</span></p>
        <p className="mt-1 text-sm leading-6 text-ink-muted">{group.description}</p>
      </li>)}
    </ul>
    <select id={id} aria-describedby={`${id}-help`} className="min-h-11 w-full min-w-0 rounded-xl border border-line bg-white px-3 text-sm focus:outline-2 focus:outline-brand-primary"
      value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {groups.filter((group) => group.datasets.length > 0).map((group) => <optgroup key={group.id} label={group.label}>{group.datasets.map(option)}</optgroup>)}
      {unclassified.length > 0 && <optgroup label="분류 확인 필요">{unclassified.map(option)}</optgroup>}
    </select>
    {selected && <section aria-label="선택한 평가 자료 설명" aria-live="polite" className="min-w-0 rounded-xl border border-line p-4 text-sm leading-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className={workspaceTagClassName('info')}>{category?.label ?? '분류 확인 필요'}</span>
        <span className="text-ink-muted">질문 {selected.case_ids.length}개</span>
      </div>
      <h3 className="mt-2 font-bold break-words">{guide?.title ?? selected.label}</h3>
      {guide ? <dl className="mt-3 grid gap-3">
        <div><dt className="font-semibold">평가 목적</dt><dd className="mt-1 text-ink-muted">{guide.purpose}</dd></div>
        <div><dt className="font-semibold">사용 자료</dt><dd className="mt-1 text-ink-muted">{guide.material}</dd></div>
        <div className="rounded-lg bg-surface-muted p-3"><dt className="font-semibold">평가 범위와 한계</dt><dd className="mt-1 text-ink-muted">{guide.limitations}</dd></div>
      </dl> : <p className="mt-2 text-ink-muted">이 자료의 용도 설명이 아직 제공되지 않았습니다. 자료 이름만으로 실제 품질 평가용인지 판단하지 마세요.</p>}
      <p className="mt-3 text-xs leading-5 text-ink-muted">자료 분류는 검토 승인이나 품질 합격을 뜻하지 않습니다. v1·v2·v3는 자료의 수정 버전이며, H01 같은 표시는 질문 번호입니다.</p>
    </section>}
  </div>
}
