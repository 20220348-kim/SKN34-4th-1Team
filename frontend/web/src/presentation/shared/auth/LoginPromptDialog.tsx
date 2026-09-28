import { Link } from 'react-router'

import { WorkspaceModal } from '../workspace/WorkspaceModal'
import { workspaceModalStyles } from '../workspace/WorkspaceModal.styles'
import { workspacePageStyles } from '../workspace/WorkspacePage.styles'
import { loginPathFor, signupPathFor } from './returnPath'

/** 비로그인 사용자가 회원 기능을 눌렀을 때 여는 안내입니다. 어디서 열든 제목·버튼이 같고, 문장과 이점 목록만 화면이 정합니다. */
export type LoginPrompt = {
  /** 로그인·회원가입 뒤 돌아올 곳입니다. 지금 화면이거나, 누른 기능이 열리는 내부 화면입니다. */
  returnPath: string
  /** 무엇을 하려면 로그인이 필요한지 한 문장입니다. */
  description: string
  /** 로그인하면 할 수 있는 일입니다. 없으면 목록을 그리지 않습니다. */
  benefits?: readonly string[]
}

export const loginPromptTitle = '로그인이 필요해요'

const loginPromptStyles = {
  body: 'flex items-start gap-3',
  icon: 'grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-primary',
  text: 'm-0 flex-1 text-[0.875rem] leading-[1.6] text-app-ink',
  benefits: 'm-0 flex list-disc flex-col gap-1 rounded-[0.85rem] bg-surface-muted py-3 pr-3 pl-8 text-[0.8125rem] leading-[1.55] text-ink-muted',
  actions: 'flex flex-wrap justify-end gap-2 pt-1',
} as const

/**
 * 로그인 안내 다이얼로그입니다. 공고 상세의 관심 공고·원문 질문·신청 문서, 공개 파트너 모집글의 자세히 보기·제안이 모두 이 하나를 씁니다.
 * 흰 바탕에 초록 아이콘 하나만 두고, [로그인]이 주 동작이며 [회원가입]은 보조입니다. 둘 다 돌아올 곳을 `next`에 실어 보냅니다.
 */
export function LoginPromptDialog({ prompt, onClose }: { prompt: LoginPrompt | null; onClose: () => void }) {
  return (
    <WorkspaceModal isOpen={prompt !== null} title={loginPromptTitle} blurBackdrop onClose={onClose}>
      {prompt ? (
        <>
          <div className={loginPromptStyles.body}>
            <span className={loginPromptStyles.icon} aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0" />
              </svg>
            </span>
            <p className={loginPromptStyles.text}>{prompt.description}</p>
          </div>
          {prompt.benefits && prompt.benefits.length > 0 ? (
            <ul className={loginPromptStyles.benefits}>
              {prompt.benefits.map((benefit) => <li key={benefit}>{benefit}</li>)}
            </ul>
          ) : null}
          <div className={`${workspaceModalStyles.actions} ${loginPromptStyles.actions}`}>
            <Link className={workspacePageStyles.secondaryButton} to={signupPathFor(prompt.returnPath)}>회원가입</Link>
            <Link className={workspacePageStyles.primaryButton} to={loginPathFor(prompt.returnPath)}>로그인</Link>
          </div>
        </>
      ) : null}
    </WorkspaceModal>
  )
}
