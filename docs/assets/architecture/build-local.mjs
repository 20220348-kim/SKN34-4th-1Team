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

const W = 2800, H = 2510;
const usedIcons = new Set();
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
  usedIcons.add(name);
  parts.push(`<image data-brand="${name}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" href="${icons.get(name)}"/>`);
}
function edge(d, kind='runtime', both=false) {
  parts.push(`<path d="${d}" fill="none" stroke="${colors[kind]}" stroke-width="3" stroke-linejoin="round"${['deploy','config'].includes(kind)?' stroke-dasharray="9 7"':''} marker-end="url(#${kind})"${both?` marker-start="url(#${kind})"`:''}/>`);
}
function label(x, y, value, max=360, fill=muted) {
  text(x,y,value,{size:19,max,anchor:'middle',fill});
}

parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">GovBiz 로컬 아키텍처 — Kubernetes와 Compose LLMOps</title>
<desc id="desc">2026-10-07 코드 기준의 연결 프로필. React에서 Core와 Django Ops로 요청하고, Kubernetes Ops API와 같은 Pod의 동기화 컨테이너가 내부 HTTP 브리지로 Compose의 Prefect와 결과 서버에 연결한다. Compose 평가 실행기는 pandas, Pandera, Evidently로 분석하고 Langfuse에 점수를 기록한다. Kubernetes 연결 범위는 저장 응답의 무료 재평가이며 유료 예산 역방향 연결은 별도다. 이미지 발행은 동일 SHA의 다섯 CI를 요구하며 신규 Argo 자동 배포는 연결되지 않았다. 작성 시점 PC에서는 Compose LLMOps 컨테이너만 관측했으며 저장된 Kubernetes API 주소는 응답하지 않았다.</desc>
<defs>${Object.entries(colors).map(([name,color])=>`<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${color}"/></marker>`).join('')}</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>`);

text(70,91,'GovBiz',{size:56,weight:700});
text(300,91,'로컬 시스템 아키텍처',{size:38,weight:600});
text(70,140,'업무 서비스는 Kubernetes · 평가 실행과 관측은 Compose · 사람 검토는 React Ops',{size:25,fill:muted,max:1900});
card(2170,51,560,62,'#EDF8F1','#BDDAC8',16);
text(2450,91,'KUBERNETES + LLMOPS',{size:26,weight:700,anchor:'middle',fill:'#256B49',max:520});
text(2730,140,'2026.10.07 · 구현된 연결 구성 기준',{size:21,fill:muted,anchor:'end',max:650});

// Delivery describes the current supported path, not the retired promotion/Argo chain.
card(60,188,2680,282,'#F8FAFD','#D2DFEB',26);
text(90,228,'01   소스 · 검증 · 로컬 배포',{size:25,weight:700,fill:muted});
const delivery = [
  [90,560,'git','소스 · 개인 포크',['skn-* → 원본 main PR 병합','개인 포크 main 동기화','소스와 Helm을 한 저장소에서 관리']],
  [740,570,'githubactions','필수 CI 5개',['GovBiz · Catalog · Ops','LLMOps · Infra','같은 소스 SHA의 필수 작업 통과']],
  [1400,565,'github','GHCR 이미지 발행',['개인 포크에서 명시적으로 활성화','검증 receipt · 서비스 이미지 digest','발행 성공과 실제 배포는 별도']],
  [2055,650,'helm','로컬 초기화 · 갱신',['소스 빌드: up --local-images','검증된 GHCR: up','Helm 적용 · kind 이미지 적재']],
];
for(const [x,w,brand,title,lines] of delivery){
  card(x,255,w,184);
  icon(brand,x+22,277,42);
  text(x+80,309,title,{size:28,weight:600,max:w-100});
  lines.forEach((line,i)=>text(x+22,350+i*31,line,{size:22,fill:i===2?muted:ink,max:w-44}));
}
for(const [a,b] of [[650,740],[1310,1400],[1965,2055]]) edge(`M${a} 344H${b}`,'deploy');

// User-facing entry points are numbered to avoid a long proxy line crossing service lanes.
card(60,510,2680,229,'#F8FBFD','#D2DFEB',26);
text(90,551,'02   사용자 · 관리자 진입',{size:25,weight:700,fill:muted});
card(90,577,370,130);
icon('chrome',114,598,45);
text(180,632,'브라우저',{size:29,weight:600,max:250});
text(113,678,'사용자 화면 · 관리자 Ops',{size:23,max:325});
card(540,577,530,130);
icon('react',561,599,45); icon('vitejs',624,600,41);
text(685,632,'React / Vite',{size:30,weight:600,max:360});
text(562,677,'localhost:5173  ·  /ops/evaluations',{size:23,max:486});
edge('M460 642H540');
card(1150,577,725,130,'#F1F8FC','#C3DAE8');
text(1175,617,'Vite 프록시 → loopback port-forward',{size:26,weight:600,max:675});
text(1175,654,'① /api/*  →  :18080  →  Core :8080',{size:24,max:675});
text(1175,690,'② /api/v1/ops/*  →  :18001  →  Ops :8000',{size:24,max:675});
edge('M1070 642H1150');
card(1955,577,750,130,'#F6F3FD','#D8CDEA');
text(1980,617,'연결된 도구 UI',{size:27,weight:600,max:700});
text(1980,654,'Prefect  localhost:14200  ·  작업 상태·로그',{size:23,max:700});
text(1980,690,'Langfuse  localhost:13000  ·  trace·평가 점수',{size:23,max:700});

// Kubernetes application ownership and dedicated persistent storage.
card(60,790,1560,1090,'#F6FAFE','#BCD1E5',30);
icon('kubernetes',94,819,57);
text(173,860,'Kubernetes · kind',{size:37,weight:700,max:800});
text(100,904,'namespace: govbiz-msa · 서비스별 Helm / Deployment / ClusterIP',{size:24,fill:muted,max:1470});
edge('M315 1010V963H1350V1010');
parts.push('<path d="M825 1010V963" stroke="#7A8E9C" stroke-width="3" fill="none"/>');
label(946,946,'Core / Catalog → AI 내부 HTTP',800);
const apps = [
  [100,430,'springboot','① Core API · :8080',['Spring Boot / Kotlin','계정·기업·신청·협업 업무','검색 조합 · 공식 근거 검증','Core 관리자 세션의 인증 기준']],
  [610,430,'springboot','Catalog · :8081',['Spring Boot / Kotlin','공고 수집·정규화·색인 소유','인증된 HTTP snapshot 제공','Core는 조회용 복제본을 보관']],
  [1120,460,'fastapi','AI Service · :8000',['FastAPI / Python','임베딩·추천·RAG·문서·도우미','OpenAI · LangChain / LangGraph','Langfuse SDK 추적은 연결 설정 시']],
];
for(const [x,w,brand,title,lines] of apps){
  card(x,1010,w,220,brand==='fastapi'?'#EDF9FB':'#F2F8EF',brand==='fastapi'?'#B8DCE3':'#CBDFBF');
  icon(brand,x+20,1032,43);
  text(x+80,1064,title,{size:27,weight:700,max:w-96});
  lines.forEach((line,i)=>text(x+22,1105+i*33,line,{size:i===3?20:23,fill:i===3?muted:ink,max:w-44}));
}
edge('M530 1163H610','runtime',true);
label(570,1143,'snapshot',78);
const databases = [
  [100,430,'mysql','Core MySQL 8.4','계정·업무·조회용 공고 복제본'],
  [610,430,'mysql','Catalog MySQL 8.4','공고 원본·수집 상태·공개 버전'],
  [1120,460,'qdrant','Qdrant · :6333','AI 의미 검색·원문 근거 청크'],
];
for(const [x,w,brand,title,detail] of databases){
  edge(`M${x+w/2} 1230V1310`);
  label(x+w/2+92,1275,brand==='mysql'?'SQL :3306':'벡터 검색',180);
  card(x,1310,w,108,'#FFFFFF','#C6D9EB',18);
  icon(brand,x+21,1330,42);
  text(x+79,1361,title,{size:26,weight:600,max:w-99});
  text(x+22,1399,detail,{size:22,fill:muted,max:w-44});
}
card(100,1480,670,300,'#FFFFFF','#C6D9EB');
text(125,1522,'업무용 공용 인프라',{size:27,weight:700,max:620});
const stores = [
  [1550,'redis','Redis :6379','Core 검색 결과·조건 복원'],
  [1620,'elasticsearch','Elasticsearch :9200','Catalog 색인 · Core 키워드 조회'],
  [1690,'rabbitmq','RabbitMQ :5672','Core 비동기 작업 · Outbox 연계'],
];
for(const [y,brand,title,detail] of stores){
  icon(brand,125,y,37);
  text(178,y+26,title,{size:25,weight:600,max:550});
  text(178,y+56,detail,{size:21,fill:muted,max:550});
}
card(920,1480,660,205,'#ECF8F3','#B9DBCB');
icon('django',943,1500,42);
text(1004,1534,'② Django Ops · :8000',{size:29,weight:700,max:548});
text(943,1574,'Ops API + ops-sync · 같은 Pod / 같은 이미지',{size:24,max:615});
text(943,1610,'Core 관리자 인증 · 실행·예산·취소·사람 검토',{size:23,max:615});
text(943,1646,'Prefect 상태와 결과 동기화 · 비교 기준·복구 이력',{size:22,max:615});
edge('M1250 1685V1740');
card(920,1740,660,100,'#FFFFFF','#C6D9EB',18);
icon('mysql',943,1758,42);
text(1004,1787,'Ops MySQL 8.4 · 독립 DB / PVC',{size:27,weight:600,max:548});
text(943,1820,'실행 · 검토 · 품질 판정 · 기준 · 예산 · 일정',{size:23,fill:muted,max:610});
text(100,1860,'저장소: MySQL 3개 + Redis · Elasticsearch · Qdrant · RabbitMQ → StatefulSet / PVC',{size:21,fill:muted,max:1480});

// The bridge carries Ops -> Prefect and read-only artifact HTTP. No live budget return path is implied.
card(1660,1490,280,178,'#F0F5FC','#C6D6E8',18);
text(1800,1530,'내부 HTTP 브리지',{size:24,weight:700,anchor:'middle',max:244});
text(1800,1567,'Service + EndpointSlice',{size:19,anchor:'middle',max:250});
text(1800,1602,'전용 Docker 내부망',{size:22,anchor:'middle',max:248});
text(1800,1640,'무료 저장 응답 재평가',{size:21,anchor:'middle',max:248});
edge('M1580 1577H1660');
text(1774,987,'접수 · 상태 조회',{size:21,fill:muted,max:200});
text(1750,1444,'인증된 결과 읽기',{size:21,fill:muted,max:220});

card(1980,790,760,1090,'#FAF7FF','#D7C8E7',30);
icon('docker',2014,820,62,45);
text(2100,860,'Compose · LLMOps',{size:34,weight:700,max:595});
text(2020,904,'Prefect · 실행기 · 결과 저장소 · Langfuse',{size:24,fill:muted,max:680});
card(2020,945,680,155,'#FFFFFF','#D6CBE4');
text(2045,987,'Prefect Server · :4200',{size:31,weight:700,max:630});
text(2045,1030,'평가 flow 접수 · 실행 상태 · 작업 로그',{size:25,max:630});
text(2045,1072,'Prefect 이력: SQLite / prefect-data 볼륨',{size:23,fill:muted,max:630});
edge('M2360 1100V1160'); label(2485,1139,'작업 실행',195);
card(2020,1160,680,185,'#F1EEF9','#D5C5E5');
text(2045,1202,'평가 실행기 · Prefect flow',{size:31,weight:700,max:630});
text(2045,1244,'pandas 집계 → Pandera 검증 → 지표 계산',{size:25,max:630});
text(2045,1284,'Evidently 비교 보고서 · Langfuse 점수',{size:25,max:630});
text(2045,1322,'저장 캡처 재평가 / 승인형 새 답변·RAG 실행',{size:22,fill:muted,max:630});
edge('M2360 1345V1405'); label(2480,1383,'결과 기록',195);
card(2020,1405,680,155,'#FFFFFF','#D6CBE4');
text(2045,1447,'결과 볼륨 / 읽기 전용 HTTP',{size:30,weight:700,max:630});
text(2045,1488,'ops-artifacts :8010 · 전용 토큰 인증',{size:25,max:630});
text(2045,1527,'/results: 실행기 쓰기 · /evaluation-data: 자료',{size:23,fill:muted,max:630});
edge('M2700 1253H2720V1676H2700');
card(2020,1620,680,215,'#FFFFFF','#D6CBE4');
text(2045,1663,'Langfuse Web + Worker',{size:31,weight:700,max:630});
text(2045,1705,'모델 trace · 토큰·지연·오류 · 평가 점수',{size:24,max:630});
text(2045,1747,'PostgreSQL · ClickHouse · Redis · MinIO',{size:24,fill:muted,max:630});
text(2045,1786,'각 저장소의 Compose 볼륨으로 보존',{size:23,fill:muted,max:630});
text(2045,1817,'업무용 MySQL · Redis와 분리',{size:20,fill:muted,max:630});
edge('M1940 1535H1960V1024H2020');
edge('M1940 1618H1973V1480H2020');

// Human review changes the comparison baseline; orchestration completion is not a quality verdict.
card(60,1920,2680,240,'#F0F9F5','#BBDDD0',26);
text(90,1960,'03   React Ops에서 이어지는 평가 · 사람 검토',{size:26,weight:700,fill:'#256B49'});
const review = [
  [90,570,'자료 선택 · 실행 접수','자료·캡처·버전을 고정하고 실행 관리'],
  [750,570,'보고서 · trace 비교','후보와 기존 기준의 차이 확인'],
  [1410,570,'자료 · 답변 사람 검토','사례별 판단·사유와 실행 승인 저장'],
  [2070,635,'품질 판정 · 비교 기준','승인된 결과를 다음 평가의 기준으로'],
];
for(const [x,w,title,detail] of review){
  card(x,1990,w,100,'#FFFFFF','#C6DED4',15);
  text(x+23,2028,title,{size:28,weight:600,max:w-46});
  text(x+23,2066,detail,{size:23,fill:muted,max:w-46});
}
for(const [a,b] of [[660,750],[1320,1410],[1980,2070]]) edge(`M${a} 2039H${b}`,'dev');
text(90,2128,'Kubernetes 연결: 무료 재평가·보고서·상태 동기화  |  Compose live: 승인·예산 통제  |  Kubernetes live 예산 연결은 별도',{size:23,fill:'#256B49',max:2600});

card(60,2200,2680,137,'#FAFBFD','#D2DFEB',23);
text(90,2241,'로컬 코드 반영',{size:26,weight:700,max:360});
text(450,2241,'코드 저장 → dev.py → 변경 서비스 Docker 빌드 → kind load → rollout',{size:27,weight:600,max:2230});
text(90,2298,'웹은 Vite HMR · 연결된 Ops는 전용 갱신 절차 사용 · 신규 Argo 자동 배포 미연결 · DB / Secret / 볼륨은 별도 보존',{size:23,fill:muted,max:2600});

parts.push('<path d="M70 2380H2730" stroke="#E4EBF0" stroke-width="2"/>');
for(const [x,kind,name] of [[75,'runtime','요청 · 데이터'],[565,'deploy','검증 · 이미지 공급'],[1235,'dev','평가 · 사람 검토']]){
  edge(`M${x} 2420H${x+55}`,kind); text(x+76,2428,name,{size:22,max:570});
}
text(2725,2428,'실행 완료 ≠ 품질 합격',{size:24,weight:600,anchor:'end',max:800});
text(75,2477,'작성 시점 관측: Compose LLMOps 컨테이너 실행 중 · 저장된 kind API 주소 접속 불가 · 실시간 가동·전체 모델 품질을 보증하는 그림은 아님',{size:21,fill:muted,max:2650});
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
    if(count!==usedIcons.size) throw new Error(`Missing rendered logos: ${usedIcons.size-count}`);
    await page.screenshot({path:path.join(root,`${basename}.png`),fullPage:true});
    console.log(`Created ${basename}.png (${W*2} × ${H*2}); ${count} logos and text bounds verified; network blocked`);
  } finally { await browser.close(); }
}
