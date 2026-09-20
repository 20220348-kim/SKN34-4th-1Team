/* Node 24 + 외부에 설치된 Playwright로 실행하는 선택적 실제 브라우저 회귀 검사.
 * 앱 서버만 미리 실행합니다. 모든 API는 가로채며 외부 네트워크는 차단합니다.
 * PLAYWRIGHT_MODULE_PATH / BROWSER_EXECUTABLE_PATH / UI_TEST_BASE_URL은 README 참조.
 */
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { supportPrograms } = require('../src/data/fixtures/supportPrograms.ts')
const { partnerRecruitmentDetail, partnerRecruitmentPage } = require('../src/data/fixtures/partnerRecruitments.ts')
const { receivedProposalBox, sentProposalBox } = require('../src/data/fixtures/partnerProposals.ts')

const origin = new URL(process.env.UI_TEST_BASE_URL || 'http://127.0.0.1:5173').origin
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), '로컬 개발 서버만 허용합니다.')
const source = { sourceCode: 'BIZINFO', sourceName: '기업마당', searchState: 'SEARCHABLE',
  programCount: supportPrograms.length, indexReady: true, lastSuccessfulSyncAt: null, lastFailedSyncAt: null }
const longProgram = { ...supportPrograms[0], title: `레이아웃검증-${'A'.repeat(260)}`,
  summary: 'B'.repeat(700), targetDescription: 'C'.repeat(500), matchedReasons: [] }
const detailQuery = new URLSearchParams({ sourceCode: longProgram.sourceCode, sourceProgramId: longProgram.id })
const detailPath = `/support-programs/detail?${detailQuery}`
// 모집글 목록·상세도 긴 제목·역량으로 레이아웃을 검증합니다.
const longRecruitment = { ...partnerRecruitmentDetail, title: `모집검증-${'R'.repeat(80)}`, capabilities: Array.from({ length: 10 }, (_, index) => `역량${index}-${'S'.repeat(28)}`) }
const questionPath = `/support-programs/detail/question?${detailQuery}`
const paths = ['/', '/pricing', '/app/chat', '/app/pricing', '/login', '/signup', '/forgot-password', '/reset-password', '/partners', '/app/partners', '/app/partners/new',
  '/partners/detail?recruitmentId=101', '/app/partners/detail?recruitmentId=101', '/app/proposals', '/app/profile',
  '/app/admin/accounts', detailPath, questionPath, '/examples/sample-item/hook', '/examples/sample-item/redux']
// `/app` 경로는 회원 세션이 있어야 열립니다. 앱이 세션 힌트를 보고 부르는 /auth/me 응답을 경로별로 심습니다.
const sessionHintKey = 'govbiz.hasSession'
const memberAccount = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true }
const adminAccount = { email: 'admin@govbiz.local', role: 'ADMIN', tier: 'ADMIN', emailVerified: true }
// 모집글 작성은 기업을 등록한 회원만 열 수 있으므로 그 경로만 기업 요약이 있는 세션을 심습니다.
const companyAccount = { email: 'company@govbiz.local', role: 'USER', tier: 'COMPANY', emailVerified: true, company: { companyName: '예시 소프트웨어 주식회사', businessNumber: '1234567890' } }
let sessionAccount = null
const sizes = [[320, 568], [375, 667], [768, 800], [844, 390], [1024, 800], [1280, 800], [1440, 900]]
const chatOnlySizes = [[375, 400], [900, 700], [901, 700]]

async function checkPublicChatDock(page, label) {
  const geometry = await page.evaluate(() => {
    const input = document.querySelector('textarea[aria-label="지원사업 검색어"]')
    const form = input.form.getBoundingClientRect()
    const timeline = document.querySelector('[aria-label="대화 내역"]').getBoundingClientRect()
    const header = document.querySelector('header').getBoundingClientRect()
    const buttons = [...input.form.querySelectorAll('button')]
      .filter(button => ['검색 전송', '취소', '새 검색'].includes(button.getAttribute('aria-label') || button.textContent.trim()))
      .map(button => button.getBoundingClientRect())
    return { height: innerHeight, documentHeight: document.documentElement.scrollHeight, scrollY,
      headerBottom: header.bottom, timelineTop: timeline.top, timelineBottom: timeline.bottom,
      timelineHeight: timeline.height, formTop: form.top, formBottom: form.bottom,
      buttonsVisible: buttons.every(rect => rect.top >= form.top - 1 && rect.bottom <= form.bottom + 1), rows: input.rows }
  })
  assert.equal(geometry.rows, 1, `${label}: 전송 뒤 간결한 입력창`)
  assert.equal(geometry.scrollY, 0, `${label}: 문서 스크롤 금지`)
  assert(geometry.documentHeight <= geometry.height + 1, `${label}: 외부 세로 넘침`)
  assert(geometry.headerBottom <= geometry.timelineTop + 1, `${label}: 헤더와 대화 겹침`)
  assert(geometry.timelineHeight >= 40, `${label}: 대화 높이 부족`)
  assert(geometry.timelineBottom <= geometry.formTop + 1, `${label}: 대화와 입력창 겹침`)
  assert(geometry.formBottom <= geometry.height + 1, `${label}: 하단 폼이 화면 안에 있어야 함`)
  assert(geometry.buttonsVisible, `${label}: 전송·취소·새 검색 버튼이 폼 안에 보여야 함`)
}

async function checkBounds(page, label) {
  const failures = await page.evaluate(() => {
    const problems = []
    // 이번에 정리한 활성 안내 토큰의 실제 렌더 색상만 검사합니다. 전체 WCAG 감사는 아닙니다.
    const luminance = rgb => rgb.slice(0, 3).map(v => v / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0)
    const rgb = color => color.match(/[\d.]+/g)?.map(Number)
    for (const node of document.querySelectorAll('.text-sample-muted, .placeholder\\:text-sample-muted')) {
      if (node.matches(':disabled') || !node.getClientRects().length) continue
      let background
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        if (style.backgroundImage !== 'none' || Number(style.opacity) < 1) break
        const candidate = rgb(style.backgroundColor)
        if (candidate && (candidate.length === 3 || candidate[3] === 1)) { background = candidate; break }
      }
      if (!background) continue
      const pseudo = node.classList.contains('placeholder:text-sample-muted') ? '::placeholder' : null
      const foreground = rgb(getComputedStyle(node, pseudo).color)
      if (!foreground) continue
      const lights = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
      if ((lights[0] + 0.05) / (lights[1] + 0.05) < 4.5) problems.push(`활성 안내 대비 부족: ${node.id || node.textContent.slice(0, 20)}`)
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`문서 가로 넘침 ${document.documentElement.scrollWidth}/${innerWidth}`)
    // 표는 의도적으로 자체 가로 스크롤합니다. 일반 폼 입력이 0~49px로 붕괴하는 경우는 허용하지 않습니다.
    for (const input of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select')) {
      const rect = input.getBoundingClientRect()
      if (rect.width > 0 && rect.width < 100) problems.push(`입력 폭 부족 ${input.id || input.name}: ${rect.width}`)
      const form = input.closest('form')?.getBoundingClientRect()
      if (form && (rect.left < form.left - 1 || rect.right > form.right + 1)) problems.push(`폼 밖 입력 ${input.id || input.name}`)
    }
    const workspace = document.querySelector('[aria-label="작업 사이드바"]')?.parentElement
    if (workspace && innerWidth >= 760 && document.documentElement.scrollHeight > innerHeight + 1) {
      problems.push(`작업 화면 외부 세로 넘침 ${document.documentElement.scrollHeight}/${innerHeight}`)
    }
    return problems
  })
  assert.deepEqual(failures, [], label)
}

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) })
  let pagesChecked = 0
  let flowsChecked = 0
  const calls = { interpret: 0, search: 0, answers: 0 }
  const errors = []
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort()
      let json
      if (url.pathname.endsWith('/auth/me')) {
        if (sessionAccount) json = { account: sessionAccount }
        else return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'AUTHENTICATION_REQUIRED' }) })
      } else if (url.pathname.endsWith('/auth/logout')) return route.fulfill({ status: 204, body: '' })
      else if (url.pathname.endsWith('/me/company/partner-profile') || url.pathname.endsWith('/me/company')) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'COMPANY_NOT_REGISTERED' }) })
      }
      else if (url.pathname.endsWith('/support-programs/catalog')) {
        const programs = supportPrograms.filter(program => program.status === 'OPEN').slice(0, 8)
          .map(program => ({ ...program, matchedReasons: [], recommendationScore: null, eligibilityReview: null }))
        json = { programs, total: programs.length, page: 1, pageSize: 8, totalPages: 1, regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [] }
      }
      else if (url.pathname.endsWith('/me/proposals')) {
        json = url.searchParams.get('box') === 'sent' ? sentProposalBox : receivedProposalBox
      }
      else if (url.pathname.endsWith('/partners/recruitments')) {
        json = { ...partnerRecruitmentPage, recruitments: [longRecruitment, ...partnerRecruitmentPage.recruitments.slice(1)] }
      } else if (url.pathname.endsWith('/partners/recruitments/101')) json = longRecruitment
      else if (url.pathname.endsWith('/readiness')) json = { ...source, sources: [source] }
      else if (url.pathname.endsWith('/interpret')) {
        calls.interpret++
        const command = request.postDataJSON()
        json = { status: 'READY', proposedContext: { ...command.context, query: command.message.trim() },
          changedFields: ['QUERY'], clarificationQuestion: null }
      } else if (url.pathname.endsWith('/search')) {
        calls.search++
        json = { query: request.postDataJSON().query, programs: [longProgram, ...supportPrograms.slice(1)] }
      } else if (url.pathname.endsWith('/detail')) json = longProgram
      else if (url.pathname.endsWith('/answers')) {
        calls.answers++
        json = { answerStatus: 'ANSWERED', answer: 'D'.repeat(1000),
          citations: [{ excerpt: 'E'.repeat(1200), sourceUrl: longProgram.sourceUrl, chunkOrder: 0 }] }
      } else return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      return route.fulfill({ json })
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(8000)
    for (const [width, height] of [...sizes, ...chatOnlySizes]) {
      await page.setViewportSize({ width, height })
      const checkedPaths = chatOnlySizes.some(size => size[0] === width && size[1] === height) ? ['/'] : paths
      for (const path of checkedPaths) {
        const label = `${width}x${height} ${path}`
        sessionAccount = path.startsWith('/app/admin') ? adminAccount : path === '/app/partners/new' ? companyAccount : path.startsWith('/app') ? memberAccount : null
        if (!page.url().startsWith(origin)) await page.goto(origin + '/login')
        await page.evaluate(([key, hasSession]) => hasSession ? localStorage.setItem(key, '1') : localStorage.removeItem(key),
          [sessionHintKey, sessionAccount !== null])
        await page.goto(origin + path)
        await page.locator('h1').first().waitFor({ state: 'attached' })
        if (path === '/') {
          // computed animation 종료 여부만으로는 긴 delay 뒤 글자가 hidden에 남는 오류를 잡지 못합니다.
          await page.waitForFunction(() => {
            const characters = [...document.querySelectorAll('h1 [data-title-character]')]
            return characters.length > 0 && characters.every(node => getComputedStyle(node).visibility === 'visible')
          }, null, { timeout: 5000 })
        }
        if (path === detailPath) await page.getByRole('heading', { name: longProgram.title, exact: true }).waitFor()
        await checkBounds(page, label)
        pagesChecked++
        if (path === '/' || path === '/app/chat') {
          const input = page.getByRole('textbox', { name: '지원사업 검색어' })
          const originalInput = await input.elementHandle()
          await input.fill('A'.repeat(400) + '\n서울 AI 사업')
          if (path === '/') {
            assert.equal(await input.getAttribute('rows'), '3', `${label}: 초안만으로 배치 전환 금지`)
            assert.equal(await page.getByRole('heading', { level: 1, name: '우리 회사에 맞는 지원사업, AI와 함께 무료로 찾아보세요.', exact: true }).count(), 1)
            assert.equal(await page.getByText('AI 맞춤 검색', { exact: true }).count(), 0)
            const animations = await page.locator('h1 [data-title-line], h1 [data-title-highlight]').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName))
            assert.deepEqual(animations, ['search-intro-enter', 'search-intro-enter', 'search-intro-highlight'], `${label}: 제목 진입·강조 효과`)
          }
          const before = { ...calls }
          await page.getByRole('button', { name: '검색 전송', exact: true }).click()
          const confirm = page.getByRole('button', { name: '이 조건으로 검색', exact: true })
          await confirm.waitFor()
          if (path === '/') {
            assert(await input.evaluate((node, original) => node === original, originalInput), `${label}: 같은 입력 DOM 유지`)
            assert.equal(await page.getByText('AI 맞춤 검색', { exact: true }).count(), 0)
            await checkPublicChatDock(page, `${label} 제안`)
          }
          assert.equal(calls.search, before.search, `${label}: 확인 전 검색 금지`)
          const box = await confirm.boundingBox()
          assert(box && box.y >= 0 && box.y + box.height <= height + 1, `${label}: 확인 버튼이 자동 스크롤로 보여야 함`)
          await confirm.click()
          await page.getByRole('heading', { name: longProgram.title, exact: true }).waitFor()
          await checkBounds(page, `${label} 검색 결과`)
          const timeline = page.getByRole('region', { name: '대화 내역', exact: true })
          assert(await timeline.evaluate(n => n.scrollWidth <= n.clientWidth + 1), `${label}: 긴 대화 가로 넘침`)
          const bubble = timeline.locator('article.justify-end > div > div').first()
          assert.equal(await bubble.evaluate(n => getComputedStyle(n).whiteSpace), 'pre-wrap', `${label}: 줄바꿈 보존`)
          if (path === '/app/chat' && width >= 760) {
            const inputBox = await input.boundingBox()
            assert(inputBox && inputBox.y >= 0 && inputBox.y + inputBox.height <= height, `${label}: 데스크톱 입력창 고정`)
          }
          if (path === '/') {
            await checkPublicChatDock(page, `${label} 긴 결과`)
            const formBefore = await input.locator('xpath=ancestor::form').boundingBox()
            assert(await timeline.evaluate(node => node.scrollHeight > node.clientHeight), `${label}: 대화 내부 스크롤 필요`)
            await timeline.evaluate(node => { node.scrollTop = 80 })
            const scrollTop = await timeline.evaluate(node => node.scrollTop)
            await input.fill('상세 복귀 후 이어 쓸 초안')
            assert.equal(await timeline.evaluate(node => node.scrollTop), scrollTop, `${label}: 초안 편집으로 대화 스크롤 금지`)
            const formAfter = await input.locator('xpath=ancestor::form').boundingBox()
            assert(Math.abs(formBefore.y - formAfter.y) <= 1, `${label}: 대화 스크롤·초안 편집 후 폼 위치 유지`)
            await page.getByRole('link', { name: '상세 조건 보기', exact: true }).first().click()
            await page.getByRole('heading', { name: longProgram.title, exact: true }).waitFor()
            await page.getByRole('link', { name: '이 공고에 질문하기', exact: true }).click()
            await page.getByRole('link', { name: '← 공고 상세로 돌아가기', exact: true }).click()
            await page.getByRole('link', { name: '← 검색 결과로 돌아가기', exact: true }).first().click()
            await input.waitFor()
            assert.equal(await input.inputValue(), '상세 복귀 후 이어 쓸 초안')
            await checkPublicChatDock(page, `${label} 상세 왕복`)
            flowsChecked++
          }
          assert.equal(calls.interpret, before.interpret + 1)
          assert.equal(calls.search, before.search + 1)
          if (path === '/' && await page.getByRole('button', { name: '메뉴 열기', exact: true }).isVisible()) {
            await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
          }
          await page.getByRole('button', { name: path === '/' ? '새 채팅' : '새 검색', exact: true }).click()
          assert.equal(await input.inputValue(), '')
          assert(await input.evaluate(n => n === document.activeElement), `${label}: 새 검색 포커스`)
          assert.equal(await page.getByRole('heading', { name: longProgram.title, exact: true }).count(), 0)
          assert.equal(calls.search, before.search + 1, `${label}: 초기화 자동 검색 금지`)
          if (path === '/') {
            assert.equal(await input.getAttribute('rows'), '3', `${label}: 초기 중앙 입력창 복귀`)
            assert.equal(await page.getByRole('heading', { level: 1, name: '우리 회사에 맞는 지원사업, AI와 함께 무료로 찾아보세요.', exact: true }).count(), 1)
            assert.equal(await page.getByText('AI 맞춤 검색', { exact: true }).count(), 0)
          }
          await originalInput.dispose()
          flowsChecked++
        } else if (path === '/pricing') {
          const main = page.getByRole('main')
          for (const name of ['무료', '프로', '팀']) {
            assert.equal(await main.getByRole('heading', { name, exact: true }).count(), 1)
          }
          const pending = main.getByRole('button', { name: '출시 준비 중', exact: true })
          assert.equal(await pending.count(), 2)
          for (const button of await pending.all()) assert(await button.isDisabled())
          const faq = main.locator('details').first()
          await faq.locator('summary').focus()
          await faq.locator('summary').press('Enter')
          assert(await faq.evaluate(node => node.open), `${label}: 키보드로 FAQ 열기`)
          await checkBounds(page, `${label} FAQ 펼침`)
          await faq.locator('summary').press('Enter')
          assert(!(await faq.evaluate(node => node.open)), `${label}: 키보드로 FAQ 닫기`)
          await main.getByRole('link', { name: '무료로 지원사업 찾기', exact: true }).click()
          await page.getByRole('textbox', { name: '지원사업 검색어' }).waitFor()
          flowsChecked++
        } else if (path === questionPath) {
          const input = page.getByRole('textbox', { name: '공고 원문에 질문하기' })
          await input.fill('가'.repeat(501))
          assert.equal(await input.getAttribute('aria-invalid'), 'true')
          assert(await page.getByRole('button', { name: '질문하고 근거 받기' }).isDisabled())
          await input.fill('신청 대상을 알려주세요')
          await page.getByRole('button', { name: '질문하고 근거 받기' }).click()
          await page.getByText('D'.repeat(1000), { exact: true }).waitFor()
          await checkBounds(page, `${label} 긴 답변·근거`)
          flowsChecked++
        } else if (path === '/app/partners/new') {
          const input = page.getByRole('textbox', { name: '필요 역량', exact: true })
          await input.fill('F'.repeat(200))
          await input.press('Enter')
          await checkBounds(page, `${label} 긴 역량 칩`)
          flowsChecked++
        }
      }
      console.log(`PASS ${width}x${height}: ${checkedPaths.length}개 경로 및 검색·하단 입력·상세 왕복·초기화`)
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    sessionAccount = null
    await page.evaluate(key => localStorage.removeItem(key), sessionHintKey)
    await page.goto(origin + '/')
    const staticTitle = page.getByRole('heading', { level: 1, name: '우리 회사에 맞는 지원사업, AI와 함께 무료로 찾아보세요.', exact: true })
    await staticTitle.waitFor()
    const staticStyles = await staticTitle.locator('span').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node)
      return { animation: style.animationName, opacity: style.opacity, color: style.color, visibility: style.visibility }
    }))
    assert(staticStyles.length > 3, '완성된 제목과 글자 요소가 존재해야 함')
    for (const style of staticStyles) {
      assert.equal(style.animation, 'none', '동작 줄이기에서는 제목 애니메이션 비활성화')
      assert.equal(style.opacity, '1', '동작 줄이기에서는 제목을 즉시 표시')
      assert.equal(style.visibility, 'visible', '동작 줄이기에서는 모든 글자를 표시')
      assert.notEqual(style.color, 'rgba(0, 0, 0, 0)', '동작 줄이기에서도 제목 색상 유지')
    }
    await checkBounds(page, '동작 줄이기 소개 화면')
    const homeInput = page.getByRole('textbox', { name: '지원사업 검색어' })
    await homeInput.fill('서울 SW 지원금')
    await page.getByRole('button', { name: '검색 전송', exact: true }).click()
    await page.getByRole('button', { name: '이 조건으로 검색', exact: true }).waitFor()
    const beforeLogo = { ...calls }
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      page.getByRole('link', { name: 'GovBiz 홈으로', exact: true }).click(),
    ])
    await staticTitle.waitFor()
    assert.equal(new URL(page.url()).pathname, '/')
    assert.equal(new URL(page.url()).search, '')
    assert.equal(await homeInput.inputValue(), '', '홈 로고는 초안·대화를 초기화')
    assert.equal(await page.getByRole('button', { name: '이 조건으로 검색', exact: true }).count(), 0)
    assert.deepEqual(calls, beforeLogo, '홈 이동이 검색·해석·답변을 자동 실행하지 않음')
    await page.goto(origin + '/pricing')
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      page.getByRole('link', { name: 'GovBiz 홈으로', exact: true }).click(),
    ])
    await staticTitle.waitFor()
    assert.equal(new URL(page.url()).pathname, '/', '다른 공개 화면에서도 로고는 홈으로 이동')
    assert.deepEqual(errors, [], '브라우저 미처리 오류')
    console.log(JSON.stringify({ pagesChecked, flowsChecked, mockedCalls: calls, unhandledErrors: errors.length, realApiCalls: 0 }))
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
