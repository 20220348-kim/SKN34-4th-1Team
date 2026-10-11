import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Documentation only: local assets and source records; never contact AWS or a cluster.
const root = path.dirname(fileURLToPath(import.meta.url));
const basename = 'govbiz-aws-eks-architecture';
const manifests = await Promise.all(['aws-logo-sources.json', 'kubernetes-logo-sources.json']
  .map(async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))));
const manifest = [...new Map(manifests.flat().map(source => [source.name, source])).values()];
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

const W = 3000, H = 3670;
const usedIcons = new Set();
const ink = '#172B3A', muted = '#526675';
const colors = {runtime:'#7A8E9C', deploy:'#AD6C1C', config:'#97A6B3', dev:'#2D8570', access:'#67548E'};
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
  parts.push(`<path d="${d}" fill="none" stroke="${colors[kind]}" stroke-width="3" stroke-linejoin="round"${kind==='config'?' stroke-dasharray="9 7"':''} marker-end="url(#${kind})"${both?` marker-start="url(#${kind})"`:''}/>`);
}
function label(x, y, value, max=360, fill=muted) {
  text(x,y,value,{size:19,max,anchor:'middle',fill});
}


parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">GovBiz AWS EKS 아키텍처 — Vercel 웹 · 모바일 · 업무 · LLMOps</title>
<desc id="desc">2026-10-12 저장소 구성과 워크플로에 근거한 자동 배포 활성화 목표 구조. 웹은 Vercel, API는 CloudFront VPC origin과 내부 ALB를 거쳐 EKS Nginx에서 Core와 Ops로 분기한다. 모바일은 같은 Core API 계약을 사용하며 운영 기기 연결은 별도 검증한다. 시드니 EKS의 사설 EC2 워커 2대는 한 가용 영역에 있고 업무·평가·관측 namespace를 운영한다. MySQL 세 개와 검색·큐·평가·Langfuse 저장소는 EBS gp3 PVC에 보존한다. 개인 main의 같은 최신 SHA가 필수 CI를 모두 통과하면 CodeBuild가 ECR 이미지와 Helm 배포 YAML을 Git 태그에 발행한다. Argo CD가 EKS를 동기화하고 그 결과를 확인한 뒤 Vercel 웹을 전환한다. 실제 활성화·검증 상태는 설명 문서에 기록한다.</desc>
<defs>${Object.entries(colors).map(([name,color])=>`<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${color}"/></marker>`).join('')}</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>`);

text(70,91,'GovBiz',{size:56,weight:700});
text(305,91,'AWS EKS 시스템 아키텍처',{size:38,weight:600});
text(70,142,'Vercel 웹 · React Native 모바일 · EKS 업무·평가·관측 · AWS 네트워크·저장소',{size:25,fill:muted,max:2050});
card(2390,51,540,62,'#FFF5E6','#E8C68E',16);
text(2660,91,'VERCEL + AWS EKS',{size:27,weight:700,anchor:'middle',fill:'#98631F',max:500});
text(2930,142,'2026.10.12 · 자동 배포 적용 구성',{size:21,fill:muted,anchor:'end',max:700});

// The top band shows the request sequence, not physical subnet placement.
card(60,190,2880,400,'#F8FBFD','#D2DFEB',26);
text(90,232,'01   화면과 API 진입 경로',{size:25,weight:700,fill:muted});
const entry = [
  [95,370,'chrome','브라우저',['사용자 화면 · 관리자 Ops']],
  [535,600,'vercel','Vercel · React / Vite',['govbiz.vercel.app · /api 서버 미들웨어']],
  [1215,460,'cloudfront','CloudFront',['HTTPS · API 전용 · 캐시 끔']],
  [1755,440,null,'내부 ALB',['VPC origin → private ALB']],
  [2275,630,'nginx','Nginx API Gateway',['EKS 내부 · 프록시 비밀값 검증']],
];
for (const [x,w,brand,title,lines] of entry) {
  card(x,260,w,108);
  if (brand) icon(brand,x+20,280,38);
  text(x+(brand?73:22),307,title,{size:27,weight:700,max:w-(brand?92:44)});
  text(x+22,347,lines[0],{size:22,fill:muted,max:w-44});
}
for (const [a,b] of [[465,535],[1135,1215],[1675,1755],[2195,2275]]) edge(`M${a} 314H${b}`);
card(95,411,370,135);
icon('react',116,431,39);
text(172,460,'iOS · Android',{size:27,weight:700,max:265});
text(117,504,'React Native / Expo',{size:24,max:326});
text(117,532,'웹과 shared 계약 공유',{size:21,fill:muted,max:326});
card(535,411,600,135,'#F1F8FC','#C3DAE8');
text(558,454,'앱 → 같은 Core API',{size:27,weight:700,max:554});
text(558,495,'HTTPS API origin 설정 · Bearer 인증',{size:23,max:554});
text(558,530,'운영 기기·프록시 연결은 별도 검증',{size:22,fill:muted,max:554});
edge('M465 478H535'); edge('M835 411V368','config');
card(1215,411,980,135,'#F6F3FD','#D8CDEA');
text(1240,454,'관리자 도구 UI · EKS 권한 + port-forward',{size:27,weight:700,max:930});
text(1240,495,'Prefect  localhost:14200    ·    Langfuse  localhost:13000',{size:24,max:930});
text(1240,530,'도구 UI는 공개 API 프록시와 분리 · 다른 PC는 각자 터널 연결',{size:22,fill:muted,max:930});
card(2275,411,630,135,'#F1F8FC','#C3DAE8');
text(2298,454,'① /api/*  →  Core :8080',{size:25,weight:600,max:584});
text(2298,495,'② /api/v1/ops/*  →  Ops :8000',{size:25,weight:600,max:584});
text(2298,530,'Ops 경로 우선 분기 · Core 관리자 세션 확인',{size:21,fill:muted,max:584});
edge('M2590 368V411');

// Cloud services, VPC and EKS are distinct boundaries.
card(60,640,2880,2350,'#FFFCF7','#D7BB8B',30);
icon('aws',90,667,68,49);
text(182,707,'AWS · Sydney / ap-southeast-2',{size:35,weight:700,max:1470});
text(2900,707,'CI → ECR · Helm → Git → Argo CD · EKS → Vercel',{size:24,fill:'#98631F',anchor:'end',max:1210});
card(85,745,2830,1830,'#F5F9FD','#B9CFE2',26);
icon('vpc',112,765,47);
text(178,801,'Amazon VPC · 사설 서브넷의 백엔드',{size:29,weight:700,max:1500});
text(2875,801,'내부 ALB → EKS Gateway · ClusterIP / Service DNS',{size:23,fill:muted,anchor:'end',max:1170});
card(110,835,2780,1600,'#FFFFFF','#BCD1E5',24);
icon('kubernetes',140,860,50);
text(207,902,'Amazon EKS · govbiz-eks',{size:33,weight:700,max:1240});
text(2850,882,'관리형 제어면 · EKS API: private + 관리 IP 제한 public',{size:22,fill:muted,anchor:'end',max:1390});
text(2850,919,'제어면 서브넷 2개 AZ · 워커는 ap-southeast-2a에 배치',{size:22,fill:muted,anchor:'end',max:1390});
for (const [x,w,name,detail] of [
  [140,1360,'application · EC2 1대','Core · Catalog · Ops · 업무 저장소 · Prefect · 평가 실행·결과'],
  [1540,1320,'observability · EC2 1대','AI Service · Langfuse · 관측 저장소 · ALB Controller'],
]) {
  card(x,952,w,125,'#F9FBFE','#C6D9E7',18);
  icon('ec2',x+22,972,43);
  text(x+83,1007,name,{size:28,weight:700,max:w-110});
  text(x+22,1051,detail,{size:23,fill:muted,max:w-44});
}
text(150,1114,'관리형 노드 그룹 · m7i-flex.large × 2 · 아래 namespace는 서비스의 논리 경계이며 노드 경계와 다름',{size:23,fill:muted,max:2690});
parts.push('<g transform="translate(100 200)">');
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
edge('M110 1280H98V1918H110');
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
text(100,2146,'저장소 → ③ EBS gp3 · Prefect / 결과 PVC 분리 · 실행기와 결과 서버는 같은 노드에서 RWO 공유 · 실행 이미지는 ④ ECR에서 pull',{size:23,fill:muted,max:2600});


parts.push('</g>');
// Egress is a route annotation; the named external APIs are not hosted in this VPC.
card(115,2466,2770,78,'#FFFFFF','#CFDCE7',16);
icon('nat',137,2483,38); icon('igw',976,2483,38);
text(193,2516,'외부 요청: private workload → NAT Gateway 1개',{size:24,max:740});
text(1030,2516,'→ Internet Gateway → VPC 외부 OpenAI · 공고 제공처 API',{size:24,max:1490});
text(2855,2516,'NAT는 public subnet',{size:20,fill:muted,anchor:'end',max:330});

// These managed AWS services support the cluster; no RDS replacement is assumed.
const storage = [
  [90,830,'ebs','③ Amazon EBS · gp3',[
    'EBS CSI → 암호화 PVC 13개 데이터 저장',
    '업무 7 · 평가 2 · 관측 4',
    'StorageClass: Retain · AZ에 종속',
    'MySQL은 EKS StatefulSet으로 유지',
  ]],
  [1000,875,'ecr','④ Amazon ECR · private',[
    'CodeBuild가 서비스 이미지 5개 발행',
    'EKS 노드가 digest로 이미지를 pull',
    'immutable git-SHA 태그로 버전 고정',
    '검증된 소스 SHA와 배포 이미지 연결',
  ]],
  [1955,945,null,'Amazon S3 · 이전 백업',[
    '암호화한 이전 백업·메타데이터 보관',
    '비공개 · 버전 관리 · SHA-256 대조',
    '이전 백업 → EBS 데이터 복원에 사용',
    '상시 DB 백업·자동 동기화와 구분',
  ]],
];
for(const [x,w,brand,title,lines] of storage) {
  card(x,2620,w,258,'#FFFFFF','#DCC7A4',22);
  if (brand) icon(brand,x+23,2643,45);
  text(x+(brand?86:25),2682,title,{size:30,weight:700,max:w-(brand?110:50)});
  lines.forEach((line,i)=>text(x+25,2728+i*38,line,{size:24,fill:i>1?muted:ink,max:w-50}));
}
edge('M110 2396H98V2590H505V2620');
label(320,2611,'PVC → EBS CSI',330);
edge('M1437 2620V2590H2902V2396H2890');
label(1720,2611,'ECR → EKS 노드 이미지 pull',460);
card(90,2896,1110,78,'#FFFFFF','#DCC7A4',16);
icon('helm',112,2913,42);
text(173,2929,'Helm → AWS Load Balancer Controller 설치',{size:25,weight:600,max:1000});
text(173,2960,'Controller가 Ingress 설정을 읽어 내부 ALB 구성',{size:21,fill:muted,max:1000});
text(1230,2929,'인프라: eksctl · CloudFormation · IAM / Pod Identity · EBS CSI',{size:23,max:1670});
text(1230,2966,'워커 2대는 한 AZ · 평가 실행은 승인·예산 정책으로 제어',{size:22,fill:muted,max:1670});

card(60,3040,2880,466,'#FDF9F2','#E3D0AC',26);
text(90,3086,'02   main 변경 → CI 검증 → AWS / Vercel 자동 배포',{size:28,weight:700,fill:'#98631F'});
text(2905,3086,'같은 최신 SHA 검증 · 백엔드 갱신 후 웹 전환',{size:22,fill:'#98631F',anchor:'end',max:1050});
const delivery = [
  [90,410,'githubactions','GitHub Actions',['개인 main · 필수 CI 5개','같은 최신 SHA 통과 확인','배포 순서·조건 조율']],
  [545,445,'aws','CodeBuild · ECR',['CodeConnections · IAM 인증','서비스 이미지 5개 빌드·발행','git-SHA 고정 → digest']],
  [1035,445,'helm','Helm 배포 설정',['검증된 Chart · EKS 설정','이미지 digest로 YAML 생성','DB · PVC · Secret 제외']],
  [1525,415,'github','Git 불변 태그',['govbiz-eks/v1.RUN.ATTEMPT','배포 YAML · CI 근거 보관','기존 태그 덮어쓰기 금지']],
  [1985,465,'argocd','Argo CD · EKS',['PreSync: 접수 보호·migration','앱 동기화 → 평가 연결 검증','PostSync: 접수 상태 복구']],
  [2495,410,'vercel','Vercel 웹 전환',['정확한 Argo revision 확인','같은 SHA의 웹·shared 빌드','CI 재확인 → promote']],
];
for (const [x,w,brand,title,lines] of delivery) {
  card(x,3123,w,220,'#FFFFFF','#E1D3BC',20);
  icon(brand,x+22,3145,39);
  text(x+80,3180,title,{size:25,weight:700,max:w-100});
  lines.forEach((line,i)=>text(x+22,3226+i*38,line,{size:21,fill:i===2?muted:ink,max:w-44}));
}
for (let i=0;i<delivery.length-1;i++) edge(`M${delivery[i][0]+delivery[i][1]} 3230H${delivery[i+1][0]}`,'deploy');
text(90,3396,'배포 조건: 개인 main의 최신 SHA · 필수 CI 통과 · 정확한 Git revision / hook / 앱 이미지 확인 후 Vercel 전환',{size:24,fill:'#98631F',max:2800});
text(90,3438,'자동 교체 범위: 애플리케이션·평가 실행기·결과 서버 · DB / PVC / 네트워크 / Langfuse는 별도 관리',{size:23,fill:muted,max:2800});
text(90,3479,'권한 분리: CodeBuild는 빌드·ECR·Git 발행과 EKS 상태 조회 · Argo CD가 Git 설정으로 운영 앱 갱신',{size:23,fill:muted,max:2800});

parts.push('<path d="M70 3520H2930" stroke="#E4EBF0" stroke-width="2"/>');
for(const [x,kind,name] of [[80,'runtime','요청 · 데이터 관계'],[790,'config','조건부 연결 · 별도 검증'],[1640,'deploy','CI 통과 후 자동 배포']]) {
  edge(`M${x} 3564H${x+62}`,kind);
  text(x+82,3572,name,{size:24,max:740});
}
text(2925,3572,'실행 완료 ≠ 품질 합격',{size:24,weight:600,anchor:'end',max:640});
text(80,3624,'자동 배포를 활성화한 목표 구성 · 실행·저장소·품질 검토의 경계 유지 · 실제 적용·검증 기록은 구성도 설명 문서 참고',{size:22,fill:muted,max:2850});
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
