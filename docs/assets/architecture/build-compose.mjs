import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Documentation only: reuse the original diagram's local logos; never contact a cluster or registry.
const root = path.dirname(fileURLToPath(import.meta.url));
const basename = 'govbiz-compose-architecture';
const manifest = JSON.parse(await fs.readFile(path.join(root, 'kubernetes-logo-sources.json'), 'utf8'));
manifest.push(...JSON.parse(await fs.readFile(path.join(root, 'logo-sources.json'), 'utf8'))
  .filter(source => ['rabbitmq', 'mybatis', 'openai', 'python'].includes(source.name)));
const icons = new Map();
for (const source of manifest) {
  const bytes = await fs.readFile(path.join(root, 'icons', source.file));
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Logo hash mismatch: ${source.name}`);
  const isSvg = source.file.endsWith('.svg');
  if (isSvg) {
    const svg = bytes.toString('utf8');
    if (!/<svg[\s>]/i.test(svg) || /<(script|foreignObject)\b|\son\w+\s*=/i.test(svg)
        || /(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)) throw new Error(`Unsafe SVG: ${source.name}`);
  } else if (!source.file.endsWith('.png') || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`Invalid PNG: ${source.name}`);
  }
  icons.set(source.name, `data:${isSvg ? 'image/svg+xml' : 'image/png'};base64,${bytes.toString('base64')}`);
}

const W = 2800, H = 2900;
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
<title id="title">GovBiz Docker Compose 로컬 전체 구성 — 업무 · 평가 · 관측</title>
<desc id="desc">호스트 React Vite와 Expo, Catalog 분리형 업무 Compose, 별도 govbiz-llmops Compose를 연결한 로컬 전체 실행 경로. 루트 기본 Compose의 Ops와 LLMOps 전용 Ops는 서로 다른 DB를 쓰는 대안이다. 이 그림은 전용 Ops 경로를 표시한다. 프로젝트 안에서는 Compose DNS로 통신하고 프로젝트 사이는 설정된 호스트 주소로 연결한다. Prefect와 실행기, 독립 ops-sync, 결과 named volume, Langfuse 전용 저장소를 사용한다. ops-artifacts는 선택 HTTP overlay다. 새 모델 호출과 정기 실행은 승인·예산·설정 후 활성화한다.</desc>
<defs>${Object.entries(colors).map(([name,color])=>`<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${color}"/></marker>`).join('')}</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>`);
text(70,91,'GovBiz',{size:56,weight:700});
text(300,91,'Docker Compose 로컬 전체 구성',{size:38,weight:600});
text(70,140,'호스트 웹·모바일 · 업무 Compose · 별도 LLMOps Compose · named volume 데이터 보존',{size:25,fill:muted,max:2050});
card(2210,51,520,62,'#ECF7FE','#B8D7E9',16);
text(2470,91,'DOCKER COMPOSE',{size:28,weight:700,anchor:'middle',fill:'#256586',max:480});
text(2730,140,'2026.10.12 · 전체 평가 실행 경로',{size:21,fill:muted,anchor:'end',max:640});

// Host Vite avoids assuming that separate Compose projects share DNS.
card(60,188,2680,357,'#F8FBFD','#D2DFEB',26);
text(90,232,'01   개발 PC · 사용자 / 관리자 진입',{size:26,weight:700,fill:muted});
card(90,265,400,125); icon('chrome',113,286,43);
text(175,316,'브라우저',{size:29,weight:600,max:280});
text(113,361,'사용자 화면 · React Ops',{size:23,max:354});
card(565,265,515,125);icon('react',588,286,43);icon('vitejs',644,288,40);
text(706,317,'호스트 Vite :5173',{size:28,weight:600,max:349});
text(588,361,'pnpm dev:web · 같은 웹에서 관리자 로그인',{size:21,max:469});
edge('M490 326H565');edge('M1080 326H1155');
card(1155,265,720,125,'#F1F8FC','#C3DAE8');
text(1180,305,'호스트 포트 → 컨테이너 API',{size:25,weight:600,max:670});
text(1180,344,'① /api/* → Core localhost:8080',{size:23,max:670});
text(1180,375,'② /api/v1/ops/* → Ops localhost:18001',{size:23,max:670});
card(1950,265,755,125,'#F6F3FD','#D8CDEA');
text(1975,305,'도구 UI · loopback 공개 포트',{size:25,weight:600,max:705});
text(1975,344,'Prefect localhost:14200 → :4200',{size:23,max:705});
text(1975,375,'Langfuse localhost:13000 → :3000',{size:23,max:705});
icon('react',113,435,42);
text(175,468,'React Native / Expo · iOS / Android',{size:27,weight:600,max:690});
edge('M835 459H935');
text(970,450,'기기에서 접근 가능한 Core API origin → ① Core · Bearer 인증',{size:25,max:1700});
text(970,491,'웹·앱은 @govbiz/shared 계약 공유 · 실기기는 USB reverse 또는 접근 가능한 개발 주소 사용',{size:22,fill:muted,max:1700});

card(60,590,2680,1690,'#F6FAFE','#BCD1E5',30);
icon('docker',94,619,58);
text(175,660,'Docker Engine / Docker Desktop',{size:36,weight:700,max:1450});
text(2705,656,'Compose 프로젝트별 네트워크 · 별도 볼륨',{size:25,fill:muted,anchor:'end',max:1100});
card(90,710,1430,1020,'#FFFFFF','#C6D9EB',24);
text(120,756,'업무 Compose · Catalog 분리형',{size:30,weight:700,max:1350});
const apps=[
 [120,'springboot','① Core API · :8080',['계정·기업·신청·협업','검색 조합 · 근거 검증','Core 관리자 세션 인증']],
 [600,'springboot','Catalog · :8081',['공고 수집·정규화·색인','인증된 snapshot 제공','Core는 조회용 복제본 보관']],
 [1080,'fastapi','AI Service · :8000',['임베딩·추천·RAG·도우미','OpenAI · LangChain / LangGraph','벡터 색인 · 원문 근거 조회']],
];
for(const [x,brand,title,lines] of apps){
 card(x,845,380,190,brand==='fastapi'?'#EDF9FB':'#F2F8EF',brand==='fastapi'?'#B8DCE3':'#CBDFBF');
 icon(brand,x+18,865,38);text(x+70,897,title,{size:24,weight:700,max:294});
 lines.forEach((s,i)=>text(x+20,941+i*32,s,{size:i===1&&brand==='fastapi'?19:22,fill:i===2?muted:ink,max:340}));
}
edge('M310 845V804H1270V845');parts.push('<path d="M790 845V804" fill="none" stroke="#7A8E9C" stroke-width="3"/>');
label(880,789,'Core / Catalog → AI 내부 HTTP',660);
edge('M500 975H600','runtime',true);label(550,955,'snapshot',95);
for(const [x,brand,title,detail] of [
 [120,'mysql','Core MySQL 8.4','계정·업무·조회용 공고 복제본'],
 [600,'mysql','Catalog MySQL 8.4','공고 원본·수집 상태·공개 버전'],
 [1080,'qdrant','Qdrant · :6333','벡터 · 원문 근거 청크'],
]){
 edge(`M${x+190} 1035V1120`);
 if(brand==='mysql')icon('mybatis',x+205,1056,160,40);
 else label(x+290,1080,'벡터 검색',170);
 card(x,1120,380,108,brand==='mysql'?'#FFF4DF':'#FCE2EF',brand==='mysql'?'#C8AD72':'#C26493',18);
 icon(brand,x+20,1140,39);text(x+74,1170,title,{size:24,weight:600,max:290});
 text(x+20,1208,detail,{size:21,fill:muted,max:340});
}
for(const [y,brand,title,detail,fill,stroke] of [
 [1300,'redis','Redis · 캐시 저장소','Core 검색 결과·조건 저장 / 복원 · :6379','#FFE3DC','#C66B50'],
 [1440,'elasticsearch','Elasticsearch · 검색 저장소','Catalog 색인 · Core 키워드 조회 · :9200','#DBF3EF','#46988A'],
 [1580,'rabbitmq','RabbitMQ · 메시지 브로커','Core Outbox 발행기·소비자 · :5672','#F4F6F8','#A8B5AF'],
]){
 card(120,y,630,108,fill,stroke,18);icon(brand,143,y+21,41);
 text(205,y+44,title,{size:26,weight:600,max:520});text(205,y+85,detail,{size:21,fill:muted,max:520});
}
edge('M500 1020H540V1260H790V1483H750');edge('M790 1344H750');label(690,1248,'Core 조회',175);
edge('M980 1020H1020V1277H840V1520H750');label(923,1264,'Catalog 색인',200);
edge('M120 1000H106V1634H120');
card(930,1400,530,288,'#FBFCFE','#D3DEE5',18);
icon('openai',953,1424,38);text(1010,1455,'외부 API 연결',{size:27,weight:600,max:415});
text(953,1502,'AI → OpenAI · 답변 / 임베딩',{size:23,max:483});
text(953,1544,'Catalog → 공고 제공처 API',{size:23,max:483});
text(953,1593,'수집·모델 호출은 설정에 따라 실행',{size:21,fill:muted,max:483});
text(953,1636,'실행 여부와 품질 합격을 구분',{size:21,fill:muted,max:483});
edge('M1460 983H1485V1460H1460','config');

// This project owns a dedicated Ops DB; it is not the root Compose Ops instance.
card(1600,710,1110,1520,'#F8F5FD','#D7C8E7',24);
text(1630,756,'govbiz-llmops · 별도 Compose 프로젝트',{size:29,weight:700,max:1045});
text(1630,798,'compose.yaml + compose.ops.yaml · evaluation profile',{size:22,fill:muted,max:1045});
card(1630,845,490,168,'#ECF8F3','#B9DBCB');icon('django',1653,866,41);
text(1715,899,'② Django Ops · :8000',{size:27,weight:700,max:380});
text(1653,944,'실행·예산·취소·검토·품질 판정',{size:24,max:443});
text(1653,981,'Core 관리자 세션으로 권한 확인',{size:22,fill:muted,max:443});
card(1630,1070,490,108,'#ECF8F3','#B9DBCB',18);
text(1653,1112,'ops-sync · 별도 컨테이너',{size:26,weight:700,max:443});
text(1653,1153,'같은 Django 이미지 · 상태·결과 동기화',{size:21,fill:muted,max:443});
edge('M1630 970H1615V1295H1630');
label(1875,1048,'같은 이미지 · 독립 실행',415);
card(1630,1235,490,120,'#FFF4DF','#C8AD72',18);icon('mysql',1653,1257,41);
text(1715,1289,'Ops MySQL 8.4',{size:26,weight:600,max:380});
text(1653,1330,'govbiz_ops_llmops · 전용 데이터 볼륨',{size:22,fill:muted,max:443});
edge('M1875 1178V1235');
card(2180,845,490,168,'#FFFFFF','#D6CBE4');
text(2203,889,'Prefect Server · :4200',{size:27,weight:700,max:443});
text(2203,932,'평가 flow · 실행 상태 · 로그',{size:24,max:443});
text(2203,980,'SQLite → prefect-data 볼륨',{size:22,fill:muted,max:443});
edge('M2120 922H2180','runtime',true);
edge('M2120 1125H2145V982H2180');
edge('M2425 1013V1070');
card(2180,1070,490,190,'#F1EEF9','#D5C5E5');
text(2203,1112,'evaluation-runner',{size:29,weight:700,max:443});
text(2203,1153,'pandas → Pandera → 지표 계산',{size:23,max:443});
text(2203,1193,'Evidently 보고서 · Langfuse 점수',{size:22,max:443});
text(2203,1233,'승인·예산 확인 → Ops 내부 API',{size:21,fill:muted,max:443});
edge('M2425 1260V1315');
card(2180,1315,490,120,'#F8F2FF','#BBA2D6',18);
text(2203,1360,'ops-results · named volume',{size:26,weight:700,max:443});
text(2203,1401,'실행기 쓰기 · Ops / sync 읽기 전용',{size:21,fill:muted,max:443});
edge('M2120 1155H2155V1380H2180');
text(1630,1411,'기동: ops-mysql → ops-bootstrap',{size:22,fill:muted,max:490});
text(1630,1449,'초기화 후 Ops·sync·실행기 시작',{size:22,fill:muted,max:490});
card(1630,1480,1040,180,'#FFFFFF','#D6CBE4',18);
text(1653,1525,'선택 overlay · ops-artifacts :8010',{size:28,weight:700,max:992});
text(1653,1570,'Ops / sync → 인증 HTTP → 결과 서버 → 같은 ops-results 볼륨',{size:23,max:992});
text(1653,1617,'이 방식에서는 Ops의 결과·자료 mount 제거 · 모델 호출 비활성',{size:22,fill:muted,max:992});
edge('M2425 1435V1480','config');
card(1630,1730,1040,445,'#F2F8F6','#BDD7CE',22);
text(1653,1772,'Langfuse · 관측 전용 구성',{size:27,weight:700,max:992});
card(1653,1805,994,103,'#FFFFFF','#C5DCD3',18);
text(1680,1847,'Langfuse Web :3000 + Worker',{size:29,weight:700,max:940});
text(1680,1882,'trace · 토큰·지연·오류 · 평가 점수',{size:23,max:940});
edge('M2670 1165H2689V1855H2647');
const telemetry=[
 [1653,'PostgreSQL','메타데이터','#E6F0FD','#81A7CD'],
 [1911,'ClickHouse','trace / 점수','#FFF7C2','#BDA64D'],
 [2169,'Redis','작업 큐 / 캐시','#FFE3DC','#C66B50'],
 [2427,'MinIO','이벤트 / 미디어','#FCE7F1','#CB8AA9'],
];
edge('M2150 1908V1940');
parts.push('<path d="M1765 1965V1940H2537V1965M2023 1940V1965M2281 1940V1965" fill="none" stroke="#7A8E9C" stroke-width="3"/>');
for(const [x,title,detail,fill,stroke] of telemetry){
 card(x,1965,220,99,fill,stroke,15);text(x+16,2004,title,{size:24,weight:600,max:188});
 text(x+16,2041,detail,{size:21,fill:muted,max:188});
}
text(1653,2110,'전용 named volume 4개 · 업무 DB·Redis와 분리',{size:24,max:992});
text(1653,2148,'Prefect SQLite는 별도 prefect-data 볼륨 사용',{size:22,fill:muted,max:992});

// Numbered host paths keep cross-project traffic explicit without shared-network assumptions.
card(90,1790,1430,210,'#EEF6FC','#BDD7E8',22);
text(120,1834,'프로젝트 사이 연결 · 호스트 주소 사용',{size:28,weight:700,max:1365});
text(120,1880,'Ops → host.docker.internal:8080 → Core 관리자 세션',{size:25,max:1365});
text(120,1924,'Core / AI → host.docker.internal:13000 → Langfuse (추적 설정 시)',{size:24,max:1365});
text(120,1969,'Docker Desktop 호스트 연결 기준 · Linux에서는 host-gateway 및 바인딩 설정 확인',{size:22,fill:muted,max:1365});
edge('M1520 1900H1550V1855H1653','config');
card(90,2040,1430,167,'#FFFFFF','#C6D9EB',22);
text(120,2086,'저장과 개발 반영',{size:28,weight:700,max:1365});
text(120,2132,'MySQL·검색·큐·결과는 named volume · 평가 자료는 읽기 전용 bind mount',{size:24,max:1365});
text(120,2173,'프로젝트명·볼륨을 유지해 재생성 · 이 구성에는 Kubernetes PVC / port-forward가 없음',{size:22,fill:muted,max:1365});

card(60,2320,2680,235,'#F0F9F5','#BBDDD0',26);
text(90,2363,'02   React Ops · 평가와 사람 검토',{size:27,weight:700,fill:'#256B49'});
const review=[
 [90,590,'자료·실행 조건 선택','저장 응답 재평가 또는 승인된 새 실행'],
 [770,590,'Prefect 실행 · 결과 동기화','보고서·trace·점수·예산 이력 확인'],
 [1450,590,'자료·답변 사람 검토','사례별 판단·사유와 승인 저장'],
 [2130,575,'품질 판정 · 비교 기준','검토된 결과를 다음 평가의 기준으로'],
];
for(const [x,w,title,detail] of review){card(x,2394,w,97,'#FFFFFF','#C6DED4',15);text(x+20,2431,title,{size:27,weight:600,max:w-40});text(x+20,2470,detail,{size:21,fill:muted,max:w-40});}
for(const [a,b] of [[680,770],[1360,1450],[2040,2130]])edge(`M${a} 2440H${b}`,'dev');
text(90,2530,'새 답변·RAG·정기 실행은 승인·예산·명시적 설정 후 활성화 · 실행 완료와 품질 합격은 별도',{size:23,fill:'#256B49',max:2590});
card(60,2590,2680,150,'#FAFBFD','#D2DFEB',23);
text(90,2633,'로컬 반영',{size:27,weight:700,max:360});
text(450,2633,'소스·환경 설정 → 필요한 이미지 build → Compose up → health / UI 확인',{size:27,weight:600,max:2220});
text(90,2680,'웹은 Vite HMR · 앱은 Expo Fast Refresh · 기반 설정 변경은 대상 컨테이너 재생성 · Helm / Argo CD 배포 경로와 구분',{size:23,fill:muted,max:2600});
text(90,2719,'루트 기본 Compose는 web·Ops(:8001)도 포함 · 이 그림의 LLMOps 전용 Ops(:18001)와 DB / 결과 볼륨이 다른 실행 경로',{size:22,fill:muted,max:2600});
parts.push('<path d="M70 2780H2730" stroke="#E4EBF0" stroke-width="2"/>');
for(const [x,kind,name] of [[80,'runtime','내부 요청 · 데이터'],[780,'config','설정된 호스트 연결 / 선택 overlay'],[1850,'dev','평가 · 사람 검토']]){edge(`M${x} 2820H${x+58}`,kind);text(x+82,2828,name,{size:23,max:930});}
text(80,2870,'문서용 구성도 · 실제 실행에는 Compose 프로젝트·환경 파일·포트 선택 필요 · 현재 가동 상태나 유료 품질 검증을 의미하지 않음',{size:21,fill:muted,max:2630});
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
