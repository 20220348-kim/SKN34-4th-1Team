import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Documentation only. Render from pinned local icons without cluster or network access.
const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'kubernetes-resource-icon-sources.json'), 'utf8'));
const argo = JSON.parse(await fs.readFile(path.join(root, 'kubernetes-logo-sources.json'), 'utf8'))
  .find(source => source.name === 'argocd');
const icons = new Map();
for (const source of [...manifest.icons, argo]) {
  // Git may use CRLF on Windows; the pinned upstream SVG hashes use LF.
  const bytes = Buffer.from((await fs.readFile(path.join(root, 'icons', source.file), 'utf8')).replace(/\r\n/g, '\n'));
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Icon hash mismatch: ${source.name}`);
  const svg = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(svg) || /<(script|foreignObject)\b|\son\w+\s*=/i.test(svg)
      || /(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)) throw new Error(`Unsafe icon: ${source.name}`);
  icons.set(source.name, `data:image/svg+xml;base64,${bytes.toString('base64')}`);
}

const W = 1440;
const palette = {ink:'#172B4D', muted:'#52647B', border:'#D6E0EB', blue:'#326CE5', teal:'#087F7C', gold:'#AD731B'};
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
const diagrams = [];
let parts, height, basename, usedIcons;
function text(x, y, value, {size=26, weight=400, fill=palette.ink, max=W-x-48, anchor='start'}={}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" data-max-width="${max}">${esc(value)}</text>`);
}
function rect(x,y,w,h,{fill='#FFFFFF',stroke=palette.border,r=18,dash=false}={}) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"${dash?' stroke-dasharray="8 6"':''}/>`);
}
function icon(name,x,y,size=58) {
  if (!icons.has(name)) throw new Error(`Unknown icon: ${name}`);
  usedIcons.add(name);
  parts.push(`<image data-icon="${name}" x="${x}" y="${y}" width="${size}" height="${size}" href="${icons.get(name)}"/>`);
}
function lines(x,y,values,{gap=38,...style}={}) { values.forEach((line,i)=>text(x,y+i*gap,line,style)); }
function arrow(x1,y1,x2,y2,kind='blue') {
  parts.push(`<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${palette[kind]}" stroke-width="${kind==='teal'?5:3}"${kind==='gold'?' stroke-dasharray="8 6"':''} marker-end="url(#${kind})"/>`);
}
function panel(y,h,label,{fill='#FFFFFF',color=palette.blue}={}) {
  rect(48,y,1344,h,{fill});
  parts.push(`<path d="M72 ${y+32}V${y+64}" stroke="${color}" stroke-width="5" stroke-linecap="round"/>`);
  text(90,y+57,label,{size:29,weight:700,max:1260});
}
function card(x,y,w,h,name,title,body,{fill='#FFFFFF',size=27}={}) {
  rect(x,y,w,h,{fill});
  if (name) icon(name,x+20,y+18,54);
  text(x+(name?90:22),y+52,title,{size,weight:700,max:w-(name?110:44)});
  lines(x+22,y+100,body,{size:25,gap:36,fill:palette.muted,max:w-44});
}
function start(name,h,number,title,subtitle) {
  basename=name; height=h; usedIcons=new Set();
  parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="title description">
<title id="title">${esc(title)}</title><desc id="description">${esc(subtitle)}</desc>
<defs>${['blue','teal','gold'].map(k=>`<marker id="${k}" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10Z" fill="${palette[k]}"/></marker>`).join('')}</defs>
<rect width="${W}" height="${h}" fill="#F7F9FC"/>
<g font-family="'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif">`];
  text(48,48,`GOVBIZ  /  KUBERNETES  /  ${number}`,{size:19,weight:700,fill:palette.blue});
  text(48,104,title,{size:42,weight:700});
  text(48,146,subtitle,{size:24,fill:palette.muted});
}
function finish() {
  text(48,height-30,'저장소 설정 기준 · 실제 활성화 상태는 환경별 배포 기록 참고',{size:21,fill:palette.muted});
  text(W-48,height-30,'K8s icons: Kubernetes Contributors · CC BY 4.0',{size:18,fill:palette.muted,max:550,anchor:'end'});
  parts.push('</g></svg>');
  diagrams.push({basename,height,svg:parts.join('\n'),usedIcons:[...usedIcons]});
}

// 01: Inventory uses aligned namespace rows, with no implied service-call arrows.
start('govbiz-kubernetes-resources-overview',1430,'01','어떤 리소스가 어디에 있나요?','Namespace별 실행·저장소 구성 · 각 서비스는 독립된 Deployment 또는 StatefulSet입니다.');
function namespace(y,h,name,label) {
  rect(48,y,1344,h);
  icon('ns',72,y+20,52);
  text(140,y+54,name,{size:31,weight:700,max:770});
  text(1368,y+53,label,{size:25,fill:palette.muted,anchor:'end',max:380});
}
namespace(180,358,'govbiz-msa','업무 API · 웹 · 업무 데이터');
card(72,262,762,196,'deploy','Deployment → ReplicaSet → Pod',[
  'core-service · catalog-service · ai-service',
  'ops-service: API + ops-sync, 같은 Pod',
  '로컬 web / 운영 api-gateway',
],{size:28});
card(858,262,510,196,'sts','StatefulSet → Pod + PVC',[
  'core / catalog / ops MySQL',
  'Redis · Qdrant · Elasticsearch',
  'RabbitMQ: 활성화한 환경',
],{fill:'#FFFBF3',size:25});
icon('svc',82,480,36); text(132,507,'앱: ClusterIP · 데이터: Headless',{size:25,max:675});
icon('job',858,480,36); text(908,507,'배포 Job: prepare / resume',{size:24,max:455});

namespace(562,306,'govbiz-evaluation','평가 실행 · 결과 조회');
card(72,644,762,142,'deploy','Deployment → ReplicaSet → Pod',[
  'prefect · evaluation-runner · ops-artifacts',
],{size:28});
card(858,644,510,142,'pvc','PVC · 보존 데이터',[
  'Prefect DB / 실행·결과 공유 볼륨',
],{fill:'#FFFBF3',size:27});
icon('svc',82,805,36); text(132,832,'Prefect :4200 · 결과 API :8010 · 실행기는 Service 없음',{size:25,max:1190});

namespace(892,306,'govbiz-observability','관측 · 추적 저장소');
card(72,974,762,142,'deploy','Deployment → ReplicaSet → Pod',[
  'langfuse-web · langfuse-worker',
],{size:28});
card(858,974,510,142,'sts','StatefulSet → Pod + PVC',[
  'PostgreSQL · ClickHouse · Redis · MinIO',
],{fill:'#FFFBF3',size:25});
icon('svc',82,1135,36); text(132,1162,'앱과 관측 저장소 각각 ClusterIP Service 사용',{size:25,max:1190});

rect(48,1222,1344,126,{fill:'#EDF3FE',stroke:'#BFCFF2'});
icon('ns',72,1244,58);
lines(152,1264,[
  'Namespace는 논리적 구분입니다. Node와 1:1로 대응하지 않습니다.',
  '제어 계층(argocd · kube-system)은 ③ 플랫폼 구성에서 이어집니다.',
],{size:26,gap:42,max:1195});
finish();

// 02: Ownership, traffic and persistence are separate lanes; repeated Pods are the same examples.
start('govbiz-kubernetes-resources-flow',1450,'02','Pod는 누가 만들고, 요청은 어디로 가나요?','Ops 예시 · 각 행의 Ops Pod와 MySQL Pod는 같은 리소스를 관점별로 다시 표시한 것입니다.');
panel(180,312,'A. 생성·관리 — Deployment가 ReplicaSet을 통해 Pod를 유지합니다.');
card(80,270,372,165,'deploy','Deployment',['ops-service','replicas: 1 · Recreate']);
card(534,270,372,165,'rs','ReplicaSet',['ops-service-<hash>','Kubernetes가 자동 생성']);
card(988,270,372,165,'pod','Pod',['ops-service-<hash>-…','Ops API + ops-sync']);
arrow(460,350,520,350); arrow(914,350,974,350);
text(80,470,'파란 실선: 생성·관리 관계 · 요청은 Deployment나 ReplicaSet을 거치지 않습니다.',{size:24,fill:palette.muted,max:1270});

panel(516,346,'B. 요청 전달 — Service는 라벨이 맞는 Ready Pod로 전달합니다.',{color:palette.teal,fill:'#F4FBFA'});
card(80,606,272,149,'pod','Nginx Pod',['로컬 web 또는','EKS api-gateway'],{size:27});
card(416,606,272,149,'svc','Service',['ops-service','ClusterIP :8000'],{size:27});
card(752,606,272,149,'pod','Ops Pod',['Ops API 컨테이너','HTTP :8000'],{size:27});
card(1088,606,272,149,'pod','MySQL Pod',['ops-mysql-0','MySQL :3306'],{size:26});
arrow(360,679,402,679,'teal'); arrow(696,679,738,679,'teal'); arrow(1032,679,1074,679,'teal');
lines(80,795,[
  '초록 실선: 실제 요청 · Service 대상 Pod의 주소·준비 상태는 EndpointSlice에 기록됩니다.',
  'Ops는 CoreDNS에서 Headless Service의 Pod IP를 조회한 뒤 MySQL Pod에 직접 접속합니다.',
],{size:24,gap:38,fill:palette.muted,max:1280});

panel(886,314,'C. 데이터 보존 — DB Pod가 교체되어도 연결한 PVC를 다시 마운트합니다.',{color:palette.gold,fill:'#FFFBF3'});
card(80,976,272,148,'sts','StatefulSet',['ops-mysql','Pod 직접 관리'],{size:23});
card(416,976,272,148,'pod','MySQL Pod',['ops-mysql-0','데이터 볼륨 마운트']);
card(752,976,272,148,'pvc','PVC',['Namespace 안','볼륨 요청·사용']);
card(1088,976,272,148,'pv','PV',['클러스터 범위','kind 볼륨 / EBS']);
arrow(360,1050,402,1050); arrow(696,1050,738,1050,'gold'); arrow(1032,1050,1074,1050,'gold');
text(80,1168,'황색 점선: 마운트·바인딩 · StatefulSet은 ReplicaSet을 만들지 않습니다.',{size:24,fill:palette.muted,max:1280});

rect(48,1224,1344,132,{fill:'#FFFFFF'});
icon('svc',72,1252,60);
text(154,1267,'Headless Service: ops-mysql',{size:27,weight:700,max:1170});
text(154,1310,'clusterIP: None · 별도 프록시 없이 DNS가 MySQL Pod IP를 알려줍니다.',{size:26,fill:palette.muted,max:1170});
finish();

// 03: Separate the API control path, ALB data path, shared add-ons, and policies.
start('govbiz-kubernetes-resources-platform',1670,'03','클러스터를 관리하고 연결하는 구성','로컬·EKS의 공통 역할과 EKS 전용 구성을 구분합니다. 자동 배포 활성화 여부는 별도입니다.');
panel(180,302,'A. 배포·실행 관리');
card(80,266,372,162,'argocd','Argo CD',['AppProject · Application','검증된 Git YAML 적용']);
card(534,266,372,162,'control-plane','Control Plane',['API · etcd · 컨트롤러','Scheduler · EKS: AWS 관리'],{size:26});
card(988,266,372,162,'node','Worker Node',['kubelet · containerd','Pod 실행·상태 보고']);
arrow(460,346,520,346); arrow(914,346,974,346);
text(80,462,'EKS 노드 풀: application / observability · Namespace와 Node 배치는 별도입니다.',{size:24,fill:palette.muted,max:1270});

panel(506,336,'B. EKS 외부 요청 진입 — Ingress 설정과 HTTP 요청 경로를 구분합니다.',{color:palette.teal,fill:'#F4FBFA'});
icon('ing',80,588,45);
text(144,620,'Ingress: api-gateway → ALB Controller가 내부 ALB를 구성',{size:27,weight:600,max:1190});
card(80,651,272,126,null,'CloudFront',['VPC origin']);
card(416,651,272,126,null,'내부 ALB',['AWS 리소스']);
card(752,651,272,126,'pod','Gateway Pod',['Nginx :8080'],{size:23});
card(1088,651,272,126,'svc','Core · Ops',['내부 Service'],{size:26});
arrow(360,714,402,714,'teal'); arrow(696,714,738,714,'teal'); arrow(1032,714,1074,714,'teal');
text(80,815,'ALB의 target-type: ip → gateway Pod로 직접 전달 · 로컬은 웹 Service·port-forward 사용',{size:24,fill:palette.muted,max:1280});

panel(866,285,'C. kube-system 기반 기능과 클러스터 저장소');
card(80,952,372,145,'svc','DNS · 통신',['CoreDNS · kube-proxy','CNI: EKS VPC CNI'],{size:27});
card(534,952,372,145,'sc','StorageClass',['govbiz-ebs-gp3 · EBS CSI','암호화 · Retain'],{size:25});
card(988,952,372,145,'node','노드 기반 기능',['CNI · CSI 노드 agent','AWS Pod Identity'],{size:24});
text(80,1130,'StorageClass는 클러스터 범위 리소스 · 노드별 기반 agent는 DaemonSet으로 실행합니다.',{size:24,fill:palette.muted,max:1270});

panel(1175,371,'D. 설정·접근 제어 — 요청을 중계하는 서비스와 구분합니다.');
const security = [
  ['secret','Secret','자격 정보','환경변수·볼륨'],
  ['cm','ConfigMap','비밀 아닌 설정','Nginx · ClickHouse'],
  ['sa','ServiceAccount','Pod 실행 신원','앱 토큰 자동 마운트 끔'],
  ['role','RBAC','Role · RoleBinding','Kubernetes API 권한'],
  ['netpol','NetworkPolicy','Pod 통신 허용·차단','CNI 집행 필요'],
];
security.forEach(([name,title,a,b],i)=>{
  const x=80+i*260;
  rect(x,1263,240,218);
  icon(name,x+91,1282,58);
  text(x+120,1376,title,{size:24,weight:700,anchor:'middle',max:220});
  text(x+120,1417,a,{size:22,anchor:'middle',max:220});
  text(x+120,1452,b,{size:20,fill:palette.muted,anchor:'middle',max:220});
});
text(80,1523,'평가·관측·gateway 정책은 범위별 적용 · readiness/liveness, 자원 요청·제한은 Pod 명세에 포함',{size:23,fill:palette.muted,max:1280});
finish();

for (const diagram of diagrams) {
  await fs.writeFile(path.join(root, `${diagram.basename}.svg`), diagram.svg);
}
if (process.argv.includes('--render')) {
  const require = createRequire(import.meta.url);
  const modules = process.env.GOVBIZ_DIAGRAM_NODE_MODULES;
  const {chromium} = require(modules ? path.join(modules, 'playwright') : 'playwright');
  const browser = await chromium.launch({headless:true,...(process.env.GOVBIZ_DIAGRAM_CHROME ? {executablePath:process.env.GOVBIZ_DIAGRAM_CHROME} : {})});
  try {
    for (const diagram of diagrams) {
      const context = await browser.newContext({viewport:{width:W,height:diagram.height},deviceScaleFactor:2});
      await context.route('**/*', route=>route.abort());
      const page = await context.newPage();
      await page.setContent(`<html><head><meta charset="utf-8"><style>body{margin:0}svg{display:block}</style></head><body>${diagram.svg}</body></html>`);
      await page.evaluate(async()=>{
        await document.fonts.ready;
        await Promise.all([...document.querySelectorAll('image')].map(node=>new Promise((resolve,reject)=>{
          const img=new Image(); img.onload=resolve; img.onerror=reject; img.src=node.getAttribute('href');
        })));
      });
      const errors = await page.evaluate(({W,H})=>[...document.querySelectorAll('svg text')].flatMap(node=>{
        const b=node.getBoundingClientRect(), max=Number(node.dataset.maxWidth);
        return b.width>max || b.left<0 || b.top<0 || b.right>W || b.bottom>H
          ? [{text:node.textContent,width:b.width,max,x:b.left,y:b.top}] : [];
      }),{W,H:diagram.height});
      if (errors.length) throw new Error(`${diagram.basename}: text bounds ${JSON.stringify(errors)}`);
      await page.screenshot({path:path.join(root,`${diagram.basename}.png`),fullPage:true});
      console.log(`${diagram.basename}: ${W*2}x${diagram.height*2}; ${diagram.usedIcons.length} icon types; text bounds passed; offline render`);
      await context.close();
    }
  } finally { await browser.close(); }
} else {
  console.log(`Generated ${diagrams.length} self-contained SVG diagrams. Use --render for PNG export and bounds checks.`);
}
