import { useEffect, useState } from 'react'
import type { GovAgentApplication } from '@govbiz/shared/domain/entities/GovAgent'

import { appContainer } from '../../../../app/appContainer'
import type { ApplicationPreparationSummary } from '../../../../domain/entities/ApplicationPreparation'
import { appPaths } from '../../../shared/routes/appPaths'

/** 공고별 내 신청 준비 조회 상태입니다. 읽지 못하면 카드는 상태를 모른다고 알리고 화면 링크만 둡니다. */
export type ProgramPreparations =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; byProgram: ReadonlyMap<string, ApplicationPreparationSummary> }

export function programKey(program: { sourceCode: string; sourceProgramId: string }): string {
  return `${program.sourceCode}:${program.sourceProgramId}`
}

/**
 * 내 신청 준비 건을 한 번 읽어 공고별로 가장 최근에 고친 건을 고릅니다. 신청 문서는 신청 문서 화면에서 만들어져 대화 카드가 번호를 모르므로
 * 카드와 작업 칩은 공고로 내 신청 준비를 찾습니다. 목록 첫 쪽(최근 20건)만 읽고, refresh가 바뀌면(펼친 작업을 접으면) 다시 읽습니다.
 */
export function useProgramPreparations(enabled: boolean, refresh: number): ProgramPreparations | null {
  const [state, setState] = useState<ProgramPreparations | null>(null)
  useEffect(() => {
    if (!enabled) { setState(null); return }
    const controller = new AbortController()
    setState({ phase: 'loading' })
    appContainer.resolve('applicationPreparationUseCase').list({}, controller.signal).then((page) => {
      if (controller.signal.aborted) return
      const byProgram = new Map<string, ApplicationPreparationSummary>()
      for (const item of page.items) {
        const current = byProgram.get(programKey(item))
        if (!current || Date.parse(item.updatedAt) > Date.parse(current.updatedAt)) byProgram.set(programKey(item), item)
      }
      setState({ phase: 'ready', byProgram })
    }, () => { if (!controller.signal.aborted) setState({ phase: 'failed' }) })
    return () => controller.abort()
  }, [enabled, refresh])
  return state
}

/** 카드의 신청 준비 건입니다. 예전 대화에서 붙인 번호가 있으면 그 건을, 없으면 그 공고의 최근 건을 씁니다. */
export function preparationOf(application: GovAgentApplication, preparations: ProgramPreparations | null): ApplicationPreparationSummary | null {
  if (preparations?.phase !== 'ready') return null
  const { preparationId, program } = application
  if (preparationId === undefined) return preparations.byProgram.get(programKey(program)) ?? null
  return [...preparations.byProgram.values()].find((item) => item.id === preparationId) ?? null
}

/** 쓰는 중인 신청 준비의 이어서 쓰기 문구입니다. 필수 답변 수를 아는 서버면 함께 적습니다. */
export function continueLabel(summary: ApplicationPreparationSummary): string {
  return summary.requiredTotal ? `이어서 쓰기 · ${summary.answeredRequired ?? 0}/${summary.requiredTotal}` : '이어서 쓰기'
}

export function preparationPath(summary: ApplicationPreparationSummary): string {
  return summary.hasCurrentDocument ? `${appPaths.applicationPreparations}/${summary.id}/documents` : `${appPaths.applicationPreparations}/${summary.id}`
}
