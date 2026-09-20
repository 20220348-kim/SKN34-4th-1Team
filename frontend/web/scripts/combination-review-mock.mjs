// 로컬 브라우저 검증 전용. 외부 서비스·OpenAI를 호출하지 않는다.
// Node 24: node scripts/combination-review-mock.mjs
import { createServer } from 'node:http'
import { reviewFixture, runFixture } from '../src/presentation/features/combination-review/testing/reviewFixtures.ts'

let mode = 'success'
let email = 'review-a@example.com'
let review = structuredClone(reviewFixture)
let runs = [structuredClone(runFixture)]
const requests = []
const account = () => ({ email, role: 'USER', tier: 'MEMBER', emailVerified: false })
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4181')
  const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
  if (url.pathname === '/__scenario') {
    mode = url.searchParams.get('mode') ?? 'success'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<h1>모의 응답: ${mode}</h1><p>실제 OpenAI 호출 없음</p><a href="http://localhost:5175/app/combination-reviews/12">검토 화면으로</a>`); return
  }
  if (url.pathname === '/__requests') { send(requests); return }
  if (url.pathname === '/__reset') { review = structuredClone(reviewFixture); runs = []; mode = 'success'; send({ ok: true }); return }
  if (url.pathname === '/__switch') { email = 'review-b@example.com'; review = { ...reviewFixture, title: 'B 계정 검토' }; runs = []; send(account()); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : null
  requests.push({ method: req.method, path: url.pathname, body })
  if (url.pathname === '/api/v1/auth/me') { send({ account: account() }); return }
  if (url.pathname === '/api/v1/auth/login' || url.pathname === '/api/v1/auth/dev-login') {
    if (body?.email) email = body.email
    send({ account: account(), expiresAt: '2026-09-10T12:00:00+09:00' }); return
  }
  if (url.pathname === '/api/v1/auth/logout') { res.writeHead(204); res.end(); return }
  if (url.pathname === '/api/v1/support-programs/catalog') {
    const keyword = url.searchParams.get('keyword') ?? ''
    const programs = ['PBLN_100', 'PBLN_200', 'PBLN_300'].map((id, i) => ({
      id, sourceCode: 'BIZINFO', title: ['창업도약 일반형 · 모의 공고', '딥테크 지원 · 모의 공고', '성장 지원 · 모의 공고'][i], organization: '모의 기관', summary: '브라우저 검증용 가상 공고입니다.', categories: ['창업'], regions: ['전국'], targetDescription: '가상 기업', applicationPeriod: '2026-01-01 ~ 2026-02-01', applicationStartDate: '2026-01-01', applicationEndDate: '2026-02-01', status: 'CLOSED', sourceName: '기업마당', sourceUrl: 'https://www.bizinfo.go.kr/', matchedReasons: [], recommendationScore: null, eligibilityReview: null,
    })).filter((p) => p.title.includes(keyword))
    send({ programs, total: programs.length, page: Number(url.searchParams.get('page')), pageSize: Number(url.searchParams.get('pageSize')), totalPages: programs.length ? 1 : 0, regions: ['전국'], categories: ['창업'] }); return
  }
  const base = '/api/v1/combination-reviews'
  if (url.pathname.startsWith(base) && mode === 'expired') { send({ code: 'UNAUTHENTICATED' }, 401); return }
  if (url.pathname === base && req.method === 'GET') { send({ items: mode === 'empty' ? [] : [review], nextBeforeId: null }); return }
  if (url.pathname === base && req.method === 'POST') { review = { ...review, ...body, id: 12, inputRevision: 1 }; runs = []; send(review, 201); return }
  if (url.pathname === `${base}/12` && req.method === 'GET') { send(review); return }
  if (url.pathname === `${base}/12/inputs`) {
    if (mode === 'conflict') { review = { ...review, title: '다른 화면에서 저장한 최신 제목', inputRevision: review.inputRevision + 1 }; send({ code: 'COMBINATION_REVIEW_REVISION_CONFLICT' }, 409); return }
    review = { ...review, title: body.title, programs: body.programs, inputRevision: review.inputRevision + 1 }; res.writeHead(204); res.end(); return
  }
  if (url.pathname === `${base}/12/runs` && req.method === 'GET') { send({ items: runs, nextBeforeId: null }); return }
  if (url.pathname === `${base}/12/runs` && req.method === 'POST') {
    const existing = runs.find((run) => run.requestKey === body.requestKey)
    if (existing) { send(existing); return }
    const next = { ...structuredClone(runFixture), id: Math.max(30, ...runs.map((r) => r.id)) + 1, inputRevision: body.expectedRevision, requestKey: body.requestKey,
      input: { title: review.title, programs: review.programs, additionalFacts: body.additionalFacts, asOfDate: '2026-09-09' } }
    if (['422', '429', '503'].includes(mode)) { next.status = 'FAILED'; next.analysis = null; next.failureCode = mode === '422' ? 'SOURCE_UNSUPPORTED' : mode === '429' ? 'RUN_RATE_LIMITED' : 'ANALYSIS_UNAVAILABLE' }
    if (mode === 'running') { next.status = 'RUNNING'; next.analysis = null; next.finishedAt = null }
    runs.unshift(next)
    if (mode === 'lost') { req.socket.destroy(); return }
    if (mode === 'delayed') await new Promise((resolve) => setTimeout(resolve, 8000))
    if (next.status === 'FAILED') { send({ code: next.failureCode, runId: next.id }, Number(mode)); return }
    send(next, 201); return
  }
  const match = url.pathname.match(/\/12\/runs\/(\d+)(?:\/sources\/(\d+))?$/)
  if (match) {
    const run = runs.find((r) => r.id === Number(match[1]))
    if (!run) { send({ code: 'COMBINATION_REVIEW_NOT_FOUND' }, 404); return }
    if (match[2] !== undefined) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="mock-source.pdf"' }); res.end('%PDF-1.4\n%mock source for download verification'); return }
    send(run); return
  }
  send({ code: 'NOT_FOUND' }, 404)
}).listen(4181, '127.0.0.1', () => console.log('Mock API: http://127.0.0.1:4181 (no outbound requests)'))
