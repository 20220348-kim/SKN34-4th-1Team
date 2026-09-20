import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import type { AccountRole } from '../../../../domain/entities/Account'
import {
  adminAccountLoginMethodLabels,
  adminAccountRoleLabels,
  adminAccountSortLabels,
  adminAccountStatusLabels,
  defaultAdminAccountQuery,
  type AdminAccountLoginMethod,
  type AdminAccountPage,
  type AdminAccountQuery,
  type AdminAccountSort,
  type AdminAccountStats,
  type AdminAccountStatus,
} from '../../../../domain/entities/AdminAccount'
import type { BrowseAdminAccountsUseCase, GetAdminAccountStatsUseCase } from '../../../../domain/usecases/AdminAccountUseCases'
import { appPaths } from '../../../shared/routes/appPaths'
import type { AdminStatTone } from '../view/AdminAccountsPage.styles'
import { formatAdminDate, formatAdminDateTime } from './adminAccountFormat'

type ListUseCases = {
  browse: Pick<BrowseAdminAccountsUseCase, 'execute'>
  getStats: Pick<GetAdminAccountStatsUseCase, 'execute'>
}

const statuses = Object.keys(adminAccountStatusLabels) as AdminAccountStatus[]
const roles = Object.keys(adminAccountRoleLabels) as AccountRole[]
const loginMethods = Object.keys(adminAccountLoginMethodLabels) as AdminAccountLoginMethod[]
const sorts = Object.keys(adminAccountSortLabels) as AdminAccountSort[]

function oneOf<Value extends string>(value: string | null, allowed: readonly Value[]): Value | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as Value) : null
}

/** 주소의 조건을 읽습니다. 모르는 값은 기본값으로 둡니다. 상세에서 돌아와도 같은 조건이 보이도록 조건을 주소에 둡니다. */
export function readAdminAccountQuery(params: URLSearchParams): AdminAccountQuery {
  const page = Number(params.get('page'))
  return {
    keyword: (params.get('keyword') ?? '').trim().slice(0, 100),
    status: oneOf(params.get('status'), statuses) ?? '',
    role: oneOf(params.get('role'), roles) ?? '',
    loginMethod: oneOf(params.get('loginMethod'), loginMethods) ?? '',
    sort: oneOf(params.get('sort'), sorts) ?? defaultAdminAccountQuery.sort,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  }
}

/** 기본값과 다른 조건만 주소에 남깁니다. */
function toSearchParams(query: AdminAccountQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.keyword !== '') params.set('keyword', query.keyword)
  if (query.status !== '') params.set('status', query.status)
  if (query.role !== '') params.set('role', query.role)
  if (query.loginMethod !== '') params.set('loginMethod', query.loginMethod)
  if (query.sort !== defaultAdminAccountQuery.sort) params.set('sort', query.sort)
  if (query.page !== 1) params.set('page', String(query.page))
  return params
}

type PageState = { key: string; phase: 'loading' | 'ready' | 'failed'; page: AdminAccountPage | null }

/** 조건이 바뀌면 이전 요청을 취소하고 다시 읽습니다. 실패하면 마지막 결과를 둔 채 실패로 표시합니다. */
function useAdminAccountPage(query: AdminAccountQuery, useCase: ListUseCases['browse']) {
  const key = JSON.stringify(query)
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<PageState>({ key, phase: 'loading', page: null })

  useEffect(() => {
    const controller = new AbortController()
    setState((previous) => ({ key, phase: 'loading', page: previous.page }))
    void Promise.resolve()
      .then(() => useCase.execute(JSON.parse(key) as AdminAccountQuery, controller.signal))
      .then((page) => { if (!controller.signal.aborted) setState({ key, phase: 'ready', page }) })
      .catch(() => { if (!controller.signal.aborted) setState((previous) => ({ ...previous, key, phase: 'failed' })) })
    return () => controller.abort()
  }, [key, version, useCase])

  return {
    phase: state.key === key ? state.phase : 'loading',
    page: state.page,
    retry: () => setVersion((value) => value + 1),
  }
}

/** 요약 수치는 화면을 열 때 한 번 읽습니다. 실패하면 요약 줄만 숨기고 목록은 그대로 씁니다. */
function useAdminAccountStats(useCase: ListUseCases['getStats']) {
  const [stats, setStats] = useState<AdminAccountStats | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void Promise.resolve()
      .then(() => useCase.execute(controller.signal))
      .then((value) => { if (!controller.signal.aborted) setStats(value) })
      .catch(() => { if (!controller.signal.aborted) setStats(null) })
    return () => controller.abort()
  }, [useCase])

  return stats
}

/**
 * 관리자 계정 목록의 대표 ViewModel입니다. 조건은 주소에 두고, 검색어는 조회 버튼(Enter)에서 적용하며,
 * 상태·권한·로그인 방법·정렬을 바꾸면 첫 페이지부터 다시 읽습니다.
 */
export function useAdminAccountListViewModel(useCases: Partial<ListUseCases> = {}) {
  const [resolved] = useState<ListUseCases>(() => ({
    browse: useCases.browse ?? appContainer.resolve('browseAdminAccountsUseCase'),
    getStats: useCases.getStats ?? appContainer.resolve('getAdminAccountStatsUseCase'),
  }))
  const [searchParams, setSearchParams] = useSearchParams()
  const query = readAdminAccountQuery(searchParams)
  const { phase, page, retry } = useAdminAccountPage(query, resolved.browse)
  const stats = useAdminAccountStats(resolved.getStats)
  // 입력 중인 검색어입니다. 주소의 검색어가 바뀌면(초기화·뒤로 가기) 그 값으로 다시 시작합니다.
  const [draft, setDraft] = useState({ base: query.keyword, value: query.keyword })
  const keyword = draft.base === query.keyword ? draft.value : query.keyword

  const applyQuery = (next: AdminAccountQuery) => setSearchParams(toSearchParams(next), { replace: true })
  const narrow = (patch: Partial<AdminAccountQuery>) => applyQuery({ ...query, ...patch, page: 1 })

  return {
    phase,
    rows: (page?.accounts ?? []).map((account) => ({
      id: account.id,
      email: account.email,
      detailPath: `${appPaths.adminAccountDetail}?${new URLSearchParams({ accountId: String(account.id) })}`,
      companyName: account.company?.companyName ?? null,
      roleLabel: adminAccountRoleLabels[account.role],
      isAdmin: account.role === 'ADMIN',
      loginMethodLabels: account.loginMethods.map((method) => adminAccountLoginMethodLabels[method]),
      emailVerified: account.emailVerified,
      createdOn: formatAdminDate(account.createdAt),
      lastLogin: account.lastLoginAt === null ? '기록 없음' : formatAdminDateTime(account.lastLoginAt),
      statusLabel: adminAccountStatusLabels[account.status],
      isSuspended: account.status === 'SUSPENDED',
    })),
    /** 처음 읽기 전에는 null이라 건수 없이 "검색 결과"만 보입니다. */
    resultTotal: page === null ? null : page.total,
    currentPage: query.page,
    totalPages: page?.totalPages ?? 0,
    goToPage: (target: number) => applyQuery({ ...query, page: target }),
    retry,
    keyword,
    updateKeyword: (value: string) => setDraft({ base: query.keyword, value }),
    /** 조회 버튼·Enter로 검색어를 적용하고 첫 페이지부터 읽습니다. 칸에도 다듬은 검색어를 남깁니다. */
    submitSearch: () => {
      const applied = keyword.trim()
      setDraft({ base: applied, value: applied })
      narrow({ keyword: applied })
    },
    status: query.status,
    statusOptions: [{ value: '', label: '전체 상태' }, ...statuses.map((value) => ({ value, label: adminAccountStatusLabels[value] }))],
    selectStatus: (value: string) => narrow({ status: oneOf(value, statuses) ?? '' }),
    role: query.role,
    roleOptions: [{ value: '', label: '전체 권한' }, ...roles.map((value) => ({ value, label: adminAccountRoleLabels[value] }))],
    selectRole: (value: string) => narrow({ role: oneOf(value, roles) ?? '' }),
    loginMethod: query.loginMethod,
    loginMethodOptions: [
      { value: '', label: '전체 로그인 방법' },
      ...loginMethods.map((value) => ({ value, label: adminAccountLoginMethodLabels[value] })),
    ],
    selectLoginMethod: (value: string) => narrow({ loginMethod: oneOf(value, loginMethods) ?? '' }),
    sort: query.sort,
    sortOptions: sorts.map((value) => ({ value, label: adminAccountSortLabels[value] })),
    selectSort: (value: string) => narrow({ sort: oneOf(value, sorts) ?? defaultAdminAccountQuery.sort }),
    /** 검색어·상태·권한·로그인 방법 중 하나라도 골랐으면 참입니다. 정렬은 좁힌 것으로 보지 않습니다. */
    hasFilters: query.keyword !== '' || query.status !== '' || query.role !== '' || query.loginMethod !== '',
    resetFilters: () => {
      setDraft({ base: '', value: '' })
      applyQuery({ ...defaultAdminAccountQuery, sort: query.sort })
    },
    stats: stats === null ? null : toStatCells(stats),
  }
}

function toStatCells(stats: AdminAccountStats): { value: string; label: string; tone: AdminStatTone }[] {
  return [
    { value: `${stats.total.toLocaleString()}명`, label: '전체 계정', tone: 'neutral' },
    { value: `${stats.companyRegistered.toLocaleString()}명`, label: '기업 등록', tone: 'ok' },
    { value: `${stats.socialLinked.toLocaleString()}명`, label: '소셜 로그인 연결', tone: 'neutral' },
    { value: `${stats.joinedRecently.toLocaleString()}명`, label: `최근 ${stats.recentJoinDays}일 가입`, tone: 'neutral' },
    { value: `${stats.suspended.toLocaleString()}명`, label: '정지', tone: stats.suspended > 0 ? 'danger' : 'neutral' },
    { value: `${stats.admins.toLocaleString()}명`, label: '관리자', tone: 'neutral' },
  ]
}
