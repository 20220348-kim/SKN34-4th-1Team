import { useId } from 'react'
import type { ApplicationGoogleFormAnswer, ApplicationGoogleFormQuestion } from '@govbiz/shared/domain/entities/ApplicationGoogleForm'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { useGoogleFormPrefillViewModel } from '../viewmodel/useGoogleFormPrefillViewModel'
import { newPreparationStyles as n } from './ApplicationPreparation.styles'

type ViewModel = ReturnType<typeof useGoogleFormPrefillViewModel>

/**
 * 구글 설문으로 신청하는 공고의 ②입니다. 설문 문항을 이 화면에 그대로 보여 주고, 기업 정보로 채울 수 있는 칸은 먼저 채웁니다.
 * [답변 채워서 구글 설문 열기]는 답을 담은 설문 주소를 새 창으로 열 뿐이고 제출은 사용자가 구글 설문에서 직접 합니다.
 * 로그인해야 열리는 설문처럼 문항을 읽지 못하면 이유와 함께 설문을 그대로 여는 링크만 둡니다.
 */
export function GoogleFormPrefill({ sourceCode, sourceProgramId, formUrl, programTitle }: {
  sourceCode: string; sourceProgramId: string; formUrl: string; programTitle: string
}) {
  const vm = useGoogleFormPrefillViewModel(sourceCode, sourceProgramId)
  const { load } = vm
  return <section className={n.card} aria-labelledby="new-google-form-title">
    <h3 className={n.cardTitle} id="new-google-form-title">구글 설문으로 신청하는 공고예요</h3>
    {load.status === 'loading' && <>
      <p className={n.muted} role="status">구글 설문 문항을 불러오고 있어요.</p>
      <div className="flex flex-col gap-2 py-1" aria-hidden="true"><span className={`${n.skeletonLine} w-2/5`} /><span className={`${n.skeletonLine} w-4/5`} /></div>
    </>}
    {load.status === 'failed' && <>
      <p className={n.muted}>{load.error.message}</p>
      <div className={n.centeredAction}>
        <a className={n.primary} href={formUrl} target="_blank" rel="noreferrer">구글 설문 열기 ↗<span className="sr-only">: {programTitle} (새 창)</span></a>
        {/* 로그인 전용·마감·문항 없음(422)은 다시 불러와도 같아서 일시 장애일 때만 다시 시도를 둡니다. */}
        {!(load.error instanceof ApplicationPreparationError && load.error.status === 422)
          && <button type="button" className={n.ghost} onClick={vm.retry}>문항 다시 불러오기</button>}
      </div>
    </>}
    {load.status === 'ready' && <>
      <p className={n.muted}>
        여기서 답을 적고 열면 구글 설문에 답이 채워진 채로 열려요. 내용을 확인한 뒤 제출은 구글 설문에서 직접 해 주세요.
        {vm.suggested.size > 0 ? ' 기업 정보로 채운 칸도 한 번 확인해 주세요.' : ''}
      </p>
      <ol className={n.formList}>
        {load.form.questions.map((question, index) => <li key={question.entryId ?? `direct-${index}`}>
          <Question vm={vm} question={question} />
        </li>)}
      </ol>
      <div className={n.formFoot}>
        <p className={n.subtle}>
          {vm.filledCount}/{vm.fillableCount}개 문항을 채워서 열어요. 답은 GovBiz에 저장되지 않고 설문 주소에 담겨 열려요.
        </p>
        <a className={n.primary} href={vm.prefillUrl ?? formUrl} target="_blank" rel="noreferrer">
          답변 채워서 구글 설문 열기 ↗<span className="sr-only">: {programTitle} (새 창)</span>
        </a>
      </div>
    </>}
  </section>
}

function Question({ vm, question }: { vm: ViewModel; question: ApplicationGoogleFormQuestion }) {
  const id = useId()
  const entryId = question.entryId
  // 동의 문구처럼 여러 줄인 제목은 첫 줄만 제목으로 두고 나머지는 설명과 함께 안내문으로 보여 줍니다.
  const [title, ...more] = question.label.split('\n')
  const guidance = [more.join('\n').trim(), question.description].filter(Boolean).join('\n\n')
  const head = <>
    <span>{title}</span>
    {question.required && <span className={n.formRequired} aria-label="필수">*</span>}
    {entryId && vm.suggested.has(entryId) && <span className={n.formBadge}>기업 정보</span>}
  </>
  const help = guidance ? <p className={`${n.formHelp} whitespace-pre-line`} id={`${id}-help`}>{guidance}</p> : null
  const describedBy = guidance ? `${id}-help` : undefined
  if (!entryId || question.kind === 'UNSUPPORTED') {
    return <div className={n.formQuestion}>
      <p className={`${n.formLabel} m-0`}>{head}</p>
      {help}
      <p className={n.formDirect}>날짜·파일 첨부처럼 미리 채울 수 없는 문항이에요. 구글 설문에서 직접 답해 주세요.</p>
    </div>
  }
  const answer: ApplicationGoogleFormAnswer = vm.answers[entryId] ?? { values: [], other: null }
  if (question.kind === 'SHORT_TEXT' || question.kind === 'LONG_TEXT') {
    const value = answer.values[0] ?? ''
    return <div className={n.formQuestion}>
      <label className={n.formLabel} htmlFor={id}>{head}</label>
      {help}
      {question.kind === 'SHORT_TEXT'
        ? <input id={id} className={n.formInput} value={value} aria-describedby={describedBy} onChange={(event) => vm.setText(entryId, event.target.value)} />
        : <textarea id={id} className={n.formTextarea} value={value} aria-describedby={describedBy} onChange={(event) => vm.setText(entryId, event.target.value)} />}
    </div>
  }
  if (question.kind === 'DROPDOWN') {
    return <div className={n.formQuestion}>
      <label className={n.formLabel} htmlFor={id}>{head}</label>
      {help}
      <select id={id} className={n.select} value={answer.values[0] ?? ''} aria-describedby={describedBy}
        onChange={(event) => vm.choose(entryId, event.target.value)}>
        <option value="">고르지 않음</option>
        {question.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>
  }
  const single = question.kind === 'SINGLE_CHOICE'
  return <fieldset className={n.formQuestion} aria-describedby={describedBy}>
    <legend className={n.formLabel}>{head}</legend>
    {help}
    <div className={n.formOptions}>
      {question.options.map((option) => <label key={option} className={n.formOption}>
        <input className={n.formCheck} type={single ? 'radio' : 'checkbox'} name={id} checked={answer.values.includes(option)}
          onChange={() => single ? vm.choose(entryId, option) : vm.toggle(entryId, option)} />
        <span className="whitespace-pre-wrap">{option}</span>
      </label>)}
      {question.allowsOther && <div className="flex flex-wrap items-center gap-2">
        <label className={n.formOption}>
          <input className={n.formCheck} type={single ? 'radio' : 'checkbox'} name={id} checked={answer.other !== null}
            onChange={() => single || answer.other === null ? vm.chooseOther(entryId, single, answer.other ?? '') : vm.clearOther(entryId)} />
          <span>기타</span>
        </label>
        <input className={`${n.formInput} max-w-[320px] flex-1`} aria-label={`${question.label} 기타 답변`} value={answer.other ?? ''}
          onChange={(event) => vm.chooseOther(entryId, single, event.target.value)} />
      </div>}
    </div>
  </fieldset>
}
