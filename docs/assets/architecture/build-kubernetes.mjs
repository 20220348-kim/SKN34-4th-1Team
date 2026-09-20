import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Documentation only. No cluster, registry, secret or paid API is accessed.
const root = path.dirname(fileURLToPath(import.meta.url));
const basename = 'govbiz-kubernetes-architecture';
const used = new Set(['git', 'github', 'githubactions', 'docker', 'react', 'vitejs',
  'chrome', 'springboot', 'fastapi', 'mysql', 'redis', 'elasticsearch', 'qdrant']);
const existing = JSON.parse(await fs.readFile(path.join(root, 'logo-sources.json'), 'utf8'));
const extra = ['kubernetes', 'argocd', 'helm', 'django'].map(name => ({
  name, file: `${name}.svg`,
  url: `https://raw.githubusercontent.com/devicons/devicon/v2.17.0/icons/${name}/${name}-${name === 'django' ? 'plain' : 'original'}.svg`,
}));
const icons = new Map(), manifest = [];
for (const source of [...existing.filter(asset => used.has(asset.name)), ...extra]) {
  const bytes = await fs.readFile(path.join(root, 'icons', source.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (source.sha256 && source.sha256 !== sha256) throw new Error(`Logo hash mismatch: ${source.name}`);
  const svg = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(svg) || /<(script|foreignObject)\b|\son\w+\s*=/i.test(svg)
      || /(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)) throw new Error(`Unsafe SVG: ${source.name}`);
  icons.set(source.name, `data:image/svg+xml;base64,${bytes.toString('base64')}`);
  manifest.push({...source, sha256});
}

const W = 2820, H = 2000;
const ink = '#172B3A', muted = '#526675', line = '#7A8E9C', deploy = '#AD6C1C', config = '#9BA9B5';
const p = [];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
function text(x, y, value, {size = 23, weight = 400, fill = ink, anchor = 'start', max = 2500} = {}) {
  p.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" data-max-width="${max}">${esc(value)}</text>`);
}
function card(x, y, w, h, fill = '#FFFFFF', stroke = '#D3DEE5', r = 22) {
  p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
}
function icon(name, x, y, w, h = w) {
  if (!icons.has(name)) throw new Error(`Unknown logo: ${name}`);
  p.push(`<image data-brand="${name}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" href="${icons.get(name)}"/>`);
}
function edge(d, mode = 'runtime', both = false) {
  const color = mode === 'deploy' ? deploy : mode === 'config' ? config : line;
  p.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"${mode !== 'runtime' ? ' stroke-dasharray="9 7"' : ''} marker-end="url(#${mode})"${both ? ` marker-start="url(#${mode})"` : ''}/>`);
}
function label(x, y, value, max = 350, color = muted) {
  text(x, y, value, {size: 19, max, anchor: 'middle', fill: color});
}
function badge(x, y, w, value, amber = false) {
  card(x, y, w, 37, amber ? '#FFF3DF' : '#EDF8F1', amber ? '#E5C590' : '#BDDAC8', 11);
  text(x + w / 2, y + 26, value, {size: 19, weight: 600, anchor: 'middle', max: w - 18, fill: amber ? '#925B16' : '#256B49'});
}

p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">GovBiz 현재 로컬 Kubernetes · 비공개 GHCR · Argo CD 아키텍처</title>
<desc id="desc">2026-09-20 Mac portfolio 구성. GitHub CI와 비공개 이미지 발행, infra digest 갱신 설정, Argo CD 자동 반영, 독립 Core·Catalog·AI·Ops 서비스와 DB. 승격 schedule의 실제 실행은 미확인. 웹은 Mac Vite이며 외부 API·유료 AI는 비활성. 과거 AWS 구성과 구분한다.</desc>
<defs>${[['runtime',line],['deploy',deploy],['config',config]].map(([id,color]) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${color}"/></marker>`).join('')}</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>`);
text(80, 95, 'GovBiz', {size: 56, weight: 700});
text(305, 93, '현재 시스템 아키텍처', {size: 35, weight: 600});
text(80, 145, '애플리케이션 모노레포 · 서비스별 배포 / DB 분리 · Mac에서 실행하는 포트폴리오 환경', {size: 24, fill: muted});
card(2205, 53, 530, 63, '#EDF8F1', '#BDDAC8', 17);
text(2470, 95, 'Kubernetes + GitOps · 로컬 구축', {size: 27, weight: 600, anchor: 'middle', max: 500, fill: '#256B49'});
text(2735, 148, '2026.09.20 · 실행 확인 / 설정 / 미검증 범위 구분', {size: 19, fill: muted, anchor: 'end', max: 600});
p.push('<path d="M80 182H2740" stroke="#E4EBF0" stroke-width="2"/>');

// Remote control plane. Artifact selection is NOT a registry-to-Git trigger.
card(80, 214, 2660, 425, '#F8FAFD', '#D2DFEB', 30);
text(110, 252, 'GITHUB · 소스 / 검증 / 이미지 / 배포 설정', {size: 23, weight: 600, fill: muted});
const top = 304;
card(110, top, 430, 226, '#FFFFFF');
icon('git', 137, 332, 47); icon('github', 200, 331, 50);
text(272, 366, 'GovBiz-Team/GovBiz', {size: 24, weight: 600, max: 245});
text(137, 420, 'develop push → CI', {size: 28, weight: 600, max: 376});
text(137, 464, 'frontend: web · mobile · shared', {size: 21, max: 376});
text(137, 500, 'backend: Core · Catalog · AI · Ops', {size: 21, max: 376});
card(635, top, 550, 226, '#F1F6FE', '#C5D8F0');
icon('githubactions', 660, 329, 54); text(735, 369, 'GitHub Actions', {size: 34, weight: 600, max: 420});
text(660, 421, '동일 SHA의 3개 CI 검증 통과', {size: 27, weight: 600, max: 490});
text(660, 464, '서비스별 이미지 빌드 / 변경 없으면 재사용', {size: 22, max: 500});
text(660, 500, 'MSA image candidates · release artifact', {size: 21, fill: muted, max: 500});
edge('M540 419H635', 'deploy'); label(588, 398, 'push', 76, deploy);
card(1280, top, 410, 226, '#F5F1FB', '#D8C9E8');
icon('github', 1305, 332, 52); text(1375, 369, 'GHCR · Private', {size: 32, weight: 600, max: 285});
text(1305, 421, '4개 서비스 이미지', {size: 27, weight: 600, max: 360});
text(1305, 463, 'ghcr.io/govbiz-team/govbiz-*', {size: 21, max: 360});
text(1305, 500, '불변 digest로 배포 버전 고정', {size: 22, fill: muted, max: 360});
edge('M1185 419H1280', 'deploy'); label(1232, 398, 'push', 75, deploy);
card(1800, top, 430, 226, '#FFF8EB', '#E5C590');
text(1825, 352, 'Portfolio image promotion', {size: 26, weight: 600, max: 380});
text(1825, 399, '검증된 release → digest 선택', {size: 23, max: 380});
text(1825, 437, 'infra workflow · 10분 schedule 설정', {size: 21, max: 380});
badge(1825, 469, 380, '수동 시작 검증 · schedule 미확인', true);
edge('M910 304V279H2015V304', 'deploy');
card(1230, 262, 422, 31, '#F8FAFD', '#F8FAFD', 4); label(1441, 286, 'CI 결과 + 검증 artifact 조회', 400, deploy);
card(2325, top, 385, 226, '#F1F9F5', '#C1DECE');
icon('helm', 2350, 332, 52); text(2420, 367, 'GovBiz-infra', {size: 30, weight: 600, max: 262});
text(2350, 421, 'develop · 배포 설정 저장소', {size: 24, weight: 600, max: 335});
text(2350, 464, 'Helm chart + 서비스별 values', {size: 21, max: 335});
text(2350, 500, '검증 후 digest 자동 커밋', {size: 22, fill: muted, max: 335});
edge('M2230 419H2325', 'deploy'); label(2277, 398, 'commit', 83, deploy);
text(110, 586, 'Git에는 소스·Helm·digest만 저장합니다. 이미지 본체는 GHCR, 런타임 비밀값은 Kubernetes Secret에 있습니다.', {size: 23, fill: muted, max: 2570});

// Host boundary: the browser and Vite are NOT Kubernetes Deployments.
card(80, 701, 2660, 1120, '#F7FAFD', '#BED3E5', 32);
icon('docker', 109, 725, 73, 52); text(201, 767, '사용자 Mac · Docker Desktop', {size: 34, weight: 600});
text(110, 809, 'Mac / Docker가 켜져 있을 때 실행 · 단일 노드 · 외부 공개 운영 환경 아님', {size: 22, fill: muted, max: 1750});
badge(2280, 738, 420, '4개 서비스 · Synced / Healthy');
card(110, 877, 425, 360, '#FFFFFF', '#CBD9E5');
icon('chrome', 141, 905, 53); text(212, 943, '브라우저', {size: 30, weight: 600});
text(140, 986, 'http://localhost:5173', {size: 27, weight: 600, max: 367});
edge('M323 1010V1050', 'runtime', true);
icon('react', 141, 1078, 53); icon('vitejs', 213, 1080, 47);
text(140, 1170, 'React / Vite · pnpm dev:k8s', {size: 25, weight: 600, max: 365});
text(140, 1209, 'Mac 개발 서버 · /api 동일 출처 프록시', {size: 21, fill: muted, max: 365});
card(110, 1310, 425, 160, '#EDF8F5', '#C1DECE');
text(140, 1357, 'kubectl port-forward', {size: 28, weight: 600, max: 365});
text(140, 1400, '127.0.0.1:18080 → Core :8080', {size: 24, max: 365});
text(140, 1439, 'loopback 전용 · Ingress / 공개 TLS 없음', {size: 20, fill: muted, max: 365});
edge('M323 1237V1310'); label(391, 1282, '/api/*', 120);
card(110, 1550, 425, 225, '#F9F7F2', '#DED8CA');
text(140, 1598, '무료 데모 시연', {size: 29, weight: 600});
text(140, 1645, '가상 공고 8건 · 일반 회원 2개', {size: 24, max: 365});
text(140, 1685, '기업·모집글 각 2개 · 로그인 확인', {size: 23, max: 365});
text(140, 1735, '기존 Compose 데이터는 보존·중지', {size: 21, fill: muted, max: 365});

card(603, 855, 2100, 923, '#FFFFFF', '#B8D0E7', 28);
icon('kubernetes', 630, 873, 51); text(700, 912, 'Kubernetes · kind / govbiz-portfolio', {size: 30, weight: 600, max: 1110});
text(2667, 912, 'Service DNS · ClusterIP · 독립 Deployment', {size: 22, fill: muted, anchor: 'end', max: 620});

// Data dependencies and control plane. No false Argo-to-GHCR pull arrow.
card(650, 956, 420, 151, '#FFF5F3', '#E5CBC7');
icon('redis', 675, 980, 51); text(747, 1016, 'Redis', {size: 32, weight: 600});
text(675, 1061, 'Core 검색 결과·조건 복원용', {size: 22, max: 370});
text(675, 1090, '현재 데모: AI 검색 / 복원 미사용', {size: 18, fill: muted, max: 370});
card(1160, 956, 420, 151, '#FFFBEE', '#E3D69F');
icon('elasticsearch', 1185, 980, 50); text(1251, 1016, 'Elasticsearch', {size: 30, weight: 600, max: 300});
text(1185, 1061, 'Core 조회 · Catalog 색인 소유', {size: 22, max: 370});
text(1185, 1090, '현재 데모: 수집·색인 비활성', {size: 18, fill: muted, max: 370});
card(1670, 956, 420, 151, '#F5F8FC', '#C5D8E8');
icon('kubernetes', 1695, 977, 49); text(1765, 1017, 'kubelet · image pull', {size: 26, weight: 600, max: 300});
text(1695, 1061, 'imagePullSecret: ghcr-pull', {size: 23, max: 370});
text(1695, 1090, 'PAT read:packages · 비공개 pull 확인', {size: 18, fill: muted, max: 370});
card(2180, 956, 475, 151, '#FFF5ED', '#E7C7AD');
icon('argocd', 2205, 977, 55); text(2280, 1016, 'Argo CD Core', {size: 31, weight: 600, max: 345});
text(2205, 1061, 'argocd namespace · 4 Applications', {size: 23, max: 425});
text(2205, 1090, 'auto-sync + self-heal · prune OFF', {size: 19, fill: muted, max: 425});
edge('M1485 530V661H1880V956', 'deploy'); label(2100, 683, '이미지 다운로드 · Argo CD가 아닌 kubelet이 수행', 690, deploy);
edge('M2517 530V661H2720V930H2417V956', 'deploy');
card(2415, 650, 250, 34, '#FFFFFF', '#FFFFFF', 3); label(2540, 675, 'Git pull · Helm 렌더', 240, deploy);
// The resource header represents all four releases, not only Ops.
card(650, 1160, 2005, 49, '#EFF5FD', '#C8DAED', 12);
text(676, 1193, 'namespace: govbiz-msa  ·  4개의 독립 Helm release / Deployment / ClusterIP Service', {size: 24, weight: 600, max: 1800});
edge('M2417 1107V1160', 'deploy'); label(2260, 1141, 'Git 상태 자동 반영', 275, deploy);

// Runtime ownership is explicit: no service reads another service's SQL DB.
const services = [
  {x:650, name:'core-service · :8080', logo:'springboot', tech:'Spring Boot / Kotlin', fill:'#F2F9EE', stroke:'#C5DDBC', lines:['회원 · 기업 · 파트너 · 공고 조회','Catalog snapshot의 조회용 복제본','개발 로그인 OFF · 일반 로그인 검증']},
  {x:1160, name:'catalog-service · :8081', logo:'springboot', tech:'Spring Boot / Kotlin', fill:'#F2F9EE', stroke:'#C5DDBC', lines:['공고 원본 · 수집 / 색인 소유','Core에 인증된 snapshot 제공','현재: 데모 원본 · 외부 수집 OFF']},
  {x:1670, name:'ai-service · :8000', logo:'fastapi', tech:'FastAPI / Python', fill:'#EFF9F9', stroke:'#BBDDDD', lines:['해석 · 임베딩 · 문서 / 근거 답변','Core·Catalog가 내부 HTTP 호출','현재: 서비스 기동 · 유료 AI OFF']},
  {x:2180, name:'ops-service · :8000', logo:'django', tech:'Django / Gunicorn', fill:'#F1F8F5', stroke:'#C2DACD', lines:['독립 프로세스 · 전용 DB · health','관리자 인증 / LLMOps 업무는 후속','Core와 관리자 DB 공유 안 함']},
];
for (const s of services) {
  card(s.x, 1265, 420, 244, s.fill, s.stroke);
  text(s.x + 23, 1303, s.name, {size: 24, weight: 600, max: 375});
  icon(s.logo, s.x + 23, 1324, 46);
  text(s.x + 83, 1358, s.tech, {size: 25, weight: 600, max: 313});
  s.lines.forEach((value, i) => text(s.x + 23, 1403 + i * 36, value, {size: i === 2 ? 19 : 22, fill: i === 2 ? muted : ink, max: 374}));
}
edge('M535 1390H650'); label(592, 1368, 'HTTP', 92);
edge('M1070 1380H1160', 'runtime', true); label(1115, 1340, 'snapshot', 85); label(1115, 1362, '인증 HTTP', 88);
edge('M955 1265V1233H1880V1265', 'config'); label(1510, 1254, 'Core → AI · 설정된 경로 / 유료 기능 OFF', 610, config);
edge('M1580 1442H1670', 'config'); label(1625, 1420, '색인 OFF', 88, config);

const databases = [
  [650, 'mysql', 'Core MySQL 8.4', 'govbiz_core · 계정 / 기업 / 조회 복제본'],
  [1160, 'mysql', 'Catalog MySQL 8.4', 'govbiz_catalog · 공고 원본 / 발행 상태'],
  [1670, 'qdrant', 'Qdrant', '벡터 저장소 · 현재 데모 색인 없음'],
  [2180, 'mysql', 'Ops MySQL 8.4', 'govbiz_ops · Ops 전용'],
];
for (const [x, logo, title, description] of databases) {
  edge(`M${x+210} 1509V1563`, logo === 'qdrant' ? 'config' : 'runtime');
  label(x + 285, 1544, logo === 'qdrant' ? '벡터' : 'SQL', 90);
  card(x, 1563, 420, 119, '#F5F9FF', '#C6D9ED');
  icon(logo, x + 22, 1587, 45); text(x + 82, 1617, title, {size: 27, weight: 600, max: 315});
  text(x + 22, 1656, description, {size: 20, max: 378});
}
text(652, 1725, '데이터: 서비스별 사용자·PVC 분리 / 기존 Compose와 별개     비밀값: runtime Secret / Git에 저장 안 함', {size: 23, max: 1960, fill: muted});
text(652, 1760, '현재 비활성: 외부 공고 API · OpenAI · SMTP/OAuth · RabbitMQ 작업 큐     |     Service DNS 사용 · Eureka 없음', {size: 20, max: 1960, fill: muted});

p.push('<path d="M80 1860H2740" stroke="#E4EBF0" stroke-width="2"/>');
edge('M84 1903H145'); text(161, 1911, '실선: 확인된 요청 / 데이터 경로', {size: 21, max: 430});
edge('M645 1903H706', 'deploy'); text(722, 1911, '주황 점선: 이미지 / GitOps 제어 경로', {size: 21, max: 510});
edge('M1290 1903H1351', 'config'); text(1367, 1911, '회색 점선: 설정된 연결 / 현재 미사용', {size: 21, max: 540});
text(80, 1960, '로컬 시연 환경 · AWS / Vercel / ECR / SSM은 현재 경로에 없음 · 스케줄 발동·NetworkPolicy 집행·백업 복원·부하·무중단 검증은 별도', {size: 23, fill: muted, max: 2640});
p.push('</svg>');
const svg = p.join('\n');
await fs.writeFile(path.join(root, `${basename}.svg`), svg);
await fs.writeFile(path.join(root, 'kubernetes-logo-sources.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Created ${basename}.svg`);

if (process.argv.includes('--render')) {
  const require = createRequire(import.meta.url);
  const modulePath = process.env.GOVBIZ_DIAGRAM_NODE_MODULES;
  const {chromium} = require(modulePath ? path.join(modulePath, 'playwright') : 'playwright');
  const browser = await chromium.launch({headless: true,
    ...(process.env.GOVBIZ_DIAGRAM_CHROME ? {executablePath: process.env.GOVBIZ_DIAGRAM_CHROME} : {})});
  try {
    const context = await browser.newContext({viewport:{width:W,height:H},deviceScaleFactor:2});
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(`<html><head><meta charset="utf-8"><style>body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('image')].map(img => new Promise((resolve,reject) => {
        const asset = new Image(); asset.onload = resolve; asset.onerror = reject; asset.src = img.getAttribute('href');
      })));
    });
    const errors = await page.evaluate(({W,H}) => {
      const frame = document.querySelector('svg').getBoundingClientRect();
      return [...document.querySelectorAll('svg text')].flatMap(node => {
        const b = node.getBoundingClientRect(), limit = Number(node.dataset.maxWidth);
        const x = b.left-frame.left, y = b.top-frame.top;
        return b.width>limit || x<0 || y<0 || x+b.width>W || y+b.height>H ? [{text:node.textContent,width:b.width,limit,x,y}] : [];
      });
    }, {W,H});
    if (errors.length) throw new Error(`Text bounds failed: ${JSON.stringify(errors)}`);
    const shown = await page.locator('image').evaluateAll(nodes => new Set(nodes.map(n=>n.dataset.brand)).size);
    if (shown !== icons.size) throw new Error(`Unused logos: ${icons.size-shown}`);
    await page.screenshot({path:path.join(root,`${basename}.png`),fullPage:true});
    console.log(`Created ${basename}.png (${W*2} × ${H*2}); ${shown} logos / text bounds verified; no external requests`);
  } finally { await browser.close(); }
}
