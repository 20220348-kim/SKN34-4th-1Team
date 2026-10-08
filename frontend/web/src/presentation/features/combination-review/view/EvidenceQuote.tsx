import { useState } from 'react'
import {
  evidenceFormatOf, evidenceHasContext, evidenceLocatorLabel, evidencePreview, evidenceQuoteCut, evidenceQuoteRange, formatEvidenceText, isApplicationFormText,
  splitEvidenceKeywords, type EvidenceLine,
} from '@govbiz/shared/domain/entities/CombinationReviewEvidence'
import type { ReviewCitation, ReviewRun } from '../../../../domain/entities/CombinationReview'
import { reviewStyles as s } from './CombinationReview.styles'

/** 긴 파일 이름은 가운데를 줄여 확장자까지 보이게 합니다. */
function shortFileName(name: string): string {
  const characters = [...name]
  return characters.length > 32 ? `${characters.slice(0, 16).join('')}…${characters.slice(-12).join('')}` : name
}

/**
 * 근거 원문 하나입니다. 저장된 인용문을 shared 규칙으로 정리해, 중복 · 제한 낱말이 든 줄과 앞뒤 한 줄만 먼저 보여 줍니다.
 * 인용이 줄 중간에서 잘렸으면 생략 표시와 [이 부분 전체 보기](원문 조각 전체)를, 온전한 줄 단위 인용인데 조각에 앞뒤 줄이 더 있으면
 * [앞뒤 원문 보기](조각 전체, 인용한 줄은 표시)를, 그 밖에는 접힌 줄이 있을 때 [전체 n줄 보기]를 둡니다.
 * [원문 그대로]는 저장된 인용을 줄바꿈까지 그대로 보여 줍니다. alsoIn은 같은 인용을 고른 다른 단계 · 질문 안내("수행 단계에도 인용")입니다.
 */
export function EvidenceQuote({ id, number, run, citation, alsoIn = null, download, downloading }: {
  id: string; number: number; run: ReviewRun; citation: ReviewCitation; alsoIn?: string | null; download: (index: number) => void; downloading: boolean
}) {
  const [view, setView] = useState<'preview' | 'full' | 'raw'>('preview')
  const block = run.evidence?.blocks.find((b) => b.id === citation.evidenceId)
  const documentIndex = run.evidence?.documents.findIndex((d) => d.rawHash === block?.documentHash && d.programIndex === block?.programIndex) ?? -1
  const document = documentIndex >= 0 ? run.evidence!.documents[documentIndex] : undefined
  const format = evidenceFormatOf(block?.locator ?? '', document)
  const locator = block ? evidenceLocatorLabel(block.locator) : ''
  const lines = formatEvidenceText(citation.quote, format)
  const preview = evidencePreview(lines)
  const cut = block ? evidenceQuoteCut(block.text, citation.quote) : { start: false, end: false }
  const cutAny = cut.start || cut.end
  // 잘리지 않은 줄 단위 인용도 원문 조각에 앞뒤 줄이 더 있으면 조각 전체를 펼쳐 볼 수 있습니다.
  const hasContext = !cutAny && block !== undefined && evidenceHasContext(block.text, citation.quote)
  const showsBlock = cutAny || hasContext
  const canExpand = showsBlock || preview.some((entry) => entry.type === 'gap')
  const expandLabel = cutAny ? '이 부분 전체 보기 ▾' : hasContext ? '앞뒤 원문 보기 ▾' : `전체 ${lines.length}줄 보기 ▾`
  // 펼친 보기는 원문 조각 전체(앞뒤 원문이면 인용한 줄을 따로 표시) 또는 인용 전체를 정리한 줄입니다.
  const full = view === 'full' && showsBlock && block ? formatEvidenceText(block.text, format) : lines
  const quoted = view === 'full' && hasContext ? evidenceQuoteRange(full, lines) : null
  const fullLines = (from: number, to?: number) => full.slice(from, to).map((line, index) => <EvidenceLineView key={from + index} line={line} />)
  const bodyId = `${id}-text`
  const source = [`사업 ${(block?.programIndex ?? 0) + 1}`, ...(document ? [shortFileName(document.fileName)] : []), ...(locator ? [locator] : [])].join(' · ')
  const tags = [
    ...(isApplicationFormText(citation.quote) ? ['신청서 서식'] : []),
    ...(alsoIn ? [alsoIn] : []),
  ]
  return <li className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <b className="text-brand-primary">근거 {number}</b>
      <span className="min-w-0 text-ink-muted [overflow-wrap:anywhere]" title={document?.fileName}>{source}</span>
    </div>
    {tags.length > 0 && <div className="flex flex-wrap gap-1">{tags.map((tag) => <span key={tag} className={`${s.badge} ${s.badgeNeutral}`}>{tag}</span>)}</div>}
    <blockquote id={bodyId} className="m-0 space-y-0.5 border-l-[3px] border-brand-primary/30 pl-2.5">
      {view === 'raw' ? <p className="text-[0.8125rem] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">{citation.quote}</p> : <>
        {view === 'full' && showsBlock && <p className={s.evidenceNote}>인용 앞뒤를 포함한 {locator || '원문 조각'} 전체예요.</p>}
        {view === 'preview' && cut.start && <p className={s.evidenceNote}>… 앞 내용 생략</p>}
        {view === 'full'
          ? quoted
            ? <>
              {fullLines(0, quoted.start)}
              <div role="group" aria-label="인용한 부분" className={s.evidenceQuoted}>{fullLines(quoted.start, quoted.end)}</div>
              {fullLines(quoted.end)}
            </>
            : fullLines(0)
          : preview.map((entry, index) => entry.type === 'gap'
            ? <p key={index} className={`${s.evidenceNote} pl-6`}>⋯ {entry.count}줄 접힘</p>
            : <EvidenceLineView key={index} line={entry.line} />)}
        {view === 'preview' && cut.end && <p className={s.evidenceNote}>뒤로 이어짐 …</p>}
      </>}
    </blockquote>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {canExpand && view !== 'raw' && <button type="button" className={s.textLink} aria-expanded={view === 'full'} aria-controls={bodyId} onClick={() => setView(view === 'full' ? 'preview' : 'full')}>
        {view === 'full' ? '간단히 보기 ▴' : expandLabel}
      </button>}
      <button type="button" className={s.textLink} aria-pressed={view === 'raw'} aria-controls={bodyId} onClick={() => setView(view === 'raw' ? 'preview' : 'raw')}>원문 그대로</button>
      <span className="ml-auto flex flex-wrap gap-4">
        {document?.sourcePageUrl && <a className={s.textLink} href={document.sourcePageUrl} target="_blank" rel="noreferrer">공고 페이지 보기 ↗</a>}
        {documentIndex >= 0 && <button type="button" className={s.textLink} disabled={downloading} onClick={() => download(documentIndex)}>원문 받기</button>}
      </span>
    </div>
  </li>
}

/** 정리한 한 줄입니다. 글머리 단계만큼 들여 쓰고, 주석은 작게, 표 묶음은 "표" 표시를 붙입니다. */
function EvidenceLineView({ line }: { line: EvidenceLine }) {
  const indent = line.kind === 'note' || (line.kind === 'item' && line.level === 3) ? 'pl-7' : line.kind === 'item' && line.level === 2 ? 'pl-3.5' : ''
  // 관련 줄로 판정된 줄만 강조합니다(동의서 이용 목적이나 표 칸의 같은 낱말은 칠하지 않습니다).
  const text = line.related
    ? splitEvidenceKeywords(line.text).map((part, index) => part.keyword ? <mark key={index} className={s.evidenceMark}>{part.text}</mark> : part.text)
    : line.text
  if (line.kind === 'heading') return <p className="text-[0.8125rem] leading-6 font-bold [overflow-wrap:anywhere]">{text}</p>
  return <p className={`grid grid-cols-[1.25rem_minmax(0,1fr)] gap-1 leading-6 ${line.kind === 'note' ? 'text-xs text-ink-muted' : 'text-[0.8125rem]'} ${indent}`}>
    {line.kind === 'table'
      ? <span className="mt-1 h-4 rounded bg-surface-muted text-center text-[0.625rem] leading-4 font-bold text-ink-muted">표</span>
      : <span className="text-center text-ink-muted">{line.marker}</span>}
    <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
  </p>
}
