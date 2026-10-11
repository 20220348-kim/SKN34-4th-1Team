import type { Href } from 'expo-router'
import { screenTitles } from '@govbiz/shared/design/screenTitles'
import type { AssistantCard } from '@govbiz/shared/domain/entities/AssistantAnswer'
import type { AssistantScreenContext } from '@govbiz/shared/domain/repositories/AssistantRepository'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'

export type AssistantOrigin = { path: string; context: AssistantScreenContext; program: SupportProgramIdentity | null; pageLabel?: string }
export function programIdentity(sourceCode: unknown, sourceProgramId: unknown): SupportProgramIdentity | null {
  return typeof sourceCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(sourceCode)
    && typeof sourceProgramId === 'string' && sourceProgramId.trim() === sourceProgramId
    && Array.from(sourceProgramId).length > 0 && Array.from(sourceProgramId).length <= 255 && !/\p{C}/u.test(sourceProgramId)
    ? { sourceCode, sourceProgramId } : null
}

export function assistantOrigin(path: string, params: { sourceCode?: unknown; sourceProgramId?: unknown; management?: unknown; step?: unknown; runId?: unknown }): AssistantOrigin {
  const program = path === '/program' ? programIdentity(params.sourceCode, params.sourceProgramId) : null
  const routes: Record<string, string> = { '/': '/app/chat', '/chat': '/app/chat', '/saved': '/app/saved-programs',
    '/report': '/app/reports', '/all': '/app', '/all/account': '/app/profile', '/all/company': '/app/profile',
    '/company': '/app/profile', '/program': '/app/support-programs/detail', '/all/collab': '/app/partners',
    '/collab': '/app/partners', '/all/pricing': '/app/pricing', '/pricing': '/app/pricing' }
  const route = routes[path] ?? (path.startsWith('/all/preparation') ? '/app/application-preparations'
    : path.startsWith('/all/reviews') ? '/app/combination-reviews' : path.startsWith('/partner/') ? '/app/partners' : '/app')
  const pageLabel = path === '/all/collab' ? params.management === '1' ? screenTitles.partnerManagement : screenTitles.publicPartners
    : path.startsWith('/all/reviews/') && !path.endsWith('/new') && (params.step === 'analysis' || (params.step === undefined && params.runId !== undefined)) ? screenTitles.combinationReviewRunResult : undefined
  return { path, context: { route, programSelected: program !== null }, program, ...(pageLabel ? { pageLabel } : {}) }
}

/** 서버의 웹 의미 경로를 명시적인 네이티브 경로로만 변환합니다. */
export function assistantDestination(to: string, options: { company?: boolean } = {}): Href | null {
  if (!to.startsWith('/app/') || to.startsWith('//') || to.includes('#')) return null
  const url = new URL(to, 'https://govbiz.invalid')
  if (url.origin !== 'https://govbiz.invalid') return null
  const keys = [...url.searchParams.keys()]
  if (new Set(keys).size !== keys.length) return null
  const only = (...allowed: string[]) => keys.every(key => allowed.includes(key))
  switch (url.pathname) {
    case '/app/chat':
      if (!only('mode') || url.searchParams.has('mode') && url.searchParams.get('mode') !== 'filter') return null
      return { pathname: '/(tabs)', params: { mode: url.searchParams.get('mode') === 'filter' ? 'filter' : 'ai' } }
    case '/app/saved-programs': return only() ? '/(tabs)/saved' : null
    case '/app/reports': return only() ? '/(tabs)/report' : null
    case '/app/profile': return only() ? options.company ? '/(tabs)/all/company' : '/(tabs)/all/account' : null
    case '/app/partners': return only() ? { pathname: '/(tabs)/all/collab', params: { management: '0', view: 'recruitments', mine: '0' } } : null
    case '/app/proposals': return only() ? { pathname: '/(tabs)/all/collab', params: { management: '1', view: 'box', box: 'received', mine: '0' } } : null
    case '/app/application-preparations': return only() ? '/(tabs)/all/preparation' : null
    case '/app/application-preparations/new': return only() ? '/(tabs)/all/preparation/new' : null
    case '/app/combination-reviews': return only() ? '/(tabs)/all/reviews' : null
    case '/app/pricing': return only() ? '/(tabs)/all/pricing' : null
    case '/app/partners/detail': {
      const id = url.searchParams.get('recruitmentId')
      return only('recruitmentId') && id && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))
        ? { pathname: '/partner/[id]', params: { id } } : null
    }
    case '/app/support-programs/detail': {
      const identity = programIdentity(url.searchParams.get('sourceCode'), url.searchParams.get('sourceProgramId'))
      return only('sourceCode', 'sourceProgramId') && identity ? { pathname: '/program', params: identity } : null
    }
    default: return null
  }
}

export function assistantCardDestination(card: AssistantCard): Href | null {
  const url = new URL(card.to, 'https://govbiz.invalid')
  if (card.kind === 'RECRUITMENT' && (url.pathname !== '/app/partners/detail' || url.searchParams.get('recruitmentId') !== card.id)) return null
  if (card.kind === 'PROGRAM' && (url.pathname !== '/app/support-programs/detail'
    || `${url.searchParams.get('sourceCode')}:${url.searchParams.get('sourceProgramId')}` !== card.id)) return null
  return assistantDestination(card.to)
}

export function programQuestionDestination(origin: AssistantOrigin): Href | null {
  return origin.program ? { pathname: '/program', params: origin.program } : null
}
