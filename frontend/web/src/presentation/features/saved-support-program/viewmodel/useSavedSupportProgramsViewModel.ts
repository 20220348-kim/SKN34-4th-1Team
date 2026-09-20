import { useEffect, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { SavedSupportProgram } from '../../../../domain/entities/SavedSupportProgram'
import type { SupportProgramStatus } from '../../../../domain/entities/SupportProgram'
import type { BrowseSavedSupportProgramsUseCase } from '../../../../domain/usecases/SavedSupportProgramUseCases'
import { appPaths, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import type { WorkspaceTagTone } from '../../../shared/workspace/WorkspacePage.styles'

type BrowseUseCase = Pick<BrowseSavedSupportProgramsUseCase, 'execute'>

export const savedSupportProgramMessages = {
  empty: '아직 담은 공고가 없습니다. 공고 상세에서 관심 공고 저장을 누르면 여기에 모입니다.',
  loading: '관심 공고를 불러오는 중입니다.',
  failed: '관심 공고를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

/** 공고 상세와 같은 접수 상태 이름입니다. */
export const supportProgramStatusLabels: Record<SupportProgramStatus, string> = {
  OPEN: '접수 중',
  UPCOMING: '접수 예정',
  CLOSED: '접수 마감',
  UNKNOWN: '상태 확인 필요',
}

const statusTones: Record<SupportProgramStatus, WorkspaceTagTone> = {
  OPEN: 'ok',
  UPCOMING: 'info',
  CLOSED: 'muted',
  UNKNOWN: 'warn',
}

type LoadState =
  | { phase: 'loading'; items: SavedSupportProgram[] }
  | { phase: 'ready'; items: SavedSupportProgram[] }
  | { phase: 'failed'; items: SavedSupportProgram[] }

/**
 * 관심 공고함 목록의 대표 ViewModel입니다. 담은 공고를 최근 순서로 읽어 카드에 필요한 표시 값과 상세 경로를 만듭니다.
 * 상세로 갈 때는 복귀 경로를 함께 넘겨 상세 머리글이 "관심 공고함 > 공고 상세"로 돌아오게 합니다.
 */
export function useSavedSupportProgramsViewModel(
  browseUseCase: BrowseUseCase = appContainer.resolve('browseSavedSupportProgramsUseCase'),
) {
  const [state, setState] = useState<LoadState>({ phase: 'loading', items: [] })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState((current) => ({ phase: 'loading', items: current.items }))
    browseUseCase.execute(controller.signal)
      .then((items) => { if (!controller.signal.aborted) setState({ phase: 'ready', items }) })
      .catch(() => { if (!controller.signal.aborted) setState((current) => ({ phase: 'failed', items: current.items })) })
    return () => controller.abort()
  }, [browseUseCase, version])

  return {
    phase: state.phase,
    items: state.items.map((saved) => ({
      key: `${saved.program.sourceCode}:${saved.program.id}`,
      title: saved.program.title,
      organization: saved.program.organization,
      sourceName: saved.program.sourceName,
      statusLabel: supportProgramStatusLabels[saved.program.status],
      statusTone: statusTones[saved.program.status],
      deadlineLabel: saved.program.applicationEndDate === null ? '접수 마감 별도 안내' : `접수 마감 ${saved.program.applicationEndDate}`,
      savedOnLabel: `${saved.savedAt.slice(0, 10)} 담음`,
      tags: [...saved.program.categories, ...saved.program.regions],
      detailPath: supportProgramDetailPath({ sourceCode: saved.program.sourceCode, sourceProgramId: saved.program.id }, true),
      /** 상세 머리글의 상위 화면을 관심 공고함으로 만듭니다. */
      detailState: { searchReturnTo: appPaths.savedPrograms },
    })),
    retry: () => setVersion((value) => value + 1),
    searchPath: appPaths.chat,
  }
}
