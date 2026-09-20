import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Documentation artwork only. No application configuration, database, or paid API access.
const root = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(root, 'icons');
const devicon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@v2.17.0';
const names = ['git', 'github', 'githubactions', 'pnpm', 'gradle', 'pytest', 'docker',
  'react', 'typescript', 'vitejs', 'kotlin', 'fastapi', 'python', 'mysql', 'redis',
  'rabbitmq', 'elasticsearch', 'chrome', 'firefox', 'safari'];
const sources = [
  ...names.map(name => ({name, file: `${name}.svg`, url: `${devicon}/icons/${name}/${name}-original.svg`})),
  {name: 'springboot', file: 'springboot.svg', url: 'https://spring.io/img/projects/spring-boot.svg'},
  {name: 'qdrant', file: 'qdrant.svg', url: 'https://qdrant.tech/img/brand-resources-logos/qdrant-brandmark-red.svg'},
  {name: 'mybatis', file: 'mybatis.png', url: 'https://mybatis.org/images/mybatis-logo.png'},
  {name: 'openai', file: 'openai.svg', url: 'https://cdn.jsdelivr.net/npm/simple-icons@14.15.0/icons/openai.svg'},
];

if (process.argv.includes('--download-icons')) {
  await fs.mkdir(iconsDir, {recursive: true});
  // Explicit public brand assets only. Downloaded artwork is preserved byte-for-byte.
  for (let i = 0; i < sources.length; i += 5) {
    await Promise.all(sources.slice(i, i + 5).map(async asset => {
      const response = await fetch(asset.url, {signal: AbortSignal.timeout(30_000)});
      if (!response.ok) throw new Error(`${asset.name}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (asset.file.endsWith('.svg')) {
        const text = bytes.toString('utf8');
        if (!/<svg[\s>]/i.test(text) || /<(script|foreignObject)\b|\son\w+\s*=/i.test(text)) {
          throw new Error(`Invalid SVG asset: ${asset.name}`);
        }
        if (/(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(text)) {
          throw new Error(`Unexpected external reference: ${asset.name}`);
        }
      } else if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new Error(`Invalid PNG asset: ${asset.name}`);
      }
      await fs.writeFile(path.join(iconsDir, asset.file), bytes);
      console.log(`Downloaded ${asset.name}`);
    }));
  }
  for (const [file, url] of [
    ['DEVICON-LICENSE', `${devicon}/LICENSE`],
    ['SIMPLE-ICONS-LICENSE', 'https://cdn.jsdelivr.net/npm/simple-icons@14.15.0/LICENSE.md'],
  ]) {
    const response = await fetch(url, {signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error(`License download failed: ${file}`);
    await fs.writeFile(path.join(root, file), await response.text());
  }
}

const assets = new Map();
const hashes = [];
for (const asset of sources) {
  const bytes = await fs.readFile(path.join(iconsDir, asset.file));
  const mime = asset.file.endsWith('.png') ? 'image/png' : 'image/svg+xml';
  assets.set(asset.name, `data:${mime};base64,${bytes.toString('base64')}`);
  hashes.push({...asset, sha256: createHash('sha256').update(bytes).digest('hex')});
}
await fs.writeFile(path.join(root, 'logo-sources.json'), JSON.stringify(hashes, null, 2) + '\n');

const W = 2100;
const H = 1520;
const parts = [];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const palette = {ink: '#172B3A', muted: '#526675', line: '#788D9B', border: '#D3DEE5', orange: '#C77B20'};
function text(x, y, value, {size = 22, weight = 400, fill = palette.ink, anchor = 'start', max = 2000, spacing = 0} = {}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${spacing}" data-max-width="${max}">${esc(value)}</text>`);
}
function card(x, y, w, h, {fill = '#FFFFFF', stroke = palette.border, dash = '', radius = 25} = {}) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`);
}
function icon(name, x, y, w, h = w) {
  parts.push(`<image data-brand="${name}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" href="${assets.get(name)}"/>`);
}
function edge(d, {both = false, dash = false, color = palette.line} = {}) {
  const marker = dash ? 'arrow-orange' : 'arrow';
  parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${marker})" ${both ? `marker-start="url(#${marker})"` : ''} ${dash ? 'stroke-dasharray="8 7"' : ''}/>`);
}
function label(x, y, value, {size = 18, fill = palette.muted, max = 300} = {}) {
  text(x, y, value, {size, fill, anchor: 'middle', max});
}

parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title description">
<title id="title">GovBiz 시스템 아키텍처</title>
<desc id="description">현재 저장소의 Docker Compose 개발 구성. 브라우저에서 React/Vite를 거쳐 Spring Boot Core API로 요청하며 Core는 MySQL, Redis, Elasticsearch, RabbitMQ, FastAPI 및 공식 공고 API에 연결한다. Elasticsearch는 Nori·BM25 키워드 검색을 담당하고, FastAPI는 Qdrant 의미 검색과 OpenAI를 사용한다. Core는 키워드·의미 검색 순위를 RRF로 결합한다. RabbitMQ 리포트 소비자는 Core 내부에 있다. Git push와 pull request는 GitHub Actions 검증을 실행하지만 자동 CD는 없다. 그림은 저장소의 구현과 설정 기준이며 현재 실행·배포 완료를 의미하지 않는다.</desc>
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9 Z" fill="${palette.line}"/></marker>
  <marker id="arrow-orange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9 Z" fill="${palette.orange}"/></marker>
</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>
`);

text(78, 93, 'GovBiz', {size: 56, weight: 700});
text(295, 91, '시스템 아키텍처', {size: 34, weight: 600});
text(80, 132, '공식 공고 검색 · AI 추천 · 근거 기반 답변', {size: 23, fill: palette.muted});
text(2020, 86, 'DOCKER COMPOSE / DEVELOPMENT', {size: 18, weight: 600, anchor: 'end', spacing: 1.3});
text(2020, 119, '2026.09.12 · 현재 저장소 기준', {size: 19, fill: palette.muted, anchor: 'end'});
parts.push('<path d="M80 163H2020" stroke="#E4EBF0" stroke-width="2"/>');

// Development and CI: deliberately no automatic deployment edge from Actions.
text(316, 207, '개발 및 검증', {size: 19, weight: 600, fill: palette.muted});
card(315, 240, 220, 155, {fill: '#FFF9F5', stroke: '#EBD8CA'});
icon('git', 338, 271, 62);
text(418, 293, '개발자', {size: 27, weight: 600, max: 100});
text(419, 330, '로컬 Git', {size: 20, fill: palette.muted, max: 100});
card(675, 240, 250, 155, {fill: '#F8FAFC'});
icon('github', 696, 266, 77);
text(790, 304, 'GitHub', {size: 31, weight: 600, max: 121});
text(790, 341, '소스 저장소', {size: 19, fill: palette.muted, max: 121});
card(1100, 220, 600, 205, {fill: '#F5F8FE', stroke: '#C9D9EF'});
icon('githubactions', 1128, 247, 61);
text(1210, 290, 'GitHub Actions', {size: 34, weight: 600, max: 450});
text(1130, 335, '테스트 · 빌드 · 컨테이너 통합 검증', {size: 22, max: 535});
icon('pnpm', 1130, 366, 30); text(1170, 388, 'pnpm', {size: 19});
icon('gradle', 1286, 364, 39); text(1335, 388, 'Gradle', {size: 19});
icon('pytest', 1452, 365, 31); text(1494, 388, 'pytest', {size: 19});
edge('M535 315H675'); label(605, 297, 'git push', {max: 125});
edge('M925 315H1100'); label(1012, 297, 'CI · push / PR', {max: 161});
text(1700, 456, 'CI만 구성 · 자동 CD 없음', {size: 18, fill: palette.muted, anchor: 'end'});
edge('M425 395V500');
text(445, 446, '수동 실행 · 갱신', {size: 19, fill: palette.muted});
text(445, 477, 'docker compose up --build', {size: 17, fill: palette.muted});

// Container boundary. Logo is an actual Docker asset, not a generated approximation.
card(285, 500, 1415, 885, {fill: '#F7FAFC', stroke: '#C2D6E4', radius: 34});
icon('docker', 318, 516, 72, 60);
text(410, 560, 'Docker Compose', {size: 34, weight: 600});
text(1656, 557, '로컬 개발 환경 · 내부 서비스 네트워크', {size: 19, fill: palette.muted, anchor: 'end', max: 525});

// Connections are placed behind cards and routed through open gutters.
edge('M665 680H695V856H725', {both: true});
text(668, 802, '키워드 색인 · 검색', {size: 18, fill: palette.muted, anchor: 'end', max: 260});
edge('M575 995H725', {both: true});
label(650, 977, '/api/*', {max: 138});
label(650, 1026, '요청 / 응답', {size: 17, max: 138});
edge('M1100 971H1255', {both: true});
label(1178, 953, 'HTTP', {max: 140});
label(1178, 1001, '내부 API', {size: 17, max: 140});
edge('M865 835V755', {both: true});
text(885, 803, '결과 복원 · 30분', {size: 18, fill: palette.muted, max: 210});
edge('M1045 835V790H1175V680H1255', {both: true});
label(1120, 778, 'SQL · MyBatis', {size: 17, max: 132});
edge('M1100 872H1205V806H1740V680H1810', {both: true});
label(1484, 792, '공고 수집 · 공식 원문 조회', {size: 18, max: 345});
edge('M1620 977H1810', {both: true});
label(1715, 959, 'HTTPS', {max: 166});
edge('M1438 1130V1225', {both: true});
text(1463, 1183, '벡터 저장 · 검색', {size: 18, fill: palette.muted, max: 198});
edge('M912 1130V1225', {both: true});
text(936, 1183, '작업 발행 · 소비', {size: 18, fill: palette.muted, max: 215});

card(335, 605, 330, 150, {fill: '#FFFBEF', stroke: '#E6DCAE'});
icon('elasticsearch', 358, 629, 52);
text(425, 662, 'Elasticsearch', {size: 28, weight: 600, max: 218});
text(359, 708, 'Nori · BM25 키워드 검색', {size: 21, max: 282});
text(359, 738, '공고 검색 색인 · :9200', {size: 18, fill: palette.muted, max: 282});

card(725, 605, 375, 150, {fill: '#FFF5F4', stroke: '#EAC9C5'});
icon('redis', 750, 628, 64);
text(835, 661, 'Redis', {size: 34, weight: 600});
text(749, 708, '로그인 전 검색 결과 · 조건', {size: 21, max: 330});
text(749, 738, '고정 TTL 30분', {size: 18, fill: palette.muted, max: 330});

card(1255, 605, 365, 150, {fill: '#EEF6FF', stroke: '#C4D8ED'});
icon('mysql', 1278, 620, 78, 70);
text(1371, 661, 'MySQL', {size: 35, weight: 600});
text(1279, 709, '공고 · 계정 · 대화 · 리포트', {size: 21, max: 320});
text(1279, 738, '영속 데이터 · 트랜잭션', {size: 18, fill: palette.muted, max: 320});

card(335, 875, 240, 255, {fill: '#F0FCF7', stroke: '#B8DEC9'});
text(358, 908, 'FRONTEND', {size: 17, weight: 600, fill: '#3E7063', spacing: 1.5});
icon('react', 356, 932, 71);
text(440, 979, 'React', {size: 32, weight: 600, max: 121});
icon('typescript', 358, 1025, 28); text(398, 1047, 'TypeScript', {size: 20, max: 151});
icon('vitejs', 356, 1075, 31); text(398, 1099, 'Vite 개발 서버', {size: 19, max: 157});

card(725, 835, 375, 295, {fill: '#F0F8EC', stroke: '#C4DBB5'});
text(749, 869, 'CORE API · :8080', {size: 17, weight: 600, fill: '#587449', spacing: 1.0});
icon('springboot', 748, 892, 65);
text(830, 937, 'Spring Boot', {size: 32, weight: 600, max: 245});
icon('kotlin', 750, 975, 29); text(790, 998, 'Kotlin', {size: 20, max: 90});
icon('mybatis', 910, 967, 161, 41);
text(749, 1048, '검색 · 계정 · 대화 · RAG', {size: 21, max: 330});
text(749, 1080, '키워드 + 의미 검색 결합 · RRF', {size: 19, fill: palette.muted, max: 330});
text(749, 1110, '스케줄러 / 리포트 소비자', {size: 18, fill: palette.muted, max: 330});

card(1255, 835, 365, 295, {fill: '#F0FAFA', stroke: '#BEDDD9'});
text(1279, 869, 'AI SERVICE · :8000', {size: 17, weight: 600, fill: '#387C75', spacing: 1.0});
icon('fastapi', 1278, 892, 66);
text(1360, 937, 'FastAPI', {size: 34, weight: 600, max: 232});
icon('python', 1280, 975, 32); text(1325, 999, 'Python', {size: 21});
text(1279, 1048, '조건 해석 · 추천 점수화', {size: 21, max: 320});
text(1279, 1085, '임베딩 · 근거 답변', {size: 21, max: 320});

card(725, 1225, 375, 130, {fill: '#FFF8ED', stroke: '#DCA353'});
icon('rabbitmq', 750, 1250, 56);
text(824, 1276, 'RabbitMQ', {size: 31, weight: 600, max: 247});
text(824, 1310, '일일 리포트 생성 큐', {size: 19, max: 250});

card(1255, 1225, 365, 130, {fill: '#FCF3F7', stroke: '#E9C4D2'});
icon('qdrant', 1280, 1256, 62);
text(1364, 1277, 'Qdrant', {size: 34, weight: 600, max: 230});
text(1364, 1314, '공고 · 근거 벡터', {size: 20, max: 230});

// Outside the local Compose network.
text(1810, 551, 'EXTERNAL SERVICES', {size: 17, weight: 600, fill: palette.muted, spacing: 1.1, max: 245});
card(1810, 595, 245, 200, {fill: '#FAF9F5', stroke: '#E1DCD0'});
text(1933, 639, '공식 공고 API', {size: 27, weight: 600, anchor: 'middle', max: 210});
label(1933, 681, '기업마당 · K-Startup', {size: 20, max: 215});
label(1933, 721, '과기정통부 · 충남 공지', {size: 19, max: 215});
label(1933, 765, '제공처별 설정에 따라 사용', {size: 16, max: 215});

card(1810, 875, 245, 255, {fill: '#FFFFFF', stroke: '#C9D4DB'});
icon('openai', 1891, 902, 84);
text(1933, 1031, 'OpenAI', {size: 35, weight: 600, anchor: 'middle', max: 210});
label(1933, 1076, '임베딩 · LLM API', {size: 20, max: 210});

text(131, 873, '사용자', {size: 28, weight: 600, anchor: 'middle'});
icon('chrome', 104, 905, 53);
icon('firefox', 104, 983, 53);
icon('safari', 104, 1061, 53);
text(131, 1152, '브라우저', {size: 21, fill: palette.muted, anchor: 'middle'});
edge('M184 997H335', {both: true});
label(259, 979, 'HTTP :5173', {size: 17, max: 135});

parts.push('<path d="M80 1422H2020" stroke="#E4EBF0" stroke-width="2"/>');
text(80, 1460, '저장소의 구현·설정 기준 · 실제 실행·배포 상태는 별도 확인', {size: 19, fill: palette.muted, max: 1100});
text(2020, 1460, '현재 자동 CD · AWS 배포 없음', {size: 19, fill: palette.muted, anchor: 'end', max: 690});
text(80, 1493, '주요 서비스 경로 기준 · OAuth / SMTP 등 보조 연동은 생략 · 기술 로고는 각 소유자의 자산이며 식별 목적으로 사용', {size: 16, fill: palette.muted, max: 1900});
parts.push('</svg>');

const svg = parts.join('\n');
const svgPath = path.join(root, 'govbiz-architecture.svg');
await fs.writeFile(svgPath, svg);
console.log(`Created ${svgPath}`);

if (process.argv.includes('--render')) {
  const require = createRequire(import.meta.url);
  const modulePath = process.env.GOVBIZ_DIAGRAM_NODE_MODULES;
  const {chromium} = require(modulePath ? path.join(modulePath, 'playwright') : 'playwright');
  const browser = await chromium.launch({headless: true,
    ...(process.env.GOVBIZ_DIAGRAM_CHROME ? {executablePath: process.env.GOVBIZ_DIAGRAM_CHROME} : {})});
  try {
    const context = await browser.newContext({viewport: {width: W, height: H}, deviceScaleFactor: 2});
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(`<html><head><meta charset="utf-8"><style>body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('image')].map(img => new Promise((resolve, reject) => {
        const asset = new Image(); asset.onload = resolve; asset.onerror = reject; asset.src = img.getAttribute('href');
      })));
    });
    const errors = await page.evaluate(({W, H}) => [...document.querySelectorAll('svg text')].flatMap(node => {
      const b = node.getBBox();
      const limit = Number(node.dataset.maxWidth);
      return b.width > limit || b.x < 0 || b.y < 0 || b.x + b.width > W || b.y + b.height > H
        ? [{text: node.textContent, width: b.width, limit, x: b.x, y: b.y}] : [];
    }), {W, H});
    if (errors.length) throw new Error(`Text bounds failed: ${JSON.stringify(errors)}`);
    const png = path.join(root, 'govbiz-architecture.png');
    await page.screenshot({path: png, fullPage: true});
    console.log(`Created ${png} (4200 × 3040); text bounds and all ${assets.size} logos verified`);
  } finally {
    await browser.close();
  }
}
