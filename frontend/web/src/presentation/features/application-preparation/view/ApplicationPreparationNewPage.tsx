import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useAppSelector } from '../../../../app/hooks'
import { applicationServiceFieldLabels, type ApplicationFormDiscoveryJob } from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { SelectField } from '../../../shared/workspace/SelectField'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { useDelayedFlag } from '../../../shared/workspace/useDelayedFlag'
import { useApplicationPreparationNewViewModel, type SelectableSupportProgram } from '../viewmodel/useApplicationPreparationNewViewModel'
import { applicationPreparationStyles as s, newPreparationStyles as n } from './ApplicationPreparation.styles'
import { ButtonSpinner } from './ApplicationPreparationSkeletons'
import { GoogleFormPrefill } from './GoogleFormPrefill'
import { ProgramBadges, ProgramPickerPanel } from './ProgramPickerPanel'

type NewViewModel = ReturnType<typeof useApplicationPreparationNewViewModel>

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

/** 새 문서(24) 화면입니다. 주소의 `sourceCode`·`sourceProgramId`가 있으면 그 공고를 미리 고르고 ②를 연 채 시작합니다. */
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

function SearchIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" />
  </svg>
}

/** 유료 AI 분석 버튼에 붙는 반짝임 아이콘입니다. */
function AiIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 3.5 12.8 9 18.5 11l-5.7 2L11 18.5 9.2 13 3.5 11 9.2 9zM18.5 3v4M16.5 5h4" />
  </svg>
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

/** 번호 붙은 섹션 제목입니다. `off`는 아직 열리지 않은 섹션으로, 흐린 제목과 언제 열리는지를 보여 줍니다. */
function SectionHeading({ id, number, title, off = false, hint, headingRef }: {
  id: string
  number: number
  title: string
  off?: boolean
  hint?: ReactNode
  headingRef?: RefObject<HTMLHeadingElement | null>
}) {
  return <h2 ref={headingRef} id={id} className={off ? n.sectionTitleOff : n.sectionTitle} tabIndex={headingRef ? -1 : undefined}>
    <span className={off ? n.sectionNumberOff : n.sectionNumber} aria-hidden="true">{number}</span>{title}
    {hint && <small className={n.sectionHint}>{hint}</small>}
  </h2>
}

/** ① 카드 안의 저장된 양식 조회 결과입니다. 조회 중 · 실패는 ②에서 보여 줍니다. */
function AvailabilitySummary({ vm }: { vm: NewViewModel }) {
  if (vm.availability?.status !== 'ready') return null
  return vm.forms.length > 0
    ? <div className={`${n.alert} ${n.alertBrand}`} role="status">
      <div className={n.alertText}>
        <strong className={n.alertTitle}>작성할 수 있는 신청 양식 {vm.forms.length}개를 찾았어요</strong>
        <p>{vm.forms.length >= 2 ? '아래 ②에서 작성할 양식을 골라 주세요.' : '아래 ②에서 양식을 확인하고 작성을 시작해 주세요.'}</p>
      </div>
    </div>
    : <div className={`${n.alert} ${n.alertNeutral}`} role="status">
      <div className={n.alertText}>
        <strong className={n.alertTitle}>저장된 신청 양식이 없어요</strong>
        <p>아래 ②에서 입력칸별로 분석할 수 있어요.</p>
      </div>
    </div>
}

/** ① 공고. 고르기 전에는 [공고 고르기] 하나만 크게 두고, 고른 뒤에는 공고 요약 카드입니다. */
function ProgramSection({ vm, openPicker, pickButtonRef, changeButtonRef }: {
  vm: NewViewModel
  openPicker: () => void
  pickButtonRef: RefObject<HTMLButtonElement | null>
  changeButtonRef: RefObject<HTMLButtonElement | null>
}) {
  const program = vm.program
  const loading = vm.programLoad.status === 'loading' && !program
  // 300ms 안에 끝나면 막대를 보이지 않습니다. 자리는 미리 잡아 두어 카드 높이가 흔들리지 않습니다.
  const showSkeleton = useDelayedFlag(loading)
  return <section className={n.section} aria-labelledby="new-program-heading">
    <SectionHeading id="new-program-heading" number={1} title="공고" />
    <div className={n.card}>
      {loading
        ? <>
          <p className="sr-only" role="status">공고를 불러오는 중입니다.</p>
          <div className={`flex flex-col gap-2.5 py-1 ${showSkeleton ? '' : 'invisible'}`} aria-hidden="true">
            <span className={`${n.skeletonLine} w-2/5`} /><span className={`${n.skeletonLine} h-5 w-4/5`} /><span className={`${n.skeletonLine} w-3/5`} />
          </div>
        </>
        : program
          ? <>
            <ProgramBadges program={program} withSource />
            <strong className={n.programTitle}>{program.title}</strong>
            <span className={n.programMeta}>{[program.organization, program.applicationPeriod && `접수 ${program.applicationPeriod}`].filter(Boolean).join(' · ')}</span>
            <AvailabilitySummary vm={vm} />
            <div className={n.cardFoot}>
              <SourceLink href={program.sourceUrl} title={program.title} />
              <button ref={changeButtonRef} type="button" className={n.secondarySm} aria-haspopup="dialog" disabled={vm.submitting} onClick={openPicker}>공고 바꾸기</button>
            </div>
          </>
          : <>
            {vm.programLoad.status === 'failed' && <DangerAlert title="공고를 불러오지 못했어요" message={vm.programLoad.error.message} onRetry={vm.retryProgramLoad} />}
            <div className={n.empty}>
              <span className={n.emptyIcon} aria-hidden="true"><SearchIcon size={20} /></span>
              <p className={n.emptyTitle}>신청 문서를 만들 공고를 골라 주세요</p>
              <p className={n.muted}>관심 공고함이나 전체 검색에서 한 건을 고르면, 저장된 신청 양식이 있는지 바로 확인해요.</p>
              <button ref={pickButtonRef} type="button" className={n.primaryLg} aria-haspopup="dialog" onClick={openPicker}><SearchIcon />공고 고르기</button>
              <p className={n.subtle}>작성을 시작하기 전까지는 AI를 부르지 않아요.</p>
            </div>
          </>}
    </div>
  </section>
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

/** ②의 양식 카드입니다. 양식이 2개 이상이면 라디오 카드로 고르고, 신청 분야가 "일반 신청" 하나뿐이면 분야 칸을 두지 않습니다. */
function FormChoice({ vm }: { vm: NewViewModel }) {
  const fieldId = useId()
  const form = vm.selectedForm!
  const generalOnly = form.supportedServiceFields.length === 1 && form.supportedServiceFields[0] === 'GENERAL'
  return <section className={n.card} aria-labelledby="new-form-title">
    <h3 className={n.cardTitle} id="new-form-title">작성할 양식</h3>
    {vm.forms.length >= 2
      ? <div className={n.choiceList} role="radiogroup" aria-labelledby="new-form-title">
        {vm.forms.map((candidate) => <label className={n.choice} key={candidate.formVersionId}>
          <input className={n.radio} type="radio" name="application-form" disabled={vm.submitting}
            checked={candidate.formVersionId === vm.selectedFormVersionId} onChange={() => vm.selectForm(candidate.formVersionId)} />
          <span className={n.choiceText}>{candidate.formTitle}<span>{candidate.attachmentFileName}</span></span>
        </label>)}
      </div>
      : <p className={`m-0 ${n.choiceText}`}>{form.formTitle}<span>{form.attachmentFileName}</span></p>}

    {!generalOnly && <div className={n.field}>
      <label className={n.fieldLabel} htmlFor={fieldId}>신청 분야</label>
      <SelectField id={fieldId} label="신청 분야" className={n.select} value={vm.serviceField} disabled={vm.submitting}
        options={form.supportedServiceFields.map((field) => ({ value: field, label: applicationServiceFieldLabels[field] }))}
        onChange={(value) => vm.setServiceField(value as typeof vm.serviceField)} />
    </div>}

    {/* 공고명 · 원문 링크는 ①에 있으므로 여기에는 면책 문구와 재분석만 둡니다. */}
    <section className={n.summary} aria-label="양식 안내">
      <p className={n.muted}>{form.verificationStatus === 'SOURCE_DOCUMENT_EXTRACTED'
        ? '공식 첨부에서 AI가 뽑은 문항이에요. 원문과 대조해 주세요.'
        : '공식 첨부와 작성 문항을 확인한 양식이에요.'} 기관 검수나 선정 가능성을 뜻하지 않으며, 작성 시작은 AI를 부르지 않아요.</p>
      {vm.discoveryWarnings.length > 0 && <ul className={n.warningList}>{vm.discoveryWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      <p className={n.reanalysis}>
        양식이 원문과 달라 보이면
        <button type="button" className={n.secondarySm} disabled={vm.submitting || vm.analysisBlocked} onClick={vm.discoverForms}><AiIcon />입력칸별로 다시 분석</button>
        <span className={n.cost}>유료 AI · 계정당 동시에 3건</span>
      </p>
    </section>
  </section>
}

/**
 * 이 공고에서 가장 최근에 한 분석이 결과 확인 중이거나 실패했을 때의 안내입니다. 목록의 분석 카드나 [이어서 보기]로 들어와도
 * 무슨 일이 있었는지 여기서 알 수 있습니다. 결과 확인 중에는 다시 분석할 수 없으므로 [다시 확인]만 두고, 실패는 아래 카드에서 다시 분석합니다.
 */
function LastAnalysisNotice({ vm }: { vm: NewViewModel }) {
  const last = vm.lastAnalysis
  if (!last) return null
  const started = readableTime(last.startedAt)
  if (last.kind === 'unknown') return <div className={`${n.alert} ${n.alertWarning}`} role="status" aria-label="지난 분석 상태">
    <div className={n.alertText}>
      <strong className={n.alertTitle}>분석 결과를 확인하고 있어요</strong>
      <p>{started}에 시작한 분석이 끝났는지 확인하지 못했어요. 결과가 확인되면 양식이 여기에 나타나고, 늦어도 30분 안에 정리돼요. 그동안에는 이 공고를 다시 분석할 수 없어요.</p>
    </div>
    <button type="button" className={n.secondarySm} onClick={vm.retryAvailability}>다시 확인</button>
  </div>
  // 작성할 양식을 얻지 못한 분석은 실제로 양식이 없는 공고일 수 있어 실패(빨강)로 알리지 않고 원문을 참고하게 합니다.
  if (last.kind === 'source') return <div className={`${n.alert} ${n.alertNeutral}`} role="status" aria-label="지난 분석 상태">
    <div className={n.alertText}>
      <strong className={n.alertTitle}>원문을 참고해 주세요</strong>
      <p>{started}에 분석했어요 · {last.reason} {vm.forms.length > 0 ? '저장된 양식은 그대로 쓸 수 있어요.' : '공고 원문에서 신청 방법을 확인해 주세요.'}</p>
    </div>
  </div>
  return <div className={`${n.alert} ${n.alertDanger}`} role="status" aria-label="지난 분석 상태">
    <div className={n.alertText}>
      <strong className={n.alertTitle}>지난 분석이 실패했어요</strong>
      <p>{started}에 시작한 분석 · {last.reason} {vm.forms.length > 0 ? '저장된 양식은 그대로 쓸 수 있어요.' : '아래에서 다시 분석할 수 있어요.'}</p>
    </div>
  </div>
}

/** ② 양식 · 분야의 내용입니다. 구글 설문 미리 채우기 · 저장된 양식 조회 중 · 실패 · 분석 진행 · 양식 카드 · 양식 없음 중 하나를 보여 줍니다. */
function FormSectionBody({ vm }: { vm: NewViewModel }) {
  const program = vm.program
  const lookup = vm.availability
  const discoveryError = vm.discoveryError
  const officialOnly = discoveryError instanceof ApplicationPreparationError
    && ['APPLICATION_FORM_NO_FORM', 'APPLICATION_FORM_SOURCE_UNSUPPORTED'].includes(discoveryError.code)
  const lookupLoading = !lookup || lookup.status === 'loading'
  const showSkeleton = useDelayedFlag(lookupLoading)
  if (vm.googleFormUrl && program) return <GoogleFormPrefill sourceCode={program.sourceCode} sourceProgramId={program.id} formUrl={vm.googleFormUrl} programTitle={program.title} />
  if (!lookup || lookup.status === 'loading') return <div className={n.card}>
    <p className="sr-only" role="status">저장된 신청 양식을 확인하고 있어요.</p>
    <div className={`flex flex-col gap-2 py-1 ${showSkeleton ? '' : 'invisible'}`} aria-hidden="true"><span className={`${n.skeletonLine} w-2/5`} /><span className={`${n.skeletonLine} w-4/5`} /><span className={`${n.skeletonLine} w-3/5`} /></div>
  </div>
  if (lookup.status === 'failed') return <DangerAlert title="저장된 신청 양식을 확인하지 못했어요" message={lookup.error.message} onRetry={vm.retryAvailability} />
  return <>
    <LastAnalysisNotice vm={vm} />
    {vm.discovery
      ? <section className={n.progress} role="status" aria-live="polite" aria-label="양식 분석 진행">
        <div className={n.progressHead}>
          <span className={n.spinner} aria-hidden="true" />
          <strong className={n.progressTitle}>{vm.discovery.reanalysis ? '입력칸별로 다시 분석하고 있어요' : '공식 첨부에서 신청 양식을 분석하고 있어요'}</strong>
          <span className={n.progressTime}>{elapsedLabel(vm.elapsedSeconds)}</span>
        </div>
        <p className={n.muted}>{vm.discovery.resumed ? '이전에 시작한 분석을 이어서 보여 드려요. ' : ''}양식 크기에 따라 몇 분 걸릴 수 있어요.</p>
        <p className={n.progressNote}>화면을 나가도 계속돼요. 신청 문서 목록에서 이어서 볼 수 있어요.</p>
      </section>
      : vm.selectedForm
        ? <FormChoice vm={vm} />
        : <section className={n.card} aria-labelledby="new-no-form-title">
          <h3 className={n.cardTitle} id="new-no-form-title">저장된 양식이 없어요</h3>
          {vm.noFormReason && <p className={n.muted}>{vm.noFormReason}</p>}
          <div className={n.centeredAction}>
            <button type="button" className={n.secondary} disabled={vm.submitting || vm.analysisBlocked} onClick={vm.discoverForms}><AiIcon />{vm.lastAnalysis && vm.lastAnalysis.kind !== 'unknown' ? '입력칸별로 다시 분석' : '입력칸별로 분석'}</button>
            <p className={n.muted}>AI가 공식 첨부를 읽어 문항을 뽑아요. 유료 AI 호출이며 계정당 동시에 3건까지 할 수 있어요.</p>
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

/** [작성 시작]을 아직 누를 수 없는 이유입니다. 조회 중에는 ②의 스켈레톤이 알리므로 따로 적지 않습니다. */
function startBlockedReason(vm: NewViewModel): string | null {
  if (vm.googleFormUrl) return '구글 설문에서 직접 신청해요'
  if (vm.selectedForm && !vm.discovery) return null
  if (vm.discovery) return '분석이 끝나면 시작할 수 있어요'
  if (vm.availability?.status === 'failed') return '저장된 양식을 확인하면 시작할 수 있어요'
  if (vm.analysisBlocked) return '분석 결과가 확인되면 시작할 수 있어요'
  if (vm.availability?.status === 'ready') return '양식을 분석하면 시작할 수 있어요'
  return null
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
  const formHeadingRef = useRef<HTMLHeadingElement>(null)
  const pickerWasOpen = useRef(false)
  const pickerConfirmed = useRef(false)
  const reasonId = useId()
  const formOpen = vm.program !== null
  const blockedReason = startBlockedReason(vm)

  // 패널이 닫히면, 공고를 고른 경우 ② 제목으로 포커스를 옮겨 이어서 앞으로 진행하게 하고, 버리고 닫은 경우 연 버튼으로 돌려줍니다.
  useEffect(() => {
    if (pickerWasOpen.current && !pickerOpen) {
      if (pickerConfirmed.current) formHeadingRef.current?.focus()
      else (changeButtonRef.current ?? pickButtonRef.current)?.focus()
      pickerConfirmed.current = false
    }
    pickerWasOpen.current = pickerOpen
  }, [pickerOpen])

  return <>
    <WorkspacePageHeader parent={{ to: appPaths.applicationPreparations, label: '신청 문서 작성' }} title="새 문서" />
    <main className={workspacePageStyles.content}>
      <div className={n.body}>
        <p className={s.lede}>공고를 고르면 저장된 신청 양식이 있는지 바로 확인해요</p>
        {vm.activeJobs.length > 0 && <ActiveJobsAlert jobs={vm.activeJobs} />}
        <ProgramSection vm={vm} openPicker={() => setPickerOpen(true)} pickButtonRef={pickButtonRef} changeButtonRef={changeButtonRef} />
        <section className={n.section} aria-labelledby="new-form-heading">
          <SectionHeading id="new-form-heading" number={2} title="양식 · 분야" off={!formOpen} hint={formOpen ? undefined : '공고를 고르면 열려요'} headingRef={formHeadingRef} />
          {formOpen && <FormSectionBody vm={vm} />}
        </section>
        {/* 동작은 내용 끝 오른쪽에 둡니다. 탭 순서도 내용 → [취소] → [작성 시작]입니다. 공고를 고르기 전에는 그리지 않습니다. */}
        {formOpen && <div className={n.actions}>
          {blockedReason && <p className={n.actionsReason} id={reasonId}>{blockedReason}</p>}
          <Link className={n.ghost} to={appPaths.applicationPreparations}>취소</Link>
          <button type="button" className={n.primary} disabled={!vm.selectedForm || vm.discovery !== null || vm.submitting} aria-busy={vm.submitting}
            aria-describedby={blockedReason ? reasonId : undefined} onClick={() => { void vm.create() }}>{vm.submitting && <ButtonSpinner />}{vm.submitting ? '만드는 중…' : '작성 시작'}</button>
        </div>}
      </div>
    </main>
    {pickerOpen && <ProgramPickerPanel
      current={vm.program}
      currentAvailability={vm.availability}
      urlProgramKey={entryProgramKey}
      onConfirm={(program, availability) => {
        pickerConfirmed.current = true
        vm.choose(program, availability)
        onProgramChosen(program)
        setPickerOpen(false)
      }}
      onClose={() => setPickerOpen(false)}
    />}
    <WorkspaceToast notice={vm.toast} onClose={vm.dismissToast} />
  </>
}
