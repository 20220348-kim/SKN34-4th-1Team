import type { GovAgentProgram } from '@govbiz/shared/domain/entities/GovAgent'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { appPaths } from '../../../shared/routes/appPaths'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { useApplicationPreparationNewViewModel, writableFieldCount } from '../viewmodel/useApplicationPreparationNewViewModel'
import { newPreparationStyles as n } from './ApplicationPreparation.styles'
import { FormSectionBody } from './ApplicationPreparationNewPage'

/**
 * 대화 안에서는 신청 양식의 입력칸 분석까지만 합니다. 저장된 양식을 확인하고, 없으면 분석을 시작해 진행을 보여 주며,
 * 양식을 찾으면 양식·분야 선택과 답변 작성은 신청 문서 화면으로 넘깁니다(대화에서 준비 건을 만들지 않음).
 * [autoAnalyze]는 사용자가 [신청서 쓰기] 칩을 눌러 연 경우입니다. 이때는 저장된 양식이 없으면 입력칸 분석을 바로 시작합니다.
 */
export function ApplicationPreparationInline({ program, autoAnalyze = false, onAutoAnalyzeHandled }: {
  program: GovAgentProgram
  autoAnalyze?: boolean
  onAutoAnalyzeHandled?: () => void
}) {
  const vm = useApplicationPreparationNewViewModel(program.sourceCode, program.sourceProgramId)
  const headingId = useId()
  // 저장된 양식 조회와 이 계정의 지난 분석 확인이 끝난 뒤 한 번만 판단합니다. 아직 분석한 적 없는 공고(또는 원문이 바뀐 공고)이고
  // 진행 중·최근 분석이 없을 때만 유료 분석을 시작합니다. 양식이 있거나 이미 결과(양식 없음·읽을 수 없는 첨부 등)가 나온 공고는 시작하지 않습니다.
  const autoHandled = useRef(false)
  // 안내 문구는 처음 열 때의 방식으로 고정합니다(판단 뒤 대화 화면이 자동 시작 표시를 지워도 문구가 바뀌지 않게).
  const [openedToStart] = useState(autoAnalyze)
  const { availability, discovery, googleFormUrl, lastAnalysis, analysisBlocked, discoverForms } = vm
  useEffect(() => {
    if (!autoAnalyze || autoHandled.current) return
    if (googleFormUrl) { autoHandled.current = true; onAutoAnalyzeHandled?.(); return }
    if (availability?.status === 'failed') { autoHandled.current = true; onAutoAnalyzeHandled?.(); return }
    if (availability?.status !== 'ready') return
    autoHandled.current = true
    const status = availability.result.state.status
    if ((status === 'PENDING' || status === 'STALE') && !discovery && !lastAnalysis && !analysisBlocked) discoverForms()
    onAutoAnalyzeHandled?.()
  }, [analysisBlocked, autoAnalyze, availability, discoverForms, discovery, googleFormUrl, lastAnalysis, onAutoAnalyzeHandled])
  const path = `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
  const formsReady = vm.forms.length > 0 && !vm.discovery && !vm.googleFormUrl
  return <section className="mt-3 flex flex-col gap-4" aria-labelledby={headingId}>
    <h3 className="sr-only" id={headingId}>입력칸 분석 · {program.title}</h3>
    {!formsReady && <p className={n.muted}>{openedToStart
      ? '저장된 양식이 없으면 입력칸 분석(유료 AI)을 바로 시작해요. 분석은 보통 1~2분 걸리고, 양식 선택과 작성은 신청 문서 화면에서 이어서 해요.'
      : '저장된 양식을 확인하고, 없으면 [입력칸별로 분석]으로 분석해요. 양식 선택과 작성은 신청 문서 화면에서 이어서 해요.'}</p>}
    {vm.programLoad.status === 'loading' && <p role="status" className={n.muted}>공고를 불러오는 중입니다.</p>}
    {vm.programLoad.status === 'failed' && <div role="alert" className={`${n.alert} ${n.alertDanger}`}>
      <p>{vm.programLoad.error.message}</p>
      <button type="button" className={n.secondarySm} onClick={vm.retryProgramLoad}>다시 시도</button>
    </div>}
    {vm.program && (formsReady
      ? <div className={n.card} role="status" aria-label="입력칸 분석 결과">
        <h4 className={n.cardTitle}>양식 {vm.forms.length}개를 찾았어요</h4>
        <ul className="grid gap-1 text-sm">
          {vm.forms.slice(0, 3).map((form) => {
            const { writable, total } = writableFieldCount(form)
            return <li key={form.formVersionId} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate">{form.formTitle}</span>
              <span className={`${n.muted} shrink-0`}>자동 기입 {writable}/{total}문항</span>
            </li>
          })}
        </ul>
        <p className={n.muted}>양식과 신청 분야를 고르고 답변을 쓰는 일은 신청 문서 화면에서 이어서 해요.</p>
        <Link className={n.primary} to={path}>신청 문서 화면에서 작성하기 →</Link>
      </div>
      : <>
        <FormSectionBody vm={vm} />
        <Link className={n.ghost} to={path}>신청 문서 화면에서 열기</Link>
      </>)}
    <WorkspaceToast notice={vm.toast} onClose={vm.dismissToast} />
  </section>
}
