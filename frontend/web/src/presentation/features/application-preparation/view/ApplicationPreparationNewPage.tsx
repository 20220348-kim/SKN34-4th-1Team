import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useAppSelector } from '../../../../app/hooks'
import { applicationServiceFieldLabels, type ApplicationFormDiscoveryJob } from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { useApplicationPreparationNewViewModel, type SelectableSupportProgram } from '../viewmodel/useApplicationPreparationNewViewModel'
import { newPreparationStyles as n } from './ApplicationPreparation.styles'
import { ProgramBadges, ProgramPickerPanel } from './ProgramPickerPanel'

type NewViewModel = ReturnType<typeof useApplicationPreparationNewViewModel>

const steps = ['공고 선택', '신청 문서 확인'] as const
const jobStatusLabels: Partial<Record<ApplicationFormDiscoveryJob['status'], string>> = {
  QUEUED: '대기 중', RUNNING: '분석 중', UNKNOWN: '결과 확인 필요',
}

function readableTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function elapsedLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}분 ${seconds % 60}초 지남` : `${seconds}초 지남`
}

/** 새 문서(24) 화면입니다. 주소의 `sourceCode`·`sourceProgramId`가 있으면 그 공고를 미리 고릅니다. */
export function ApplicationPreparationNewPage() {
  const account = useAppSelector(selectCurrentAccount)
  const [searchParams, setSearchParams] = useSearchParams()
  if (!account) return null
  const requestedSourceCode = searchParams.get('sourceCode') ?? ''
  const addressSourceCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(requestedSourceCode) ? requestedSourceCode : ''
  const addressProgramId = addressSourceCode ? (searchParams.get('sourceProgramId') ?? '').trim() : ''
  // 고른 공고를 주소에 적어 두면 새로고침·뒤로 가기·같은 주소로 돌아왔을 때 그 공고와 진행 중인 분석을 이어서 봅니다.
  return <NewPreparation
    key={account.email}
    addressSourceCode={addressSourceCode}
    addressProgramId={addressProgramId}
    onProgramChosen={(program) => setSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.id }, { replace: true })}
  />
}

function StepIndicator({ index }: { index: number }) {
  return <>
    <ol className={n.stepper} aria-label="새 문서 단계">
      {steps.map((label, position) => {
        const current = position === index
        const done = position < index
        return <li key={label} className={current ? n.stepCurrent : done ? n.stepDone : n.step} aria-current={current ? 'step' : undefined}>
          <span className={n.stepNo}>{position + 1}단계{done ? ' · 완료' : current ? ' · 진행 중' : ''}</span>
          <b className={n.stepLabel}>{label}</b>
        </li>
      })}
    </ol>
    <div className={n.stepperM} aria-hidden="true">
      <p className={n.stepperMLabel}>{steps[index]}<span>{index + 1} / {steps.length}</span></p>
      <div className={n.stepperMBar}><span className={n.stepperMFill} style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
    </div>
  </>
}

function SourceLink({ href, title }: { href: string; title: string }) {
  return <a className={n.sourceLink} href={href} target="_blank" rel="noreferrer">원문 보기 ↗<span className="sr-only">: {title} (새 창)</span></a>
}

function DangerAlert({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return <div className={`${n.alert} ${n.alertDanger}`} role="alert">
    <div className={n.alertText}><strong className={n.alertTitle}>{title}</strong><p>{message}</p></div>
    {onRetry && <button type="button" className={n.secondarySm} onClick={onRetry}>다시 시도</button>}
  </div>
}

/** 1단계 카드 안의 저장된 양식 조회 결과입니다. */
function AvailabilityResult({ vm }: { vm: NewViewModel }) {
  const lookup = vm.availability
  if (!lookup) return null
  if (lookup.status === 'loading') return <>
    <p className="sr-only" role="status">저장된 신청 양식을 확인하고 있어요.</p>
    <div className="flex flex-col gap-2 py-1" aria-hidden="true"><span className={`${n.skeletonLine} w-4/5`} /><span className={`${n.skeletonLine} w-3/5`} /></div>
  </>
  if (lookup.status === 'failed') return <DangerAlert title="저장된 신청 양식을 확인하지 못했어요" message={lookup.error.message} onRetry={vm.retryAvailability} />
  return vm.forms.length > 0
    ? <div className={`${n.alert} ${n.alertBrand}`} role="status">
      <div className={n.alertText}>
        <strong className={n.alertTitle}>작성할 수 있는 신청 양식 {vm.forms.length}개를 찾았어요</strong>
        <p>{vm.forms.map((form) => form.formTitle).join(' · ')} — 다음 단계에서 고를 수 있어요.</p>
      </div>
    </div>
    : <div className={`${n.alert} ${n.alertNeutral}`} role="status">
      <div className={n.alertText}>
        <strong className={n.alertTitle}>저장된 신청 양식이 없어요</strong>
        <p>다음 단계에서 입력칸별로 분석할 수 있어요.</p>
      </div>
    </div>
}

function ProgramStep({ vm, openPicker, pickButtonRef, changeButtonRef }: {
  vm: NewViewModel
  openPicker: () => void
  pickButtonRef: RefObject<HTMLButtonElement | null>
  changeButtonRef: RefObject<HTMLButtonElement | null>
}) {
  const program = vm.program
  const pickButton = <div className={n.empty}>
    <p className={n.muted}>신청 문서를 만들 공고를 골라 주세요</p>
    <button ref={pickButtonRef} type="button" className={n.secondary} aria-haspopup="dialog" onClick={openPicker}>공고 고르기</button>
  </div>
  return <>
    {vm.activeJobs.length > 0 && <ActiveJobsAlert jobs={vm.activeJobs} />}
    <section className={n.card} aria-labelledby="new-program-title">
      <h2 className={n.cardTitle} id="new-program-title">지원 공고</h2>
      {vm.programLoad.status === 'loading' && !program
        ? <>
          <p className="sr-only" role="status">공고를 불러오는 중입니다.</p>
          <div className="flex flex-col gap-2.5 py-1" aria-hidden="true">
            <span className={`${n.skeletonLine} w-2/5`} /><span className={`${n.skeletonLine} h-5 w-4/5`} /><span className={`${n.skeletonLine} w-3/5`} />
          </div>
        </>
        : program
          ? <>
            <ProgramBadges program={program} withSource />
            <strong className={n.programTitle}>{program.title}</strong>
            <span className={n.programMeta}>{[program.organization, program.applicationPeriod && `접수 ${program.applicationPeriod}`].filter(Boolean).join(' · ')}</span>
            <AvailabilityResult vm={vm} />
            <div className={n.cardFoot}>
              <SourceLink href={program.sourceUrl} title={program.title} />
              <button ref={changeButtonRef} type="button" className={n.secondarySm} aria-haspopup="dialog" disabled={vm.submitting} onClick={openPicker}>공고 바꾸기</button>
            </div>
          </>
          : <>
            {vm.programLoad.status === 'failed' && <DangerAlert title="공고를 불러오지 못했어요" message={vm.programLoad.error.message} onRetry={vm.retryProgramLoad} />}
            {pickButton}
          </>}
    </section>
    <p className={n.subtle}>작성을 시작하기 전까지는 AI를 부르지 않아요. 양식이 없는 공고는 원문에서 직접 작성해 주세요.</p>
  </>
}

function CapacityAlert({ jobs, onRetry }: { jobs: ApplicationFormDiscoveryJob[]; onRetry: () => void }) {
  return <div className={`${n.alert} ${n.alertWarning}`} role="alert">
    <div className={n.alertText}>
      <strong className={n.alertTitle}>진행 중이거나 확인이 필요한 분석이 3건입니다</strong>
      <p>아래 분석이 끝나거나 풀리면 다시 시도해 주세요.</p>
      {jobs.length > 0 && <ul className={n.jobList} aria-label="진행 중인 분석">
        {jobs.map((job) => <li className={n.jobItem} key={job.id}>
          <span className={n.jobTitle}>{job.programTitle}</span>
          <span className={n.jobMeta}>{jobStatusLabels[job.status] ?? job.status} · {readableTime(job.createdAt)}</span>
          {job.status === 'UNKNOWN' && <span className={n.jobMeta}>최대 30분 뒤 자동으로 풀립니다</span>}
        </li>)}
      </ul>}
    </div>
    <button type="button" className={n.secondarySm} onClick={onRetry}>다시 시도</button>
  </div>
}

function FormStep({ vm }: { vm: NewViewModel }) {
  const program = vm.program
  const form = vm.selectedForm
  const discoveryError = vm.discoveryError
  const officialOnly = discoveryError instanceof ApplicationPreparationError
    && ['APPLICATION_FORM_NO_FORM', 'APPLICATION_FORM_SOURCE_UNSUPPORTED'].includes(discoveryError.code)
  return <>
    {vm.discovery
      ? <section className={n.progress} role="status" aria-live="polite" aria-label="양식 분석 진행">
        <div className={n.progressHead}>
          <span className={n.spinner} aria-hidden="true" />
          <strong className={n.progressTitle}>{vm.discovery.reanalysis ? '입력칸별로 다시 분석하고 있어요' : '공식 첨부에서 신청 양식을 분석하고 있어요'}</strong>
          <span className={n.progressTime}>{elapsedLabel(vm.elapsedSeconds)}</span>
        </div>
        {vm.discovery.resumed && <p className={n.muted}>이전에 시작한 분석을 이어서 보여 드려요.</p>}
        <p className={n.progressNote}>화면을 나가도 계속돼요. 끝나면 알려 드려요.</p>
      </section>
      : form
        ? <>
          <section className={n.card} aria-labelledby="new-form-title">
            <h2 className={n.cardTitle} id="new-form-title">작성할 양식</h2>
            {vm.forms.length >= 2
              ? <div className={n.choiceList} role="radiogroup" aria-labelledby="new-form-title">
                {vm.forms.map((candidate) => <label className={n.choice} key={candidate.formVersionId}>
                  <input className={n.radio} type="radio" name="application-form" disabled={vm.submitting}
                    checked={candidate.formVersionId === vm.selectedFormVersionId} onChange={() => vm.selectForm(candidate.formVersionId)} />
                  <span className={n.choiceText}>{candidate.formTitle}<span>{candidate.attachmentFileName}</span></span>
                </label>)}
              </div>
              : <p className={n.choiceText}>{form.formTitle}<span>{form.attachmentFileName}</span></p>}
          </section>

          {!(form.supportedServiceFields.length === 1 && form.supportedServiceFields[0] === 'GENERAL') && <section className={n.card} aria-labelledby="new-field-title">
            <h2 className={n.cardTitle} id="new-field-title">작성할 지원 분야</h2>
            <div className={n.choiceList} role="radiogroup" aria-labelledby="new-field-title">
              {form.supportedServiceFields.map((field) => <label className={n.choice} key={field}>
                <input className={n.radio} type="radio" name="application-service-field" disabled={vm.submitting}
                  checked={vm.serviceField === field} onChange={() => vm.setServiceField(field)} />
                <span className={n.choiceText}>{applicationServiceFieldLabels[field]}</span>
              </label>)}
            </div>
          </section>}

          <section className={n.summary} aria-label="공고 및 양식 요약">
            <div className={n.summaryHead}>
              <p className={n.summaryText}><strong>{form.programTitle}</strong>{form.formTitle} · {form.attachmentFileName}</p>
              <SourceLink href={form.sourceUrl} title={form.programTitle} />
            </div>
            <p className={n.muted}>{form.verificationStatus === 'SOURCE_DOCUMENT_EXTRACTED'
              ? '공식 첨부에서 AI가 뽑은 문항이에요. 원문과 대조해 주세요.'
              : '공식 첨부와 작성 문항을 확인한 양식이에요.'} 기관 검수나 선정 가능성을 뜻하지 않으며, 작성 시작은 AI를 부르지 않아요.</p>
            {vm.discoveryWarnings.length > 0 && <ul className={n.warningList}>{vm.discoveryWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          </section>
          <button type="button" className={n.textLink} disabled={vm.submitting} onClick={vm.discoverForms}>입력칸별로 다시 분석</button>
        </>
        : <section className={n.card} aria-labelledby="new-no-form-title">
          <h2 className={n.cardTitle} id="new-no-form-title">저장된 양식이 없어요</h2>
          {vm.noFormReason && <p className={n.muted}>{vm.noFormReason}</p>}
          <div className={n.centeredAction}>
            <button type="button" className={n.secondary} disabled={vm.submitting} onClick={vm.discoverForms}>입력칸별로 분석</button>
            <p className={n.muted}>AI가 공식 첨부를 읽어 문항을 뽑아요 · 계정당 동시에 3건까지</p>
            {program && <SourceLink href={program.sourceUrl} title={program.title} />}
          </div>
        </section>}

    {vm.capacityJobs && <CapacityAlert jobs={vm.capacityJobs} onRetry={vm.discoverForms} />}
    {discoveryError && <div className={`${n.alert} ${n.alertDanger}`} role="alert">
      <div className={n.alertText}><strong className={n.alertTitle}>양식을 분석하지 못했어요</strong><p>{discoveryError.message}</p></div>
      {officialOnly && program && <SourceLink href={program.sourceUrl} title={program.title} />}
    </div>}
    {vm.createError && <DangerAlert title="작성을 시작하지 못했어요" message={vm.createError.message} />}
    {vm.submitting && <p className="sr-only" role="status">신청 문서를 만들고 있어요.</p>}
  </>
}

function newPathFor(program: { sourceCode: string; sourceProgramId: string }) {
  return `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
}

/** 공고 없이 들어왔을 때 계정에서 진행 중인 분석입니다. [이어서 보기]는 그 공고 주소로 가서 진행 카드를 이어받습니다. */
function ActiveJobsAlert({ jobs }: { jobs: ApplicationFormDiscoveryJob[] }) {
  return <div className={`${n.alert} ${n.alertInfo}`} role="status">
    <div className={n.alertText}>
      <strong className={n.alertTitle}>분석 중인 공고가 있어요</strong>
      <p>화면을 나가도 분석은 계속돼요. 이어서 보려면 공고를 골라 주세요.</p>
      <ul className={n.jobList} aria-label="분석 중인 공고">
        {jobs.map((job) => <li className={n.jobItem} key={job.id}>
          <span className={n.jobTitle}>{job.programTitle}</span>
          <span className={n.jobMeta}>{jobStatusLabels[job.status] ?? job.status} · {readableTime(job.createdAt)} 시작</span>
          <Link className={n.secondarySm} to={newPathFor(job)}>이어서 보기<span className="sr-only">: {job.programTitle}</span></Link>
        </li>)}
      </ul>
    </div>
  </div>
}

function NewPreparation({ addressSourceCode, addressProgramId, onProgramChosen }: {
  addressSourceCode: string
  addressProgramId: string
  onProgramChosen: (program: SelectableSupportProgram) => void
}) {
  const vm = useApplicationPreparationNewViewModel(addressSourceCode, addressProgramId)
  // "지금 공고"는 처음 주소로 들어온 공고입니다. 패널에서 고른 공고로 주소가 바뀌어도 그대로 둡니다.
  const [entryProgramKey] = useState(() => addressSourceCode && addressProgramId ? `${addressSourceCode}:${addressProgramId}` : '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickButtonRef = useRef<HTMLButtonElement>(null)
  const changeButtonRef = useRef<HTMLButtonElement>(null)
  const pickerWasOpen = useRef(false)
  const stepBodyRef = useRef<HTMLDivElement>(null)
  const renderedStep = useRef(vm.step)
  const stepIndex = vm.step === 'PROGRAM' ? 0 : 1

  // 패널이 닫히면 연 버튼으로 포커스를 돌려줍니다. 공고를 처음 고른 경우 [공고 고르기] 대신 [공고 바꾸기]가 그 자리입니다.
  useEffect(() => {
    if (pickerWasOpen.current && !pickerOpen) (changeButtonRef.current ?? pickButtonRef.current)?.focus()
    pickerWasOpen.current = pickerOpen
  }, [pickerOpen])

  // 단계가 바뀌면 새 단계 내용의 처음으로 포커스를 옮깁니다(첫 화면에서는 옮기지 않음).
  useLayoutEffect(() => {
    if (renderedStep.current === vm.step) return
    renderedStep.current = vm.step
    stepBodyRef.current?.focus()
  }, [vm.step])

  return <>
    <WorkspacePageHeader parent={{ to: appPaths.applicationPreparations, label: '신청 문서 작성' }} title="새 문서" />
    <main className={workspacePageStyles.content}>
      <div className={n.body}>
        <p className={n.sub}>공고를 고르면 저장된 신청 양식이 있는지 바로 확인해요</p>
        <StepIndicator index={stepIndex} />
        <div className={n.actions} role="group" aria-label="단계 이동">
          {vm.step === 'PROGRAM'
            ? <>
              <Link className={n.ghost} to={appPaths.applicationPreparations}>취소</Link>
              <button type="button" className={n.primary} disabled={!vm.canProceed} onClick={vm.goToFormStep}>다음<span aria-hidden="true">→</span></button>
            </>
            : <>
              <button type="button" className={n.secondary} disabled={vm.submitting} onClick={vm.backToProgramStep}>이전</button>
              <button type="button" className={n.primary} disabled={!vm.selectedForm || vm.discovery !== null || vm.submitting}
                onClick={() => { void vm.create() }}>{vm.submitting ? '만드는 중…' : '작성 시작'}</button>
            </>}
        </div>
        <div ref={stepBodyRef} className={n.stepBody} tabIndex={-1} role="group" aria-label={`${stepIndex + 1}단계 ${steps[stepIndex]}`}>
          {vm.step === 'PROGRAM'
            ? <ProgramStep vm={vm} openPicker={() => setPickerOpen(true)} pickButtonRef={pickButtonRef} changeButtonRef={changeButtonRef} />
            : <FormStep vm={vm} />}
        </div>
      </div>
    </main>
    {pickerOpen && <ProgramPickerPanel
      current={vm.program}
      currentAvailability={vm.availability}
      urlProgramKey={entryProgramKey}
      onConfirm={(program, availability) => { vm.choose(program, availability); onProgramChosen(program); setPickerOpen(false) }}
      onClose={() => setPickerOpen(false)}
    />}
    <WorkspaceToast notice={vm.toast} onClose={vm.dismissToast} />
  </>
}
