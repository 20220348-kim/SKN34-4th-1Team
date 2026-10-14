import { useId } from 'react'
import type { EvaluationCatalog } from '../../../data/ops/opsApi'
import { workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'

const categories = [
  { id: 'quality', label: '실제 품질 평가용', description: '답변만 확인하려면 고정 근거 자료, 고정 원문 안의 근거 검색까지 확인하려면 RAG 자료를 선택하세요.' },
  { id: 'development', label: '개발 검증용', description: '가상 자료로 채점·연동·오류 처리를 확인합니다. 실제 공고의 품질을 대표하지 않습니다.' },
  { id: 'historical', label: '과거 자료', description: '이전 자료 버전이나 저장 기록을 비교·재현합니다.' },
] as const

export function EvaluationDatasetPicker({ datasets, value, disabled, onChange }: {
  datasets: EvaluationCatalog['datasets']; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const id = useId()
  const selected = datasets.find((dataset) => dataset.id === value)
  const guide = selected?.selection_guide
  const category = categories.find((item) => item.id === guide?.category)
  const groups = categories.map((item) => ({ ...item, datasets: datasets.filter((dataset) => dataset.selection_guide?.category === item.id) }))
  const unclassified = datasets.filter((dataset) => !dataset.selection_guide)
  const option = (dataset: EvaluationCatalog['datasets'][number]) => <option key={dataset.id} value={dataset.id}>
    {dataset.selection_guide ? `${dataset.selection_guide.title} · ${dataset.case_ids.length}문제` : dataset.label}
  </option>

  return <div className="grid min-w-0 gap-4 md:col-span-2">
    <div>
      <label htmlFor={id} className="text-sm font-semibold">평가 자료</label>
      <p id={`${id}-help`} className="mt-1 text-sm leading-6"><strong>등록된 평가 자료 {datasets.length}개</strong> 중 목적에 맞는 자료 하나를 선택하세요.</p>
      <p className="mt-1 text-sm leading-6 text-ink-muted">각 자료는 공고 원문·질문·채점 조건의 묶음입니다. 채점 조건·문단 분할·자료 버전이 다르면 별도 보관하므로 같은 질문이 여러 묶음에 포함될 수 있습니다. 모든 자료를 실행할 필요는 없습니다.</p>
    </div>
    <ul aria-label="평가 자료 용도 안내" className="grid list-none gap-2 p-0 sm:grid-cols-3">
      {groups.map((group) => <li key={group.id} className={`min-w-0 rounded-xl border p-3 ${category?.id === group.id ? 'border-brand-primary bg-brand-soft' : 'border-line bg-surface-muted'}`}>
        <p className="text-sm font-semibold">{group.label} <span className="ml-1 font-normal text-ink-muted">{group.datasets.length}개</span></p>
        <p className="mt-1 text-sm leading-6 text-ink-muted">{group.description}</p>
      </li>)}
    </ul>
    {unclassified.length > 0 && <p className="text-sm leading-6 text-ink-muted">분류 확인 필요 {unclassified.length}개 · 용도 설명이 없는 자료도 전체 개수에 포함됩니다.</p>}
    <details className="min-w-0 rounded-xl border border-line">
      <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand-primary">등록 자료 구성 보기</summary>
      <div className="overflow-x-auto px-4 pb-4">
        <table className="w-full min-w-[36rem] border-collapse text-left text-sm leading-6">
          <caption className="sr-only">등록된 평가 자료 구성</caption>
          <thead><tr className="border-b border-line text-ink-muted">
            <th scope="col" className="w-1/3 py-2 pr-4 font-semibold">자료 이름</th>
            <th scope="col" className="py-2 pr-4 font-semibold">용도</th>
            <th scope="col" className="whitespace-nowrap py-2 pr-4 font-semibold">사례 수</th>
            <th scope="col" className="py-2 font-semibold">평가 목적</th>
          </tr></thead>
          <tbody>{datasets.map((dataset) => <tr key={dataset.id} className="border-b border-line last:border-0">
            <th scope="row" className="py-3 pr-4 align-top font-medium break-words">{dataset.selection_guide?.title ?? dataset.label}</th>
            <td className="py-3 pr-4 align-top text-ink-muted">{categories.find((item) => item.id === dataset.selection_guide?.category)?.label ?? '분류 확인 필요'}</td>
            <td className="whitespace-nowrap py-3 pr-4 align-top text-ink-muted">{dataset.case_ids.length}개</td>
            <td className="py-3 align-top text-ink-muted">{dataset.selection_guide?.purpose ?? '용도 설명이 제공되지 않았습니다.'}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
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
