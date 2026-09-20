import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Documentation only: reuse the original diagram's local logos; never contact a cluster or registry.
const root = path.dirname(fileURLToPath(import.meta.url));
const basename = 'govbiz-local-architecture';
const manifest = JSON.parse(await fs.readFile(path.join(root, 'kubernetes-logo-sources.json'), 'utf8'));
manifest.push(JSON.parse(await fs.readFile(path.join(root, 'logo-sources.json'), 'utf8')).find(source => source.name === 'rabbitmq'));
const icons = new Map();
for (const source of manifest) {
  const bytes = await fs.readFile(path.join(root, 'icons', source.file));
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Logo hash mismatch: ${source.name}`);
  const svg = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(svg) || /<(script|foreignObject)\b|\son\w+\s*=/i.test(svg)
      || /(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)) throw new Error(`Unsafe SVG: ${source.name}`);
  icons.set(source.name, `data:image/svg+xml;base64,${bytes.toString('base64')}`);
}

const W = 2820, H = 2250;
const ink = '#172B3A', muted = '#526675';
const colors = {runtime:'#7A8E9C', deploy:'#AD6C1C', config:'#97A6B3', dev:'#2D8570'};
const parts = [];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
function text(x, y, value, {size=23, weight=400, fill=ink, anchor='start', max=2600}={}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" data-max-width="${max}">${esc(value)}</text>`);
}
function card(x, y, w, h, fill='#FFFFFF', stroke='#D3DEE5', radius=22) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
}
function icon(name, x, y, w, h=w) {
  if (!icons.has(name)) throw new Error(`Unknown logo: ${name}`);
  parts.push(`<image data-brand="${name}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" href="${icons.get(name)}"/>`);
}
function edge(d, kind='runtime', both=false) {
  parts.push(`<path d="${d}" fill="none" stroke="${colors[kind]}" stroke-width="3" stroke-linejoin="round"${['deploy','config'].includes(kind)?' stroke-dasharray="9 7"':''} marker-end="url(#${kind})"${both?` marker-start="url(#${kind})"`:''}/>`);
}
function label(x, y, value, max=360, fill=muted) {
  text(x,y,value,{size:19,max,anchor:'middle',fill});
}

parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">GovBiz 개인 포크 기반 로컬 시스템 아키텍처</title>
<desc id="desc">2026-09-21 기준. 교육기관 원본 병합, 개인 포크 main Sync, 네 CI 통과, 비공개 GHCR 이미지 발행, 같은 포크의 Helm digest 갱신, 로컬 kind의 Argo CD 배포. 브라우저는 PC의 Vite에서 port-forward를 거쳐 Core에 연결한다. Core, Catalog, AI, Ops를 독립 실행하며 MySQL 세 개와 Redis, Elasticsearch, Qdrant, RabbitMQ가 있다. 명시적 연결 프로필에서 RabbitMQ, OpenAI, SMTP를 연결했다. 자동 수집과 유료 정기 작업은 예산 보호를 위해 대기하며 OAuth와 Bizno는 미연결이다. 개발 모드는 GitOps와 번갈아 사용한다. 공개 GHCR 전환은 아직 적용하지 않았다.</desc>
<defs>${Object.entries(colors).map(([id,color])=>`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${color}"/></marker>`).join('')}</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>`);
text(80,95,'GovBiz',{size:56,weight:700});
text(305,93,'로컬 시스템 아키텍처',{size:36,weight:600});
text(80,145,'개인 포크 · Kubernetes MSA · GitOps 배포와 로컬 코드 개발을 분리',{size:24,fill:muted});
card(2185,53,550,63,'#EDF8F1','#BDDAC8',17);
text(2460,95,'LOCAL KUBERNETES + GITOPS',{size:25,weight:600,anchor:'middle',max:515,fill:'#256B49'});
text(2735,148,'2026.09.21 · Intel Mac 확인 / Windows WSL2 검증 별도',{size:19,fill:muted,anchor:'end',max:680});
parts.push('<path d="M80 182H2740" stroke="#E4EBF0" stroke-width="2"/>');

// Remote supply chain: promotion consumes verified Actions receipts, not a registry event.
card(80,214,2660,425,'#F8FAFD','#D2DFEB',30);
text(110,252,'원격 GitHub · 병합된 코드를 배포하는 경로',{size:24,weight:600,fill:muted});
card(110,304,430,226);
icon('git',137,330,47); icon('github',200,330,50);
text(270,365,'교육기관 → 내 포크',{size:24,weight:600,max:245});
text(137,420,'upstream PR 병합 → Sync',{size:27,weight:600,max:380});
text(137,464,'ilil1/SKN34-4th-1Team · main',{size:22,max:380});
text(137,500,'소스와 infrastructure/gitops를 함께 관리',{size:20,fill:muted,max:380});
card(635,304,550,226,'#F1F6FE','#C5D8F0');
icon('githubactions',660,329,54); text(735,369,'GitHub Actions',{size:34,weight:600,max:420});
text(660,421,'동일 SHA · 4개 CI 통과',{size:28,weight:600,max:490});
text(660,464,'원본 소스 일치 · 발행 명시적 활성화',{size:23,max:490});
text(660,500,'서비스별 빌드 또는 검증 이미지 재사용',{size:22,fill:muted,max:490});
edge('M540 419H635','deploy'); label(588,397,'main',80,colors.deploy);
card(1280,304,410,226,'#F5F1FB','#D8C9E8');
icon('github',1305,331,52); text(1375,369,'GHCR · Private',{size:32,weight:600,max:285});
text(1305,420,'4개 서비스 이미지 · digest 고정',{size:24,weight:600,max:360});
text(1305,460,'ghcr.io/ilil1/',{size:23,max:360});
text(1305,496,'skn34-4th-1team-*',{size:23,fill:muted,max:360});
edge('M1185 419H1280','deploy'); label(1232,397,'push',78,colors.deploy);
card(1800,304,430,226,'#FFF8EB','#E5C590');
text(1825,352,'Fork image promotion',{size:29,weight:600,max:380});
text(1825,399,'발행 완료 workflow_run',{size:24,max:380});
text(1825,442,'receipt 검증 → 새 digest 기록',{size:23,max:380});
text(1825,491,'기존 소스·CI 검증 조건 유지',{size:22,fill:muted,max:380});
edge('M910 304V279H2015V304','deploy');
card(1220,261,440,32,'#F8FAFD','#F8FAFD',4); label(1440,286,'CI 결과 + 이미지 검증 artifact',415,colors.deploy);
card(2325,304,385,226,'#F1F9F5','#C1DECE');
icon('helm',2350,332,52); text(2420,367,'같은 포크 · main',{size:27,weight:600,max:263});
text(2350,419,'infrastructure/gitops/',{size:24,weight:600,max:335});
text(2350,461,'environments/fork/*.yaml',{size:22,max:335});
text(2350,500,'Helm values에 digest 자동 커밋',{size:21,fill:muted,max:335});
edge('M2230 419H2325','deploy'); label(2277,397,'commit',84,colors.deploy);
text(110,582,'Git: 소스·Helm·digest  |  GHCR: 이미지 본체  |  PC Kubernetes Secret: 런타임 비밀값과 pull 인증',{size:24,fill:muted,max:2570});
text(110,615,'작업 브랜치 push / PC의 git pull만으로 이미지 발행하지 않음 · 공개 전환 코드는 준비됐지만 현재 패키지는 비공개',{size:21,fill:muted,max:2570});

// Local machine: browser and Vite stay outside the kind node.
card(80,701,2660,1425,'#F7FAFD','#BED3E5',32);
icon('docker',109,725,73,52); text(201,767,'내 PC · Docker Desktop',{size:35,weight:600});
text(110,810,'Docker가 실행 중일 때 동작 · 단일 노드 · 외부 공개 운영 환경 아님',{size:23,fill:muted,max:1660});
card(2190,735,510,45,'#EDF8F1','#BDDAC8',12);
text(2445,766,'확인 시점: 4개 서비스 Ready · Argo Healthy',{size:21,weight:600,anchor:'middle',max:485,fill:'#256B49'});
card(110,877,425,360,'#FFFFFF','#CBD9E5');
icon('chrome',141,905,53); text(212,943,'브라우저',{size:30,weight:600});
text(140,986,'http://127.0.0.1:5173',{size:28,weight:600,max:367});
edge('M323 1010V1050','runtime',true);
icon('react',141,1078,53); icon('vitejs',213,1080,47);
text(140,1170,'React / Vite 개발 서버',{size:28,weight:600,max:365});
text(140,1209,'dev:k8s:connected · Vite HMR',{size:22,fill:muted,max:365});
card(110,1320,425,160,'#EDF8F5','#C1DECE');
text(140,1367,'kubectl port-forward',{size:28,weight:600,max:365});
text(140,1410,'127.0.0.1:18080 → Core :8080',{size:24,max:365});
text(140,1449,'loopback 전용 · Ingress / Nginx 없음',{size:20,fill:muted,max:365});
edge('M323 1237V1320'); label(388,1284,'/api/*',125);
card(110,1560,425,240,'#F1F9F5','#C1DECE');
text(140,1606,'개발 / GitOps 모드 선택',{size:27,weight:600,max:365});
text(140,1650,'dev: Argo Application 제거',{size:22,max:365});
text(140,1690,'서비스·DB·PVC는 그대로 보존',{size:22,max:365});
text(140,1730,'로컬 이미지 복원 후 gitops 재개',{size:21,max:365});
text(140,1770,'두 도구가 같은 배포를 덮어쓰지 않음',{size:19,fill:muted,max:365});

// Node, application namespace and data ownership.
card(602,855,2101,980,'#FFFFFF','#BDD3E7',29);
icon('kubernetes',630,880,60); text(712,922,'Kubernetes · kind / govbiz-f218b0ac1c',{size:33,weight:600,max:1180});
text(2653,921,'Service DNS · Eureka 없음',{size:22,fill:muted,anchor:'end',max:510});
text(650,970,'namespace: govbiz-msa  ·  서비스별 Helm release / Deployment / ClusterIP Service',{size:25,weight:600,max:1950});
card(650,1010,420,151,'#FFF5F4','#E9C7C3');
icon('redis',675,1030,52); text(745,1070,'Redis · :6379',{size:30,weight:600,max:300});
text(675,1116,'Core 검색 결과·조건 복원',{size:23,max:370});
text(675,1147,'세션 DB / LLM 응답 캐시 아님',{size:19,fill:muted,max:370});
card(1160,1010,420,151,'#FFFBF0','#E6D596');
icon('elasticsearch',1185,1030,52); text(1255,1070,'Elasticsearch',{size:29,weight:600,max:300});
text(1185,1116,'Core 조회 · Catalog 색인 소유',{size:23,max:370});
text(1185,1147,'Nori / BM25 · :9200 · 자동 색인 OFF',{size:19,fill:muted,max:370});
card(1670,1010,420,151,'#F4F8FD','#C3D7EB');
icon('kubernetes',1695,1030,49); text(1760,1070,'kubelet · image pull',{size:27,weight:600,max:305});
text(1695,1116,'imagePullSecret: ghcr-pull',{size:23,max:370});
text(1695,1147,'PAT read:packages · 4개 이미지',{size:19,fill:muted,max:370});
card(2180,1010,475,151,'#FFF5ED','#E7C7AD');
icon('argocd',2205,1030,55); text(2280,1070,'Argo CD Core',{size:31,weight:600,max:345});
text(2205,1116,'argocd namespace · 4 Applications',{size:23,max:425});
text(2205,1147,'auto-sync + self-heal · prune OFF',{size:19,fill:muted,max:425});
edge('M1485 530V661H1880V1010','deploy');
text(1930,685,'kubelet / 런타임이 이미지 다운로드',{size:19,max:450,fill:colors.deploy});
edge('M2517 530V661H2720V990H2417V1010','deploy');
card(2425,650,240,34,'#FFFFFF','#FFFFFF',3); label(2545,675,'Git 감지 · Helm 렌더',230,colors.deploy);

card(630,1250,2045,291,'#FAFCFE','#E4EBF2',20);
edge('M1880 1161V1250','deploy'); label(1994,1213,'실행 이미지',165,colors.deploy);
edge('M2417 1161V1250','deploy'); label(2518,1213,'4개 배포 apply',190,colors.deploy);
edge('M850 1280V1161'); label(763,1220,'검색 결과·조건',164);
edge('M1040 1280V1190H1370V1161'); label(1210,1182,'키워드 조회',165);
edge('M1470 1280V1161','config'); label(1540,1217,'색인 OFF',110,colors.config);
const services = [
  {x:650,name:'core-service · :8080',logo:'springboot',tech:'Spring Boot / Kotlin',fill:'#F2F9EE',stroke:'#C5DDBC',lines:['회원 · 기업 · 파트너 · 공고 조회','Catalog snapshot → 조회 DB 복제','RabbitMQ 큐 · SMTP 메일 연결']},
  {x:1160,name:'catalog-service · :8081',logo:'springboot',tech:'Spring Boot / Kotlin',fill:'#F2F9EE',stroke:'#C5DDBC',lines:['공고 원본 · 수집 / 색인 소유','Core에 내부 HTTP snapshot 제공','외부 API 수집 / 자동 색인 OFF']},
  {x:1670,name:'ai-service · :8000',logo:'fastapi',tech:'FastAPI / Python',fill:'#EFF9F9',stroke:'#BBDDDD',lines:['문서 · 임베딩 · 추천 / 근거 답변','Core·Catalog가 내부 HTTP 호출','OpenAI 연결 · 자동 유료 작업 대기']},
  {x:2180,name:'ops-service · :8000',logo:'django',tech:'Django / Gunicorn',fill:'#F1F8F5',stroke:'#C2DACD',lines:['관리자 / LLMOps 확장 서비스','전용 DB · 독립 실행 · health','업무·인증 분리 완성 의미 아님']},
];
for (const s of services) {
  card(s.x,1280,420,240,s.fill,s.stroke);
  text(s.x+23,1318,s.name,{size:24,weight:600,max:375});
  icon(s.logo,s.x+23,1337,46); text(s.x+83,1373,s.tech,{size:25,weight:600,max:313});
  s.lines.forEach((value,i)=>text(s.x+23,1418+i*35,value,{size:i===2?19:22,fill:i===2?muted:ink,max:374}));
}
edge('M535 1400H650'); label(592,1378,'HTTP',92);
edge('M1070 1395H1160','runtime',true); label(1115,1354,'snapshot',85); label(1115,1377,'인증 HTTP',88);
edge('M955 1280V1267H1830V1280');
card(1110,1249,595,29,'#FAFCFE','#FAFCFE',3); label(1407,1271,'Core → AI : 내부 인증 HTTP · 요청형 AI 연결',565);
edge('M1580 1457H1670','config'); label(1625,1434,'색인 OFF',88,colors.config);
const databases = [
  [650,'mysql','Core MySQL 8.4','govbiz_core · 계정 / 기업 / 조회 복제본'],
  [1160,'mysql','Catalog MySQL 8.4','govbiz_catalog · 공고 원본 / 발행 상태'],
  [1670,'qdrant','Qdrant · :6333','AI 벡터 저장소 · 외부 색인 비활성'],
  [2180,'mysql','Ops MySQL 8.4','govbiz_ops · Ops 전용'],
];
for (const [x,logo,title,description] of databases) {
  edge(`M${x+210} 1520V1580`,logo==='qdrant'?'config':'runtime');
  label(x+285,1555,logo==='qdrant'?'벡터':'SQL :3306',100);
  card(x,1580,420,125,'#F5F9FF','#C6D9ED');
  icon(logo,x+22,1603,45); text(x+82,1633,title,{size:27,weight:600,max:315});
  text(x+22,1676,description,{size:20,max:378});
}
edge('M650 1485H620V1772H650','runtime',true);
card(650,1730,420,80,'#FFF5ED','#E7C7AD',14);
icon('rabbitmq',670,1747,44);
text(730,1762,'RabbitMQ · :5672',{size:26,weight:600,max:320});
text(730,1796,'Core 비동기 큐 · 내부 전용 · PVC',{size:20,max:320});
text(1120,1752,'데이터: MySQL 3개 + Redis / Elasticsearch / Qdrant / RabbitMQ · StatefulSet + PVC',{size:22,max:1520,fill:muted});
text(1120,1785,'연결 프로필: OpenAI / SMTP ON · 자동 수집·임베딩·문서 분석·리포트는 예산 확인 후',{size:20,max:1520,fill:muted});
text(1120,1815,'OAuth / Bizno 미연결 · DB·Secret·PVC는 Argo 서비스 자동 sync 대상 아님',{size:20,max:1520,fill:muted});

// Alternative local development path; mutually exclusive with Argo ownership.
card(110,1880,2590,206,'#F0F9F5','#BBDDD0',22);
text(140,1920,'개발 모드 · 내 PC의 코드 저장을 반영하는 경로',{size:25,weight:600,fill:colors.dev});
text(2665,1920,'GitOps와 번갈아 사용 · GHCR 업로드 없음',{size:22,fill:colors.dev,anchor:'end',max:670});
const steps = [
  [140,460,'코드 저장','dev.py --watch · 변경 감지'],
  [695,470,'Docker 로컬 빌드','변경 서비스만 이미지 재빌드'],
  [1260,470,'kind load docker-image','자기 PC 클러스터에 이미지 적재'],
  [1825,840,'선택 서비스 rollout','실패 시 직전 이미지 복원 · DB는 되돌리지 않음'],
];
for (const [x,w,title,detail] of steps) {
  card(x,1950,w,103,'#FFFFFF','#C6DED4',15);
  text(x+20,1988,title,{size:25,weight:600,max:w-40});
  text(x+20,2027,detail,{size:21,fill:muted,max:w-40});
}
edge('M600 2000H695','dev'); edge('M1165 2000H1260','dev'); edge('M1730 2000H1825','dev');
text(140,2074,'백엔드는 HMR이 아니라 재빌드·재배포 · 웹 저장 반영은 Vite HMR · 다른 팀원 PC와 공용 이미지에는 영향 없음',{size:20,fill:colors.dev,max:2510});

parts.push('<path d="M80 2153H2740" stroke="#E4EBF0" stroke-width="2"/>');
const legends = [[85,'runtime','요청·데이터 연결'],[620,'deploy','이미지·GitOps 제어'],[1230,'config','설정된 연결 / 현재 비활성'],[1990,'dev','로컬 개발 반영']];
for (const [x,kind,name] of legends) { edge(`M${x} 2190H${x+60}`,kind); text(x+78,2198,name,{size:22,max:600}); }
text(80,2235,'단일 PC 실행 구성 · AWS / Vercel / ECR / SSM 없음 · 모바일 앱 실행·Windows 실기기·고가용성·전체 AI 품질 검증은 별도',{size:21,fill:muted,max:2660});
parts.push('</svg>');
const svg = parts.join('\n');
await fs.writeFile(path.join(root,`${basename}.svg`),svg);
console.log(`Created ${basename}.svg`);

if (process.argv.includes('--render')) {
  const require = createRequire(import.meta.url);
  const modulePath = process.env.GOVBIZ_DIAGRAM_NODE_MODULES;
  const {chromium} = require(modulePath?path.join(modulePath,'playwright'):'playwright');
  const browser = await chromium.launch({headless:true,...(process.env.GOVBIZ_DIAGRAM_CHROME?{executablePath:process.env.GOVBIZ_DIAGRAM_CHROME}:{})});
  try {
    const context = await browser.newContext({viewport:{width:W,height:H},deviceScaleFactor:2});
    await context.route('**/*',route=>route.abort());
    const page = await context.newPage();
    await page.setContent(`<html><head><meta charset="utf-8"><style>body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);
    await page.evaluate(async()=>{
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('image')].map(img=>new Promise((resolve,reject)=>{
        const asset=new Image(); asset.onload=resolve; asset.onerror=reject; asset.src=img.getAttribute('href');
      })));
    });
    const errors = await page.evaluate(({W,H})=>{
      const frame=document.querySelector('svg').getBoundingClientRect();
      return [...document.querySelectorAll('svg text')].flatMap(node=>{
        const b=node.getBoundingClientRect(), limit=Number(node.dataset.maxWidth), x=b.left-frame.left, y=b.top-frame.top;
        return b.width>limit || x<0 || y<0 || x+b.width>W || y+b.height>H ? [{text:node.textContent,width:b.width,limit,x,y}] : [];
      });
    },{W,H});
    if(errors.length) throw new Error(`Text bounds failed: ${JSON.stringify(errors)}`);
    const count=await page.locator('image').evaluateAll(nodes=>new Set(nodes.map(n=>n.dataset.brand)).size);
    if(count!==icons.size) throw new Error(`Unused logos: ${icons.size-count}`);
    await page.screenshot({path:path.join(root,`${basename}.png`),fullPage:true});
    console.log(`Created ${basename}.png (${W*2} × ${H*2}); ${count} logos and text bounds verified; network blocked`);
  } finally { await browser.close(); }
}
