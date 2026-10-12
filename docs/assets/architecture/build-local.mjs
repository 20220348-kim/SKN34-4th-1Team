import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Documentation only: reuse the original diagram's local logos; never contact a cluster or registry.
const root = path.dirname(fileURLToPath(import.meta.url));
const basename = 'govbiz-local-architecture';
const manifest = JSON.parse(await fs.readFile(path.join(root, 'kubernetes-logo-sources.json'), 'utf8'));
manifest.push(...JSON.parse(await fs.readFile(path.join(root, 'logo-sources.json'), 'utf8'))
  .filter(source => ['rabbitmq', 'mybatis', 'openai'].includes(source.name)));
const icons = new Map();
for (const source of manifest) {
  const raw = await fs.readFile(path.join(root, 'icons', source.file));
  // Git checks out text assets with CRLF on Windows; source hashes use LF.
  const bytes = source.file.endsWith('.svg') ? Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n')) : raw;
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

const W = 2800, H = 3860;
const usedIcons = new Set();
const ink = '#172B3A', muted = '#526675';
const colors = {runtime:'#7A8E9C', deploy:'#AD6C1C', config:'#97A6B3', dev:'#2D8570', external:'#67548E'};
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
<title id="title">GovBiz 로컬 아키텍처 — LLMOps·Argo CD Kubernetes 통합</title>
<desc id="desc">2026-10-13 저장소의 로컬 Kubernetes·GitOps 전환 구성. React/Vite 웹과 React Native/Expo 모바일 앱은 같은 Core API와 shared 계약을 사용하며 관리자 Ops는 웹에서 접근한다. 모바일은 기기에서 접근 가능한 API origin과 Bearer 인증으로 연결한다. 같은 kind 클러스터 안에서 govbiz-msa는 Core·Catalog·AI·Django Ops와 업무 저장소를, govbiz-evaluation은 Prefect·평가 실행기·결과 서버와 PVC를, govbiz-observability는 Langfuse web/worker와 PostgreSQL·ClickHouse·Redis·MinIO 전용 PVC를 소유한다. GitOps 전환 시 argocd Namespace에 Argo CD Core의 Pod 4개를 설치하고 같은 단일 kind 노드에서 실행한다. 설치·인계·활성화 후 Git의 검증 태그를 읽어 로컬 Kubernetes API로 웹·업무·평가 앱을 동기화한다. 기본 개발 모드의 dev.py와 같은 Deployment를 동시에 관리하지 않는다. 서비스는 ClusterIP와 내부 DNS로 연결하고 도구 UI는 loopback port-forward로 접근한다. 전환 후 배치 구조이며 실시간 가동 상태나 유료 평가 완료를 뜻하지 않는다.</desc>
<defs>${Object.entries(colors).map(([name,color])=>`<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${color}"/></marker>`).join('')}</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>`);

text(70,91,'GovBiz',{size:56,weight:700});
text(300,91,'로컬 시스템 아키텍처',{size:38,weight:600});
text(70,140,'웹·모바일 → 같은 Core API · 업무·평가·관측은 Kubernetes · 사람 검토는 React Ops',{size:25,fill:muted,max:1900});
card(2170,51,560,62,'#EDF8F1','#BDDAC8',16);
text(2450,91,'KUBERNETES + LLMOPS',{size:26,weight:700,anchor:'middle',fill:'#256B49',max:520});
text(2730,140,'2026.10.13 · GitOps 전환 구성',{size:21,fill:muted,anchor:'end',max:650});

// Render Helm with tested image digests, publish immutable tags, then let Argo reconcile.
card(60,188,2680,282,'#F8FAFD','#D2DFEB',26);
text(90,228,'01   소스 · 검증 · 로컬 배포',{size:25,weight:700,fill:muted});
const delivery = [
  [90,455,'git','1. 소스 · 개인 포크',['skn-* → 원본 main PR 병합','개인 포크 main 동기화','소스와 Helm Chart를 함께 관리']],
  [585,460,'githubactions','2. 필수 CI 5개',['GovBiz · Catalog · Ops','LLMOps · Infra','같은 소스 SHA의 필수 작업 통과']],
  [1085,455,'github','3. GHCR · 이미지 발행',['웹 · 백엔드 · 평가 실행기','이미지 빌드 · 검증 · 발행','같은 소스 SHA · 불변 digest']],
  [1580,540,'helm','4. Helm · 배포 YAML 생성',['Chart 템플릿 + 로컬 values','검증된 이미지 digest 반영','Kubernetes YAML 렌더링','렌더링 결과 → 불변 배포 태그']],
  [2160,545,'argocd','5. Argo CD · 자동 동기화',['배포 태그 → kind 자동 반영','접수 중지 → migration → 앱 갱신','정상 상태 · 평가 연결 확인 후 재개','아래 argocd Pod · 최초 인계 필요']],
];
for(const [x,w,brand,title,lines] of delivery){
  card(x,255,w,184);
  icon(brand,x+22,277,42);
  text(x+80,309,title,{size:26,weight:600,max:w-100});
  lines.forEach((line,i)=>text(x+22,344+i*27,line,{size:21,fill:i===lines.length-1?muted:ink,max:w-44}));
}
for(const [a,b] of [[545,585],[1045,1085],[1540,1580],[2120,2160]]) edge(`M${a} 344H${b}`,'deploy');

// User-facing entry points are numbered to avoid a long proxy line crossing service lanes.
card(60,510,2680,409,'#F8FBFD','#D2DFEB',26);
text(90,551,'02   사용자 · 관리자 진입',{size:25,weight:700,fill:muted});
card(90,577,370,130);
icon('chrome',114,598,45);
text(180,632,'브라우저',{size:29,weight:600,max:250});
text(113,678,'사용자 화면 · 관리자 Ops',{size:23,max:325});
card(540,577,530,130);
icon('react',561,599,45); icon('vitejs',624,600,41);
text(685,632,'React 웹',{size:30,weight:600,max:360});
text(562,677,'Vite :5173 · K8s web :18173',{size:23,max:486});
edge('M460 642H540');
card(1150,577,725,130,'#F1F8FC','#C3DAE8');
text(1175,617,'개발 port-forward · 배포 내부 Service',{size:26,weight:600,max:675});
text(1175,654,'① /api/*  →  Core :8080',{size:24,max:675});
text(1175,690,'② /api/v1/ops/*  →  Ops :8000',{size:24,max:675});
edge('M1070 642H1150');
card(1955,577,750,130,'#F6F3FD','#D8CDEA');
text(1980,617,'Kubernetes 도구 UI · port-forward',{size:27,weight:600,max:700});
text(1980,654,'Prefect  localhost:14200 → :4200',{size:23,max:700});
text(1980,690,'Langfuse  localhost:13000 → :3000',{size:23,max:700});

card(90,757,370,130);
parts.push('<rect x="119" y="777" width="33" height="49" rx="6" fill="#EEF3FC" stroke="#526675" stroke-width="3"/><path d="M129 783H142M132 819H139" fill="none" stroke="#526675" stroke-width="3" stroke-linecap="round"/>');
text(180,812,'iOS · Android',{size:29,weight:600,max:250});
text(113,858,'모바일 사용자 앱',{size:23,max:325});
card(540,757,530,130);
icon('react',561,779,45);
text(624,812,'React Native / Expo',{size:28,weight:600,max:424});
text(562,857,'웹과 @govbiz/shared 업무·API 계약 공유',{size:22,max:486});
edge('M460 822H540');
card(1150,757,725,130,'#F1F8FC','#C3DAE8');
text(1175,797,'모바일 API → ① Core :8080',{size:26,weight:600,max:675});
text(1175,834,'EXPO_PUBLIC_API_BASE_URL로 API origin 설정',{size:23,max:675});
text(1175,870,'Bearer 인증 · 같은 계정·업무 데이터 사용',{size:23,max:675});
edge('M1070 822H1150');
card(1955,757,750,130,'#F1F8FC','#C3DAE8');
text(1980,797,'Kubernetes 로컬 앱 연결',{size:27,weight:600,max:700});
text(1980,834,'시뮬레이터·기기에서 접근 가능한 API 주소',{size:23,max:700});
text(1980,870,'Core 포워딩 :18080 · 실기기 접근 경로 별도 설정',{size:23,max:700});

parts.push('<g transform="translate(0 180)">');
// All runtime services live inside one cluster; namespaces retain data ownership.
card(60,790,2680,1860,'#F6FAFE','#BCD1E5',30);
icon('kubernetes',94,819,57);
text(173,860,'Kubernetes · kind',{size:37,weight:700,max:1100});
text(100,904,'kind 단일 노드 · 업무 / 평가 / 관측 / 배포 관리 Namespace 분리 · ClusterIP + Service DNS로 통신',{size:25,fill:muted,max:2560});

card(85,950,1505,1160,'#FFFFFF','#C6D9EB',24);
text(112,994,'govbiz-msa · 업무 서비스',{size:30,weight:700,max:1430});
edge('M315 1100V1058H1335V1100');
parts.push('<path d="M825 1100V1058" stroke="#7A8E9C" stroke-width="3" fill="none"/>');
label(944,1041,'Core / Catalog → AI 내부 HTTP',800);
const apps = [
  [110,410,'springboot','① Core API · :8080',['Spring Boot / Kotlin','계정·기업·신청·협업 업무','검색 조합 · 공식 근거 검증','Core 관리자 세션의 인증 기준']],
  [620,410,'springboot','Catalog · :8081',['Spring Boot / Kotlin','공고 수집·정규화·색인 소유','인증된 HTTP snapshot 제공','Core는 조회용 복제본을 보관']],
  [1130,410,'fastapi','AI Service · :8000',['FastAPI / Python','임베딩·추천·RAG·문서·도우미','OpenAI · LangChain / LangGraph','Langfuse SDK → 내부 Service']],
];
for(const [x,w,brand,title,lines] of apps){
  card(x,1100,w,220,brand==='fastapi'?'#EDF9FB':'#F2F8EF',brand==='fastapi'?'#B8DCE3':'#CBDFBF');
  icon(brand,x+20,1122,40);
  text(x+76,1154,title,{size:26,weight:700,max:w-91});
  lines.forEach((line,i)=>text(x+22,1195+i*33,line,{size:i===3?19:22,fill:i===3?muted:ink,max:w-44}));
}
edge('M520 1253H620','runtime',true);
label(570,1232,'snapshot',96);
const databases = [
  [110,410,'mysql','Core MySQL 8.4','계정·업무·조회용 공고 복제본'],
  [620,410,'mysql','Catalog MySQL 8.4','공고 원본·수집 상태·공개 버전'],
  [1130,410,'qdrant','Qdrant · :6333','AI 의미 검색·원문 근거 청크'],
];
for(const [x,w,brand,title,detail] of databases){
  edge(`M${x+w/2} 1320V1400`);
  if (brand === 'mysql') {
    icon('mybatis',x+w/2+22,1330,155,39);
    label(x+w/2+100,1390,'SQL :3306',180);
  } else {
    label(x+w/2+102,1365,'벡터 검색',196);
  }
  card(x,1400,w,108,brand==='mysql'?'#FFF4DF':'#FCE2EF',brand==='mysql'?'#C8AD72':'#C26493',18);
  icon(brand,x+21,1420,40);
  text(x+76,1451,title,{size:25,weight:600,max:w-91});
  text(x+22,1489,detail,{size:21,fill:muted,max:w-44});
}
const stores = [
  [1580,'redis','Redis · 캐시 저장소','Core 검색 결과·조건 복원 · :6379','#FFE3DC','#C66B50'],
  [1718,'elasticsearch','Elasticsearch · 검색 저장소','Catalog 색인 · Core 키워드 조회 · :9200','#DBF3EF','#46988A'],
  [1856,'rabbitmq','RabbitMQ · 메시지 브로커','Core 비동기 작업 · Outbox 연계 · :5672','#F4F6F8','#A8B5AF'],
];
for(const [y,brand,title,detail,fill,stroke] of stores){
  card(110,y,660,124,fill,stroke,18);
  icon(brand,135,y+25,42);
  text(193,y+48,title,{size:27,weight:600,max:550});
  text(193,y+89,detail,{size:22,fill:muted,max:550});
}
// Route Core reads and Catalog indexing through separate lanes beside the stores.
edge('M520 1300H560V1540H810V1780H770');
edge('M810 1642H770');
parts.push(`<circle cx="810" cy="1642" r="5" fill="${colors.runtime}"/>`);
label(685,1530,'캐시 · 키워드 조회',235);
text(824,1620,'저장',{size:17,fill:muted,max:42});
text(824,1642,'복원',{size:17,fill:muted,max:42});
text(824,1769,'조회',{size:17,fill:muted,max:42});
edge('M1030 1300H1080V1555H870V1810H770');
label(975,1539,'공고 색인',190);
card(900,1580,640,210,'#ECF8F3','#B9DBCB');
icon('django',923,1600,42);
text(984,1634,'② Django Ops · :8000',{size:28,weight:700,max:533});
text(923,1674,'Ops API + ops-sync · 같은 Pod / 같은 이미지',{size:23,max:594});
text(923,1710,'Core 관리자 인증 · 실행·예산·취소·사람 검토',{size:22,max:594});
text(923,1746,'Prefect 상태·보고서 동기화 · 품질 판정·기준',{size:22,max:594});
edge('M1220 1790V1860');
card(900,1860,640,120,'#FFF4DF','#C8AD72',18);
icon('mysql',923,1880,42);
text(984,1915,'Ops MySQL 8.4 · 독립 DB / PVC',{size:25,weight:600,max:533});
text(923,1952,'실행 · 검토 · 품질 판정 · 기준 · 예산 · 일정',{size:22,fill:muted,max:594});
text(112,2030,'데이터: MySQL 3개 · Redis 캐시 · Elasticsearch 키워드 색인 · Qdrant 벡터',{size:23,fill:muted,max:1430});
text(112,2072,'메시지: RabbitMQ · 데이터 저장소와 브로커 상태는 각각 StatefulSet / PVC로 보존',{size:22,fill:muted,max:1430});

// Ops calls native Services; no external EndpointSlice or Compose bridge remains.
card(1660,1600,265,170,'#EDF5FC','#C6D6E8',18);
text(1792,1641,'클러스터 내부 HTTP',{size:22,weight:700,anchor:'middle',max:239});
text(1792,1680,'ClusterIP · Service DNS',{size:19,anchor:'middle',max:239});
text(1792,1718,'NetworkPolicy 허용 경로',{size:19,anchor:'middle',max:239});
text(1792,1750,'인증값은 Secret 주입',{size:20,anchor:'middle',max:239});
edge('M1540 1683H1660');
label(1800,1080,'접수 · 상태 조회',280);
label(1795,1808,'인증된 보고서 조회',300);

card(1980,950,730,730,'#F8F5FD','#D7C8E7',24);
text(2007,994,'govbiz-evaluation · 평가 실행',{size:28,weight:700,max:678});
card(2010,1025,665,150,'#FFFFFF','#D6CBE4');
text(2035,1068,'Prefect Server · :4200',{size:30,weight:700,max:615});
text(2035,1110,'평가 flow 접수 · 실행 상태 · 작업 로그',{size:24,max:615});
text(2035,1150,'SQLite → Prefect 전용 PVC',{size:23,fill:muted,max:615});
edge('M2343 1175V1240'); label(2470,1213,'flow 실행',195);
card(2010,1240,665,185,'#F1EEF9','#D5C5E5');
text(2035,1282,'evaluation-runner · Deployment',{size:28,weight:700,max:615});
text(2035,1324,'pandas 집계 → Pandera 검증 → 지표 계산',{size:24,max:615});
text(2035,1364,'Evidently 보고서 · Langfuse 점수',{size:24,max:615});
text(2035,1402,'저장 응답 재평가 · 유료 실행은 승인·설정 후',{size:21,fill:muted,max:615});
edge('M2010 1380H1845V1545H1220V1580','config');
label(1710,1527,'실행기 → Ops 내부 API',360);
edge('M2343 1425V1490'); label(2470,1463,'결과 기록',195);
card(2010,1490,665,155,'#FFFFFF','#D6CBE4');
text(2035,1532,'ops-artifacts · :8010 / 결과 PVC',{size:28,weight:700,max:615});
text(2035,1575,'전용 토큰 인증 · 보고서·평가 자료 읽기',{size:24,max:615});
text(2035,1616,'결과 PVC: 실행기 쓰기 · 결과 서버 읽기 전용',{size:22,fill:muted,max:615});

card(1980,1720,730,390,'#F2F8F6','#BDD7CE',24);
text(2007,1765,'govbiz-observability · 관측',{size:28,weight:700,max:678});
card(2010,1800,665,115,'#FFFFFF','#C5DCD3');
text(2035,1842,'Langfuse Web :3000 + Worker',{size:29,weight:700,max:615});
text(2035,1884,'trace · 토큰·지연·오류 · 평가 점수',{size:24,max:615});
edge('M2675 1325H2693V1855H2675');
edge('M1540 1220H1620V1900H2010','config');
label(1785,1881,'AI trace · SDK 설정 시',320);
edge('M2343 1915V1960');
card(2010,1960,665,120,'#FFFFFF','#C5DCD3',18);
text(2035,2002,'PostgreSQL · ClickHouse · Redis · MinIO',{size:23,weight:600,max:615});
text(2035,2040,'전용 StatefulSet 4개 + PVC 4개 · Retain',{size:23,max:615});
text(2035,2069,'업무용 MySQL · Redis 및 Prefect SQLite와 분리',{size:20,fill:muted,max:615});
// Draw cross-namespace calls above the namespace backgrounds so arrowheads stay visible.
edge('M1925 1635H1950V1100H2010');
edge('M1925 1730H1965V1565H2010');
text(100,2146,'평가 PVC: Prefect / 결과 분리 · 실행기와 결과 서버는 같은 노드에서 RWO PVC 공유 · 외부 도구 UI는 loopback 포워딩',{size:23,fill:muted,max:2600});

// GitOps bootstrap is optional; Argo shares the local kind node, not an EKS node pool.
card(85,2190,1570,420,'#FDF8F0','#E1CBA9',24);
icon('argocd',110,2210,42);
text(170,2236,'argocd · Argo CD Core · 배포 관리',{size:30,weight:700,max:1450});
text(110,2272,'GitOps 전환 시 설치 · 별도 Namespace · Pod 4개',{size:24,fill:muted,max:1515});
for (const [x,y,w,title,detail] of [
  [110,2310,675,'application-controller','StatefulSet · Git 설정과 실제 상태 비교'],
  [850,2310,780,'repo-server','Deployment · 검증된 Git 배포 YAML 조회'],
  [110,2435,675,'ApplicationSet controller','Deployment · Application 생성·관리'],
  [850,2435,780,'Redis · Argo 내부 캐시','Deployment · 업무·Langfuse Redis와 별도'],
]) {
  card(x,y,w,105,'#FFFFFF','#E1D3BC',18);
  text(x+24,y+39,title,{size:26,weight:600,max:w-48});
  text(x+24,y+79,detail,{size:22,fill:muted,max:w-48});
}
edge('M850 2360H785','deploy');
edge('M785 2330H820V2290H1715V2330H1780','deploy');
text(110,2585,'같은 kind 단일 노드에서 실행 · Argo용 PVC 없음 · 별도 웹 서버 없음',{size:23,fill:muted,max:1515});
card(1780,2290,925,135,'#FFFFFF','#BCD1E5',20);
text(1805,2332,'Kubernetes API · 로컬 kind 제어면',{size:28,weight:700,max:875});
text(1805,2372,'같은 kind 노드의 API server에 배포 요청',{size:24,max:875});
text(1805,2404,'로컬 Node에서 실행 · 사용자 API 경로와 분리',{size:22,fill:muted,max:875});
edge('M2242 2425V2470','deploy');
card(1780,2470,925,115,'#FFFFFF','#D3DEE5',20);
text(1805,2510,'govbiz-local Application → 앱 7개',{size:27,weight:700,max:875});
text(1805,2548,'web · Core · Catalog · AI · Ops · 실행기 · 결과 서버',{size:23,max:875});
text(1780,2620,'최초 설치·인계·자동 동기화 활성화 후 사용',{size:23,fill:muted,max:925});

parts.push('<g transform="translate(0 480)">');
// Repeat the two callers as a route detail, outside the cluster boundary.
card(60,2210,2680,350,'#F8F6FC','#CEC4E2',26);
text(90,2254,'03   외부 API 연결 · 위 서비스의 호출 경로',{size:26,weight:700,fill:colors.external,max:1600});
text(2705,2254,'호출 대상은 kind 클러스터 밖',{size:23,fill:colors.external,anchor:'end',max:850});
for (const [y,brand,caller,purpose,target,detail] of [
  [2280,'springboot','Catalog · :8081','공고 수집·정규화','공식 공고 API','기업마당 · K-Startup · 과기정통부 · 충남 수출지원'],
  [2405,'fastapi','AI Service · :8000','답변 생성·임베딩','OpenAI','Responses / Embeddings API'],
]) {
  card(90,y,460,105);
  icon(brand,110,y+19,38);
  text(166,y+44,caller,{size:27,weight:700,max:362});
  text(112,y+82,purpose,{size:23,fill:muted,max:416});
  card(625,y,925,105,'#FFFFFF','#CEC4E2',18);
  text(650,y+44,'kind 네트워크 → 개발 PC의 인터넷 연결',{size:27,weight:600,max:875});
  text(650,y+82,'외부 HTTPS 요청 · API 키는 서버에 주입',{size:23,fill:muted,max:875});
  card(1630,y,1075,105,'#F1F8FC','#C3DAE8',18);
  if (target==='OpenAI') icon('openai',1654,y+18,40);
  text(target==='OpenAI'?1710:1654,y+44,`${target} · HTTPS`,{size:29,weight:700,max:955});
  text(1654,y+82,detail,{size:24,fill:muted,max:1027});
  edge(`M550 ${y+52}H625`,'external');
  edge(`M1550 ${y+52}H1630`,'external');
}
text(90,2545,'API 키·제공처 활성화 설정 필요 · 평가 실행기의 외부 모델 호출은 현재 Chart에서 비활성 · 외부 API는 이 클러스터에 배포하지 않음',{size:23,fill:muted,max:2600});

parts.push('<g transform="translate(0 690)">');
// Human review changes the comparison baseline; orchestration completion is not a quality verdict.
card(60,1920,2680,240,'#F0F9F5','#BBDDD0',26);
text(90,1960,'04   React Ops에서 이어지는 평가 · 사람 검토',{size:26,weight:700,fill:'#256B49'});
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
text(90,2128,'Kubernetes 내부에서 실행·보고서·점수·검토 연결  |  새 답변·RAG는 별도 승인·예산·실행 설정 후 활성화',{size:23,fill:'#256B49',max:2600});

card(60,2200,2680,137,'#FAFBFD','#D2DFEB',23);
text(90,2241,'개발 모드 반영',{size:26,weight:700,max:360});
text(450,2241,'코드 저장 → dev.py → 변경 서비스 Docker 빌드 → kind load → rollout',{size:27,weight:600,max:2230});
text(90,2298,'웹 Vite HMR · 앱 Expo Fast Refresh · GitOps 전환 시 watcher 종료·최초 인계 · 같은 Deployment를 dev.py와 Argo가 동시에 관리하지 않음',{size:23,fill:muted,max:2600});

parts.push('<path d="M70 2380H2730" stroke="#E4EBF0" stroke-width="2"/>');
for(const [x,kind,name] of [[75,'runtime','내부 요청 · 데이터'],[560,'deploy','검증 · 배포 제어'],[1090,'config','설정된 내부 연동'],[1610,'external','외부 API 호출'],[2070,'dev','평가 · 사람 검토']]){
  edge(`M${x} 2420H${x+55}`,kind); text(x+76,2428,name,{size:22,max:570});
}
text(75,2477,'2026.10.13 · 자동 배포 활성화·실시간 가동 상태·유료 모델 품질의 검증 결과는 별도 · 실행 완료 ≠ 품질 합격',{size:21,fill:muted,max:2650});
parts.push('</g></g></g></svg>');
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
