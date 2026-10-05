import { type FormEvent, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import {
  adminAuditActionLabels,
  adminAuditActions,
  adminAuditLogQueryIssue,
  defaultAdminAuditLogQuery,
  isAdminAuditDate,
  type AdminAuditAction,
  type AdminAuditLogPage,
  type AdminAuditLogQuery,
  type AdminAuditLogQueryIssue,
} from '../../../../domain/entities/AdminAuditLog'
import type { BrowseAdminAuditLogsUseCase } from '../../../../domain/usecases/AdminAuditLogUseCases'
import { signedOut } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import type { WorkspaceTagTone } from '../../../shared/workspace/WorkspacePage.styles'
import { adminAccessFailure } from './adminAccountAccess'
import { formatAdminTimestamp } from './adminAccountFormat'

type ListUseCases = {
  browse: Pick<BrowseAdminAuditLogsUseCase, 'execute'>
}

export const adminAuditLogMessages = {
  loading: '감사 기록을 불러오는 중이에요.',
  failed: '감사 기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
  empty: '조건에 맞는 기록이 없어요.',
  issues: {
    'invalid-account-id': '관리자 ID와 대상 ID는 숫자로 입력해 주세요.',
    'invalid-date': '기간의 날짜를 다시 골라 주세요.',
    'reversed-period': '시작일이 종료일보다 늦어요. 기간을 다시 골라 주세요.',
  } satisfies Record<AdminAuditLogQueryIssue, string>,
} as const

/** 화면을 바꾸는 조치는 주의 색, 조회는 옅은 색으로 나눕니다. 글자로도 작업 이름을 함께 보여 줍니다. */
const actionTones: Record<AdminAuditAction, WorkspaceTagTone> = {
  ACCOUNT_LIST: 'muted',
  ACCOUNT_DETAIL: 'muted',
  ACCOUNT_SUSPEND: 'warn',
  ACCOUNT_UNSUSPEND: 'warn',
  ACCOUNT_SESSIONS_REVOKE: 'warn',
  ACCOUNT_ADMIN_GRANT: 'warn',
  ACCOUNT_ADMIN_REVOKE: 'warn',
  AUDIT_LOG_LIST: 'muted',
}

/** 입력칸의 계정 ID입니다. 비우면 null, 숫자가 아니면 undefined입니다. */
function parseAccountId(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const id = Number(trimmed)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** 주소의 조건을 읽습니다. 모르는 값은 비우고, 시작일이 종료일보다 늦으면 기간 없이 엽니다. */
export function readAdminAuditLogQuery(params: URLSearchParams): AdminAuditLogQuery {
  const action = params.get('action')
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const query: AdminAuditLogQuery = {
    actorAccountId: parseAccountId(params.get('actorAccountId') ?? '') ?? null,
    targetAccountId: parseAccountId(params.get('targetAccountId') ?? '') ?? null,
    action: adminAuditActions.find((value) => value === action) ?? '',
    from: isAdminAuditDate(from) ? from : '',
    to: isAdminAuditDate(to) ? to : '',
  }
  return adminAuditLogQueryIssue(query) === null ? query : { ...query, from: '', to: '' }
}

/** 고른 조건만 주소에 남깁니다. 상세에서 돌아와도 같은 조건이 보입니다. */
function toSearchParams(query: AdminAuditLogQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.from !== '') params.set('from', query.from)
  if (query.to !== '') params.set('to', query.to)
  if (query.action !== '') params.set('action', query.action)
  if (query.actorAccountId !== null) params.set('actorAccountId', String(query.actorAccountId))
  if (query.targetAccountId !== null) params.set('targetAccountId', String(query.targetAccountId))
  return params
}

type Draft = { from: string; to: string; action: AdminAuditAction | ''; actorAccountId: string; targetAccountId: string }

function toDraft(query: AdminAuditLogQuery): Draft {
  return {
    from: query.from,
    to: query.to,
    action: query.action,
    actorAccountId: query.actorAccountId === null ? '' : String(query.actorAccountId),
    targetAccountId: query.targetAccountId === null ? '' : String(query.targetAccountId),
  }
}

/** 쪽마다 앞 쪽 마지막 기록 ID(`before`)를 기억해 이전·다음으로 오갑니다. 0쪽은 최신 기록부터입니다. */
type Paging = { key: string; cursors: (number | null)[]; index: number }
type PageState = { requestKey: string; phase: 'loading' | 'ready' | 'failed' | 'forbidden'; page: AdminAuditLogPage | null }

/**
 * 감사 기록 화면의 대표 ViewModel입니다. 조건은 주소에 두고 조회를 눌러 적용하며, 최신순 기록을 쪽 단위로 이전·다음 이동합니다.
 * 같은 조건으로 다시 조회하면 첫 쪽부터 새로 읽습니다. 이 화면을 읽는 일도 서버의 감사 기록에 남습니다.
 * 세션이 끝났으면(401) 로그인 상태를 비워 `RequireAuth`가 이 주소로 돌아오는 로그인으로 보내고, 관리자 권한이 없으면(403) 권한 안내를 보여 줍니다.
 */
export function useAdminAuditLogListViewModel(useCases: Partial<ListUseCases> = {}) {
  const [resolved] = useState<ListUseCases>(() => ({
    browse: useCases.browse ?? appContainer.resolve('browseAdminAuditLogsUseCase'),
  }))
  const dispatch = useAppDispatch()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = readAdminAuditLogQuery(searchParams)
  const key = JSON.stringify(query)
  const [version, setVersion] = useState(0)
  const [paging, setPaging] = useState<Paging>({ key, cursors: [null], index: 0 })
  const currentPaging = paging.key === key ? paging : { key, cursors: [null], index: 0 }
  const requestKey = JSON.stringify([key, currentPaging.cursors[currentPaging.index] ?? null])
  const [state, setState] = useState<PageState>({ requestKey, phase: 'loading', page: null })

  useEffect(() => {
    const [queryKey, before] = JSON.parse(requestKey) as [string, number | null]
    const controller = new AbortController()
    setState((previous) => ({ requestKey, phase: 'loading', page: previous.page }))
    void Promise.resolve()
      .then(() => resolved.browse.execute(JSON.parse(queryKey) as AdminAuditLogQuery, before, controller.signal))
      .then((page) => { if (!controller.signal.aborted) setState({ requestKey, phase: 'ready', page }) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const access = adminAccessFailure(error)
        if (access === 'signed-out') {
          dispatch(signedOut())
          return
        }
        setState((previous) => ({ ...previous, requestKey, phase: access === 'forbidden' ? 'forbidden' : 'failed' }))
      })
    return () => controller.abort()
  }, [requestKey, version, resolved, dispatch])

  const phase = state.requestKey === requestKey ? state.phase : 'loading'
  const page = state.page
  // 입력 중인 조건입니다. 주소의 조건이 바뀌면(초기화·뒤로 가기) 그 값으로 다시 시작합니다.
  const [draft, setDraft] = useState<{ base: string; values: Draft }>({ base: key, values: toDraft(query) })
  const values = draft.base === key ? draft.values : toDraft(query)
  const [formError, setFormError] = useState<string | null>(null)
  const update = (patch: Partial<Draft>) => {
    setDraft({ base: key, values: { ...values, ...patch } })
    setFormError(null)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const actorAccountId = parseAccountId(values.actorAccountId)
    const targetAccountId = parseAccountId(values.targetAccountId)
    if (actorAccountId === undefined || targetAccountId === undefined) {
      setFormError(adminAuditLogMessages.issues['invalid-account-id'])
      return
    }
    const next: AdminAuditLogQuery = { actorAccountId, targetAccountId, action: values.action, from: values.from, to: values.to }
    const issue = adminAuditLogQueryIssue(next)
    if (issue !== null) {
      setFormError(adminAuditLogMessages.issues[issue])
      return
    }
    const nextKey = JSON.stringify(next)
    setFormError(null)
    setDraft({ base: nextKey, values: toDraft(next) })
    // 같은 조건이면 첫 쪽부터 최신 기록을 다시 읽습니다.
    setPaging({ key: nextKey, cursors: [null], index: 0 })
    if (nextKey === key) setVersion((value) => value + 1)
    else setSearchParams(toSearchParams(next), { replace: true })
  }

  const hasFilters = key !== JSON.stringify(defaultAdminAuditLogQuery)

  return {
    phase,
    rows: (page?.records ?? []).map((record) => ({
      id: record.id,
      time: formatAdminTimestamp(record.createdAt),
      actionLabel: adminAuditActionLabels[record.action],
      actionTone: actionTones[record.action],
      actorEmail: record.actorEmail ?? '계정 정보 없음',
      actorId: `ID ${record.actorAccountId}`,
      target: record.targetAccountId === null ? null : {
        label: `ID ${record.targetAccountId}`,
        path: `${appPaths.adminAccountDetail}?${new URLSearchParams({ accountId: String(record.targetAccountId) })}`,
      },
      /** 대상 계정이 없을 때의 표시입니다. 목록 조회는 여러 회원을 보고, 감사 기록 조회는 회원 정보가 아닙니다. */
      targetNote: record.action === 'ACCOUNT_LIST' ? '여러 회원' : '—',
      summary: record.requestSummary ?? '—',
      clientIp: record.clientIp,
      userAgent: record.userAgent,
    })),
    retry: () => setVersion((value) => value + 1),
    pageNumber: currentPaging.index + 1,
    hasPrevious: currentPaging.index > 0,
    hasNext: phase === 'ready' && page?.nextCursor != null,
    goToPrevious: () => setPaging({ ...currentPaging, index: Math.max(0, currentPaging.index - 1) }),
    goToNext: () => {
      const nextCursor = page?.nextCursor
      if (phase !== 'ready' || nextCursor == null) return
      setPaging({ key, cursors: [...currentPaging.cursors.slice(0, currentPaging.index + 1), nextCursor], index: currentPaging.index + 1 })
    },
    form: {
      values,
      error: formError,
      updateFrom: (value: string) => update({ from: value }),
      updateTo: (value: string) => update({ to: value }),
      updateAction: (value: string) => update({ action: adminAuditActions.find((action) => action === value) ?? '' }),
      updateActorAccountId: (value: string) => update({ actorAccountId: value }),
      updateTargetAccountId: (value: string) => update({ targetAccountId: value }),
      actionOptions: [{ value: '', label: '전체 작업' }, ...adminAuditActions.map((value) => ({ value, label: adminAuditActionLabels[value] }))],
      submit,
    },
    hasFilters,
    resetFilters: () => {
      setDraft({ base: JSON.stringify(defaultAdminAuditLogQuery), values: toDraft(defaultAdminAuditLogQuery) })
      setFormError(null)
      setSearchParams(new URLSearchParams(), { replace: true })
    },
  }
}
