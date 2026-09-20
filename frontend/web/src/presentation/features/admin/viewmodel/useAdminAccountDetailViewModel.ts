import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import type { AccountTier } from '../../../../domain/entities/Account'
import {
  adminAccountActionLabels,
  adminAccountLoginMethodLabels,
  adminAccountRoleLabels,
  adminAccountStatusLabels,
  adminActionReasonMaxLength,
  availableAdminAccountActions,
  type AdminAccountActionKind,
  type AdminAccountDetail,
} from '../../../../domain/entities/AdminAccount'
import type { GetAdminAccountDetailUseCase, TakeAdminAccountActionUseCase } from '../../../../domain/usecases/AdminAccountUseCases'
import { appPaths } from '../../../shared/routes/appPaths'
import { formatAdminDate, formatAdminDateTime, formatBusinessNumber } from './adminAccountFormat'

type DetailUseCases = {
  getDetail: Pick<GetAdminAccountDetailUseCase, 'execute'>
  takeAction: Pick<TakeAdminAccountActionUseCase, 'execute'>
}

export const adminAccountDetailMessages = {
  reasonRequired: '사유를 입력해 주세요.',
  done: {
    suspend: '계정을 정지했습니다. 이 계정의 모든 세션이 종료되었습니다.',
    unsuspend: '정지를 해제했습니다. 회원은 다시 로그인하면 됩니다.',
    'revoke-sessions': '모든 기기에서 로그아웃시켰습니다.',
  } satisfies Record<AdminAccountActionKind, string>,
  conflict: '다른 관리자가 먼저 상태를 바꿨습니다. 최신 상태를 다시 불러왔습니다.',
  selfAction: '내 계정에는 조치할 수 없습니다.',
  protectedTarget: '관리자 계정은 정지하거나 강제 로그아웃할 수 없습니다.',
  requestFailed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

const actionCopy: Record<AdminAccountActionKind, {
  buttonLabel: string
  title: string
  description: (email: string) => string
  tone: 'default' | 'danger'
}> = {
  suspend: {
    buttonLabel: '정지',
    title: '계정을 정지할까요?',
    description: (email) => `${email} 계정은 바로 로그아웃되고, 정지를 풀 때까지 로그인할 수 없습니다.`,
    tone: 'danger',
  },
  unsuspend: {
    buttonLabel: '정지 해제',
    title: '정지를 해제할까요?',
    description: (email) => `${email} 계정이 다시 로그인할 수 있습니다.`,
    tone: 'default',
  },
  'revoke-sessions': {
    buttonLabel: '강제 로그아웃',
    title: '모든 기기에서 로그아웃할까요?',
    description: (email) => `${email} 계정의 모든 세션을 끝냅니다. 계정은 그대로라 다시 로그인할 수 있습니다.`,
    tone: 'danger',
  },
}

const tierLabels: Record<AccountTier, string> = { MEMBER: '회원', COMPANY: '기업 회원', ADMIN: '관리자' }

type DetailState = { id: number | null; phase: 'loading' | 'ready' | 'missing' | 'failed'; detail: AdminAccountDetail | null }
type ModalState = { kind: AdminAccountActionKind; reason: string; error: string | null; isSubmitting: boolean }

/** `?accountId=`가 하나뿐이고 양의 정수일 때만 상세를 찾습니다. */
export function readAdminAccountId(values: string[]): number | null {
  if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return null
  const id = Number(values[0])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * 관리자 계정 상세의 대표 ViewModel입니다. 상세를 읽고, 조치 모달(사유 입력·전송·결과 안내)을 소유합니다.
 * 조치에 성공하면 서버가 돌려준 최신 상세로 바꾸고, 다른 관리자가 먼저 바꿨으면 다시 읽습니다.
 */
export function useAdminAccountDetailViewModel(useCases: Partial<DetailUseCases> = {}) {
  const [resolved] = useState<DetailUseCases>(() => ({
    getDetail: useCases.getDetail ?? appContainer.resolve('getAdminAccountDetailUseCase'),
    takeAction: useCases.takeAction ?? appContainer.resolve('takeAdminAccountActionUseCase'),
  }))
  const [searchParams] = useSearchParams()
  const accountId = readAdminAccountId(searchParams.getAll('accountId'))
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<DetailState>({ id: accountId, phase: accountId === null ? 'missing' : 'loading', detail: null })
  const [modal, setModal] = useState<ModalState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  useEffect(() => {
    if (accountId === null) {
      setState({ id: null, phase: 'missing', detail: null })
      return
    }
    const controller = new AbortController()
    setState((previous) => ({ id: accountId, phase: 'loading', detail: previous.id === accountId ? previous.detail : null }))
    void Promise.resolve()
      .then(() => resolved.getDetail.execute(accountId, controller.signal))
      .then((detail) => {
        if (!controller.signal.aborted) setState({ id: accountId, phase: detail === null ? 'missing' : 'ready', detail })
      })
      .catch(() => { if (!controller.signal.aborted) setState((previous) => ({ ...previous, id: accountId, phase: 'failed' })) })
    return () => controller.abort()
  }, [accountId, version, resolved])

  const current = state.id === accountId ? state : { id: accountId, phase: 'loading' as const, detail: null }
  const detail = current.detail

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (modal === null || modal.isSubmitting || detail === null) return
    const kind = modal.kind
    const reason = modal.reason.trim()
    if (reason === '') {
      setModal({ ...modal, error: adminAccountDetailMessages.reasonRequired })
      return
    }
    setModal({ ...modal, isSubmitting: true, error: null })
    try {
      const result = await resolved.takeAction.execute(detail.account.id, kind, reason)
      if (!isMounted.current) return
      if (result.outcome === 'done') {
        setState({ id: result.detail.account.id, phase: 'ready', detail: result.detail })
        setModal(null)
        setNotice(adminAccountDetailMessages.done[kind])
        return
      }
      if (result.outcome === 'conflict') {
        setModal(null)
        setNotice(adminAccountDetailMessages.conflict)
        setVersion((value) => value + 1)
        return
      }
      if (result.outcome === 'not-found') {
        setModal(null)
        setState({ id: accountId, phase: 'missing', detail: null })
        return
      }
      const error = result.outcome === 'self-action' ? adminAccountDetailMessages.selfAction : adminAccountDetailMessages.protectedTarget
      setModal((value) => value && { ...value, isSubmitting: false, error })
    } catch {
      if (isMounted.current) setModal((value) => value && { ...value, isSubmitting: false, error: adminAccountDetailMessages.requestFailed })
    }
  }

  const account = detail?.account ?? null
  const copy = modal === null ? null : actionCopy[modal.kind]

  return {
    phase: current.phase,
    listPath: appPaths.adminAccounts,
    retry: () => setVersion((value) => value + 1),
    notice,
    dismissNotice: () => setNotice(null),
    account: account === null ? null : {
      email: account.email,
      statusLabel: adminAccountStatusLabels[account.status],
      isSuspended: account.status === 'SUSPENDED',
      rows: [
        // 관리자는 역할과 단계가 같으므로 한 번만 씁니다. 회원은 기업 등록 여부로 단계를 나눕니다.
        { label: '권한', value: account.role === 'ADMIN' ? adminAccountRoleLabels.ADMIN : tierLabels[account.tier] },
        { label: '로그인 방법', value: account.loginMethods.map((method) => adminAccountLoginMethodLabels[method]).join(', ') || '없음' },
        { label: '이메일 인증', value: account.emailVerified ? '인증됨' : '미인증' },
        { label: '비밀번호', value: account.hasPassword ? '있음' : '없음 (소셜 로그인 전용)' },
        { label: '가입일', value: formatAdminDate(account.createdAt) },
        { label: '최근 로그인', value: account.lastLoginAt === null ? '기록 없음' : formatAdminDateTime(account.lastLoginAt) },
        ...(account.suspendedAt === null ? [] : [{ label: '정지 시각', value: formatAdminDateTime(account.suspendedAt) }]),
      ],
    },
    companyRows: detail?.company == null ? null : [
      { label: '기업명', value: detail.company.companyName },
      { label: '사업자등록번호', value: formatBusinessNumber(detail.company.businessNumber) },
      { label: '소재지', value: detail.company.region },
      { label: '업종', value: detail.company.industry },
      { label: '설립연도', value: `${detail.company.foundedYear}년` },
    ],
    activityRows: detail === null ? [] : [
      { label: '모집글', value: `${detail.activity.recruitmentCount}건 (모집 중 ${detail.activity.openRecruitmentCount}건)` },
      { label: '보낸 제안', value: `${detail.activity.sentProposalCount}건` },
      { label: '로그인 중인 세션', value: `${detail.activity.activeSessionCount}개` },
    ],
    history: (detail?.actions ?? []).map((action) => ({
      id: action.id,
      label: adminAccountActionLabels[action.action],
      reason: action.reason,
      meta: `${formatAdminDateTime(action.createdAt)} · ${action.adminEmail}`,
    })),
    actions: detail === null ? [] : availableAdminAccountActions(detail).map((kind) => ({
      kind,
      label: actionCopy[kind].buttonLabel,
      tone: actionCopy[kind].tone,
      open: () => {
        setNotice(null)
        setModal({ kind, reason: '', error: null, isSubmitting: false })
      },
    })),
    /** 조치 버튼이 없는 까닭입니다. 조치할 수 있는 계정이면 null입니다. */
    actionNote: detail === null ? null
      : detail.isSelf ? '내 계정입니다. 자기 계정에는 조치할 수 없습니다.'
        : detail.account.role === 'ADMIN' ? '관리자 계정은 정지하거나 강제 로그아웃할 수 없습니다.'
          : null,
    modal: {
      isOpen: modal !== null && copy !== null && account !== null,
      title: copy?.title ?? '',
      description: copy !== null && account !== null ? copy.description(account.email) : '',
      tone: copy?.tone ?? 'default',
      confirmLabel: modal?.isSubmitting ? '처리 중…' : copy?.buttonLabel ?? '',
      reason: modal?.reason ?? '',
      reasonMaxLength: adminActionReasonMaxLength,
      updateReason: (value: string) => setModal((current) => current && { ...current, reason: value, error: null }),
      error: modal?.error ?? null,
      canSubmit: modal !== null && modal.reason.trim() !== '' && !modal.isSubmitting,
      submit: submitAction,
      close: () => setModal((current) => (current?.isSubmitting ? current : null)),
    },
  }
}
