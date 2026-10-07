import { useEffect, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { SupportProgramAttachment } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import type { GetSupportProgramAttachmentsUseCase } from '../../../../domain/usecases/GetSupportProgramAttachmentsUseCase'

type SupportProgramAttachmentsUseCase = Pick<GetSupportProgramAttachmentsUseCase, 'execute'>

/** 첨부 목록은 Core가 공고 원문을 읽어 만드므로 상세 조회보다 오래 기다립니다. */
export const supportProgramAttachmentsTimeoutMilliseconds = 20_000

export type SupportProgramAttachmentsState =
  | { status: 'loading'; attachments: [] }
  | { status: 'ready'; attachments: SupportProgramAttachment[] }
  | { status: 'failed'; attachments: [] }

/** 상세 본문과 따로 공식 첨부 목록을 불러옵니다. 실패해도 상세는 그대로 보이고 이 구역만 원문 안내로 바뀝니다. */
export function useSupportProgramAttachmentsViewModel(
  identity: SupportProgramIdentity,
  getSupportProgramAttachmentsUseCase: SupportProgramAttachmentsUseCase = appContainer.resolve(
    'getSupportProgramAttachmentsUseCase',
  ),
): SupportProgramAttachmentsState {
  const { sourceCode, sourceProgramId } = identity
  const [state, setState] = useState<SupportProgramAttachmentsState>({ status: 'loading', attachments: [] })

  useEffect(() => {
    const controller = new AbortController()
    let isCurrentRequest = true

    setState({ status: 'loading', attachments: [] })
    const timeoutId = setTimeout(() => {
      if (!isCurrentRequest) return
      controller.abort()
      setState({ status: 'failed', attachments: [] })
    }, supportProgramAttachmentsTimeoutMilliseconds)

    void getSupportProgramAttachmentsUseCase
      .execute({ sourceCode, sourceProgramId }, controller.signal)
      .then((attachments) => {
        if (!isCurrentRequest || controller.signal.aborted) return
        setState({ status: 'ready', attachments })
      })
      .catch(() => {
        if (!isCurrentRequest || controller.signal.aborted) return
        setState({ status: 'failed', attachments: [] })
      })
      .finally(() => clearTimeout(timeoutId))

    return () => {
      isCurrentRequest = false
      clearTimeout(timeoutId)
      controller.abort()
    }
  }, [getSupportProgramAttachmentsUseCase, sourceCode, sourceProgramId])

  return state
}
