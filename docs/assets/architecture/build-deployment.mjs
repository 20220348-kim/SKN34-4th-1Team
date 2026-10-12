import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Documentation artwork only: pinned official icons, no deployment or network calls.
const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'deployment-icon-sources.json'), 'utf8'));
const icons = new Map();
for (const source of manifest.icons) {
  const bytes = Buffer.from((await fs.readFile(path.join(root, 'icons', source.file), 'utf8')).replace(/\r\n/g, '\n'));
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Icon hash mismatch: ${source.name}`);
  const svg = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(svg) || /<(script|foreignObject)\b|\son\w+\s*=/i.test(svg)
      || /(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)) throw new Error(`Unsafe icon: ${source.name}`);
  icons.set(source.name, `data:image/svg+xml;base64,${bytes.toString('base64')}`);
}

const W = 1440, H = 652;
const color = {ink:'#172B4D', muted:'#52647B', border:'#D6E0EB', blue:'#326CE5'};
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
const diagrams = [
  {
    basename:'govbiz-deployment-build', number:'01', title:'검증한 코드가 배포 설정이 되기까지',
    subtitle:'최신 main의 같은 커밋을 검증하고, 이미지와 Kubernetes 배포 YAML을 차례로 발행합니다.',
    footer:'CodeConnections가 GitHub 작업을 CodeBuild 실행기로 연결합니다. ECR에는 이미지, Git에는 배포 YAML을 보관합니다.',
    cards:[
      {step:'01', role:'소스 확정', icons:['github'], title:'GitHub', lines:['개인 저장소 main 병합','배포할 커밋 확정'], fill:'#F0F5FF'},
      {step:'02', role:'필수 검증', icons:['github'], title:'GitHub Actions', lines:['같은 커밋의 CI 통과','최신 main 여부 확인'], fill:'#F0F5FF'},
      {step:'03', role:'이미지 빌드', icons:['codebuild'], title:'AWS CodeBuild', lines:['Actions 실행기로 동작','Docker 이미지 빌드','ECR에 업로드']},
      {step:'04', role:'이미지 보관', icons:['ecr'], title:'Amazon ECR', lines:['비공개 이미지 5종','이미지 digest 확정','sha256:…'], fill:'#FFFBF3'},
      {step:'05', role:'배포 설정 발행', icons:['helm','github'], title:'Helm → Git', lines:['Chart + 설정 + digest','CodeBuild: YAML 생성','불변 Git 배포 태그 발행']},
    ],
  },
  {
    basename:'govbiz-deployment-release', number:'02', title:'Git 배포 설정이 운영 서비스에 반영되는 과정',
    subtitle:'Argo CD가 백엔드를 동기화하고, 성공을 확인한 뒤 GitHub Actions가 Vercel 웹을 전환합니다.',
    footer:'백엔드 동기화·배포 Job·앱 준비 상태 확인이 실패하면 Vercel 운영 주소를 새 버전으로 전환하지 않습니다.',
    cards:[
      {step:'06', role:'배포 감지', icons:['argo'], title:'Argo CD', lines:['Git 배포 태그 감지','해당 YAML 동기화 시작'], fill:'#F0F5FF'},
      {step:'07', role:'배포 전 준비', icons:['job'], title:'PreSync Job', lines:['평가 접수 보호','진행 평가 확인','DB migration']},
      {step:'08', role:'앱 교체', icons:['eks'], title:'Amazon EKS', lines:['지정한 ECR 이미지 사용','Deployment 6개 갱신','Pod 준비 상태 확인'], fill:'#F0F5FF'},
      {step:'09', role:'배포 후 확인', icons:['job','codebuild'], title:'PostSync · 검증', lines:['평가 연결 확인·접수 복구','CodeBuild가 동기화와','앱 실행 상태 최종 확인']},
      {step:'10', role:'웹 운영 전환', icons:['vercel'], title:'Vercel', lines:['같은 커밋의 웹 빌드','최신 main·CI 재확인','govbiz.vercel.app 전환'], fill:'#F0F5FF'},
    ],
  },
];

function draw(diagram) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title description">
<title id="title">${esc(diagram.title)}</title><desc id="description">${esc(diagram.subtitle)}</desc>
<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10Z" fill="${color.blue}"/></marker></defs>
<rect width="${W}" height="${H}" fill="#F7F9FC"/>
<g font-family="'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif">`];
  const text = (x,y,value,{size=24,weight=400,fill=color.ink,max=W-x-48,anchor='start'}={}) => {
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" data-max-width="${max}">${esc(value)}</text>`);
  };
  text(48,48,`GOVBIZ  /  DEPLOYMENT  /  ${diagram.number}`,{size:19,weight:700,fill:color.blue});
  text(48,104,diagram.title,{size:40,weight:700});
  text(48,148,diagram.subtitle,{size:24,fill:color.muted});
  diagram.cards.forEach((card,i)=>{
    const x = 48+i*276;
    parts.push(`<rect x="${x}" y="192" width="240" height="306" rx="18" fill="${card.fill || '#FFFFFF'}" stroke="${color.border}" stroke-width="2"/>`);
    text(x+20,226,card.step,{size:21,weight:700,fill:color.blue,max:40});
    text(x+220,226,card.role,{size:20,weight:600,fill:color.muted,max:166,anchor:'end'});
    card.icons.forEach((name,j)=>{
      if (!icons.has(name)) throw new Error(`Unknown icon: ${name}`);
      const ix = x+120-(card.icons.length*70+(card.icons.length-1)*18)/2+j*88;
      parts.push(`<image x="${ix}" y="248" width="70" height="70" href="${icons.get(name)}"/>`);
    });
    text(x+120,361,card.title,{size:26,weight:700,anchor:'middle',max:212});
    card.lines.forEach((line,j)=>text(x+120,407+j*34,line,{size:21,fill:color.muted,anchor:'middle',max:218}));
    if (i<4) parts.push(`<path d="M${x+245} 346H${x+268}" fill="none" stroke="${color.blue}" stroke-width="3" marker-end="url(#arrow)"/>`);
  });
  parts.push(`<rect x="48" y="526" width="1344" height="72" rx="14" fill="#EDF3FE" stroke="#BFCFF2"/>`);
  parts.push(`<path d="M72 548V576" stroke="${color.blue}" stroke-width="4" stroke-linecap="round"/>`);
  text(90,569,diagram.footer,{size:22,max:1276});
  text(48,632,'화살표: 배포 진행 순서 · HTTP 요청 경로와 구분',{size:18,fill:color.muted});
  text(1392,632,'공식 브랜드 자산 · Kubernetes Contributors / CC BY 4.0',{size:16,fill:color.muted,anchor:'end',max:600});
  parts.push('</g></svg>');
  return parts.join('\n');
}

for (const diagram of diagrams) {
  diagram.svg = draw(diagram);
  await fs.writeFile(path.join(root,`${diagram.basename}.svg`),diagram.svg);
}
if (process.argv.includes('--render')) {
  const require = createRequire(import.meta.url);
  const modules = process.env.GOVBIZ_DIAGRAM_NODE_MODULES;
  const {chromium} = require(modules ? path.join(modules,'playwright') : 'playwright');
  const browser = await chromium.launch({headless:true,...(process.env.GOVBIZ_DIAGRAM_CHROME ? {executablePath:process.env.GOVBIZ_DIAGRAM_CHROME} : {})});
  try {
    for (const diagram of diagrams) {
      const context = await browser.newContext({viewport:{width:W,height:H},deviceScaleFactor:2});
      await context.route('**/*',route=>route.abort());
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
      }),{W,H});
      if (errors.length) throw new Error(`${diagram.basename}: text bounds ${JSON.stringify(errors)}`);
      await page.screenshot({path:path.join(root,`${diagram.basename}.png`),fullPage:true});
      console.log(`${diagram.basename}: ${W*2}x${H*2}; icon loading and text bounds passed; offline render`);
      await context.close();
    }
  } finally { await browser.close(); }
} else {
  console.log('Generated 2 self-contained SVG diagrams. Use --render for PNG export.');
}
