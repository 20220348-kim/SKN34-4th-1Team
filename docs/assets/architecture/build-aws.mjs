import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

// Documentation only: does not provision AWS, run containers, or call AI APIs.
// The existing local-development diagram and its generator remain unchanged.
const root = path.dirname(fileURLToPath(import.meta.url));
const deployed = process.argv.includes('--deployed');
const basename = deployed ? 'govbiz-aws-architecture-deployed' : 'govbiz-aws-architecture';
const variant = (proposal, production) => deployed ? production : proposal;
const awsPackage = 'https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip';
const serviceRoot = 'Architecture-Service-Icons_07312026';
const awsIcons = [
  ['aws', 'Architecture-Group-Icons_07312026/AWS-Cloud-logo_32.svg'],
  ['ec2', `${serviceRoot}/Arch_Compute/64/Arch_Amazon-EC2_64.svg`],
  ['rds', `${serviceRoot}/Arch_Databases/64/Arch_Amazon-RDS_64.svg`],
  ['ssm', `${serviceRoot}/Arch_Management-Tools/64/Arch_AWS-Systems-Manager_64.svg`],
  ['ecr', `${serviceRoot}/Arch_Containers/64/Arch_Amazon-Elastic-Container-Registry_64.svg`],
  ['ebs', `${serviceRoot}/Arch_Storage/64/Arch_Amazon-Elastic-Block-Store_64.svg`],
  ['vpc', `${serviceRoot}/Arch_Networking-Content-Delivery/64/Arch_Amazon-Virtual-Private-Cloud_64.svg`],
  ['cloudfront', `${serviceRoot}/Arch_Networking-Content-Delivery/64/Arch_Amazon-CloudFront_64.svg`],
  ['nat', 'Resource-Icons_07312026/Res_Networking-Content-Delivery/Res_Amazon-VPC_NAT-Gateway_48.svg'],
  ['igw', 'Resource-Icons_07312026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Internet-Gateway_48.svg'],
];
const localNames = new Set(['git', 'github', 'githubactions', 'pnpm', 'gradle', 'pytest', 'docker',
  'react', 'typescript', 'kotlin', 'fastapi', 'python', 'mysql', 'redis', 'rabbitmq',
  'elasticsearch', 'chrome', 'firefox', 'safari', 'springboot', 'mybatis', 'qdrant', 'openai']);
const localSources = JSON.parse(await fs.readFile(path.join(root, 'logo-sources.json'), 'utf8'));
const sources = [
  ...localSources.filter(asset => localNames.has(asset.name)),
  {name: 'nginx', file: 'nginx.svg', url: 'https://cdn.jsdelivr.net/gh/devicons/devicon@v2.17.0/icons/nginx/nginx-original.svg'},
  {name: 'vercel', file: 'vercel.svg', url: 'https://cdn.jsdelivr.net/gh/devicons/devicon@v2.17.0/icons/vercel/vercel-original.svg'},
  ...awsIcons.map(([name, member]) => ({name, file: path.basename(member), url: awsPackage, archiveMember: member,
    usage: 'https://aws.amazon.com/architecture/icons/'})),
];
const assets = new Map();
const manifest = [];
for (const source of sources) {
  const bytes = await fs.readFile(path.join(root, 'icons', source.file));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (source.sha256 && source.sha256 !== hash) throw new Error(`Logo hash mismatch: ${source.name}`);
  const isSvg = source.file.endsWith('.svg');
  if (isSvg) {
    const value = bytes.toString('utf8');
    if (!/<svg[\s>]/i.test(value) || /<(script|foreignObject)\b|\son\w+\s*=/i.test(value) ||
        /(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(value)) throw new Error(`Unsafe SVG: ${source.name}`);
  } else if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`Invalid PNG: ${source.name}`);
  }
  assets.set(source.name, `data:${isSvg ? 'image/svg+xml' : 'image/png'};base64,${bytes.toString('base64')}`);
  manifest.push({...source, sha256: hash});
}
await fs.writeFile(path.join(root, 'aws-logo-sources.json'), JSON.stringify(manifest, null, 2) + '\n');

const W = 2820, H = 1900;
const p = [];
const ink = '#172B3A', muted = '#526675', line = '#7A8E9C', deploy = '#AD6C1C';
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function text(x, y, value, {size = 22, weight = 400, fill = ink, anchor = 'start', max = 2200} = {}) {
  p.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" data-max-width="${max}">${esc(value)}</text>`);
}
function label(x, y, value, max = 300, fill = muted) {text(x, y, value, {size: 18, anchor: 'middle', max, fill});}
function card(x, y, w, h, fill = '#FFFFFF', stroke = '#D3DEE5', radius = 24) {
  p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
}
function icon(name, x, y, w, h = w) {
  if (!assets.has(name)) throw new Error(`Unknown icon: ${name}`);
  p.push(`<image data-brand="${name}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" href="${assets.get(name)}"/>`);
}
function edge(d, {both = false, cd = false} = {}) {
  const marker = cd ? 'deploy-arrow' : 'arrow';
  p.push(`<path d="${d}" fill="none" stroke="${cd ? deploy : line}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${marker})" ${both ? `marker-start="url(#${marker})"` : ''} ${cd ? 'stroke-dasharray="9 7"' : ''}/>`);
}

p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title description">
<title id="title">GovBiz 시스템 아키텍처 — Vercel 프론트엔드 + AWS 백엔드 ${variant('배포 예정안', '배포 구성')}</title>
<desc id="description">${variant('미배포 설계안. 별도 도메인을 구매하지 않고 Vercel이 제공하는 vercel.app 주소를 사용한다. 브라우저의 화면과 API는 같은 Vercel origin을 사용한다. Vercel external rewrites가 /api 경로를 CloudFront 기본 cloudfront.net HTTPS 주소로 중계한다. CloudFront는 VPC origin으로 비공개 EC2의 Nginx에 내부 HTTP 연결한다. API 캐시는 Vercel과 CloudFront 모두 비활성화한다. Core는 Elasticsearch, Redis, RabbitMQ, 비공개 RDS MySQL 및 FastAPI에 연결한다. FastAPI는 Qdrant와 OpenAI를 호출한다. 외부 공고와 OpenAI 등 인터넷 요청은 NAT Gateway와 Internet Gateway를 경유한다. GitHub 연동 Vercel 배포와 GitHub Actions 이후 ECR 이미지 저장 및 SSM EC2 배포는 구현 예정이다. 단일 EC2이며 고가용성이 아니다. CloudFront와 NAT 등 추가 운영 비용이 있으며 실제 인프라 생성과 인증 검증은 하지 않았다.', '배포 확인 기록과 저장소 설정을 반영한 포트폴리오 운영 구성. govbiz.vercel.app의 화면과 API는 같은 origin을 사용한다. Vercel 서버 미들웨어가 프록시 인증 헤더를 추가하고 /api 요청을 d1zikccbaq81k1.cloudfront.net으로 중계한다. CloudFront VPC origin은 비공개 EC2의 Nginx에 HTTP 80으로 연결한다. Core는 비공개 RDS MySQL, Elasticsearch, Redis, RabbitMQ 및 FastAPI에 연결한다. FastAPI는 Qdrant와 OpenAI를 호출한다. 외부 요청은 NAT Gateway와 Internet Gateway를 경유한다. GitHub Actions는 CI이고, main push 기반 백엔드 배포 설정은 CodeConnections를 통한 CodeBuild 검증, ECR 이미지 게시, SSM의 Core 및 AI 이미지 교체다. Vercel은 별도의 Git 연동 배포다. 단일 EC2이며 고가용성이나 무중단 배포를 보장하지 않는다. 2026-09-16 문서화 시 AWS 세션 만료로 실시간 인프라와 webhook 상태는 재조회하지 못했다.')}</desc>
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${line}"/></marker>
<marker id="deploy-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9Z" fill="${deploy}"/></marker>
</defs>
<style>text{font-family:Arial,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}</style>
<rect width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>`);
text(78, 93, 'GovBiz', {size: 56, weight: 700});
text(295, 91, '시스템 아키텍처', {size: 34, weight: 600});
text(80, 135, 'Vercel 기본 주소 · 동일 출처 /api 프록시 · CloudFront → 비공개 EC2 + RDS MySQL', {size: 23, fill: muted});
card(2250, 60, 495, 58, variant('#FFF5E5', '#EDF9F1'), variant('#EAC68C', '#B6DAC4'), 18);
text(2497, 98, variant('Vercel + AWS · 배포 예정안', 'Vercel + AWS · 배포 완료 구성'), {size: 25, weight: 600, fill: variant('#965B15', '#256B49'), anchor: 'middle', max: 460});
text(2740, 150, variant('2026.09.13 · 미구축 · 실제 배포 상태와 구분', '2026.09.16 정리 · 배포 기록 / 저장소 설정 기준'), {size: 18, fill: muted, anchor: 'end'});
p.push('<path d="M80 183H2740" stroke="#E4EBF0" stroke-width="2"/>');

// Retain the existing backend topology; reserve a separate column outside AWS for Vercel.
p.push('<g transform="translate(420 0)" data-layer="backend-and-ci">');

// Existing CI remains distinct from the proposed image publishing and deployment paths.
card(95, 245, 210, 145, '#FFF9F5', '#EBD8CA');
icon('git', 116, 273, 57); text(190, 296, '개발자', {size: 26, weight: 600, max: 97});
text(190, 334, '로컬 Git', {size: 19, fill: muted, max: 97});
card(445, 245, 230, 145, '#F8FAFC');
icon('github', 467, 270, 66); text(548, 304, 'GitHub', {size: 29, weight: 600, max: 113});
text(548, 339, '소스 저장소', {size: 18, fill: muted, max: 113});
card(850, 220, 600, 190, '#F5F8FE', '#C9D9EF');
icon('githubactions', 875, 246, 59); text(955, 286, 'GitHub Actions', {size: 34, weight: 600});
text(880, 331, variant('전체 CI 검증 + 백엔드 이미지·배포 단계 추가', 'push / PR 테스트·빌드 · 배포 실행과 분리'), {size: 22, max: 550});
icon('pnpm', 880, 358, 29); text(919, 381, 'pnpm', {size: 19});
icon('gradle', 1040, 356, 39); text(1090, 381, 'Gradle', {size: 19});
icon('pytest', 1220, 357, 31); text(1263, 381, 'pytest', {size: 19});
edge('M305 315H445'); label(375, 295, 'git push', 125);
edge('M675 315H850'); label(762, 295, 'CI · push / PR', 160);
if (deployed) {
  card(1630, 220, 700, 190, '#F1F9F5', '#BFDCCA');
  text(1655, 272, 'AWS CodeBuild', {size: 34, weight: 600, max: 645});
  text(1655, 309, 'govbiz-backend-deploy · 백엔드 자동 배포', {size: 22, max: 645});
  text(1655, 345, 'CodeConnections · Core / AI 테스트 + 통합 검증', {size: 21, max: 645});
  text(1655, 381, '검증 통과 후 이미지 게시 · SSM 배포', {size: 20, fill: muted, max: 645});
  edge('M560 245V205H1980V220', {cd: true});
  p.push('<rect x="895" y="192" width="470" height="26" fill="#FFFFFF"/>');
  label(1130, 211, 'main push · PR 병합 / fork 동기화 포함', 450, deploy);
}

// CloudFront (global) and AWS regional management services sit outside the VPC boundary.
card(260, 460, 1815, 1310, '#FFFCF7', '#E9CDA4', 34);
icon('aws', 292, 477, 72, 51); text(385, 515, 'AWS Cloud', {size: 35, weight: 600});
text(625, 511, variant('신규 인프라 · 배포 예정', '시드니 · ap-southeast-2 / CloudFront 글로벌'), {size: 19, fill: '#8E651F', max: 450});
card(325, 540, 560, 145, '#F7F1FC', '#D7C0E8');
icon('cloudfront', 348, 562, 61); text(429, 591, 'Amazon CloudFront', {size: 30, weight: 600, max: 430});
text(429, 632, variant('<distribution>.cloudfront.net', 'd1zikccbaq81k1.cloudfront.net'), {size: 23, weight: 600, max: 430});
text(429, 663, '기본 주소 · HTTPS / TLS 종료 · API 캐시 끔', {size: 19, fill: muted, max: 430});
card(1000, 555, 440, 130, '#FBF3F9', '#DEC4D8');
icon('ssm', 1023, 579, 61); text(1106, 608, 'Systems Manager', {size: 28, weight: 600, max: 310});
text(1106, 650, 'SSM · EC2 배포 명령 실행', {size: 20, max: 310});
card(1620, 555, 395, 130, '#FFF5EC', '#E4C9AA');
icon('ecr', 1645, 579, 61); text(1727, 607, 'Amazon ECR', {size: 31, weight: 600, max: 262});
text(1727, 649, '버전별 Docker 이미지 보관', {size: 20, max: 262});

card(290, 705, 1755, 1030, '#F8FAFD', '#C7D3E2', 28);
icon('vpc', 316, 717, 36); text(367, 743, 'VPC · 애플리케이션 / 데이터베이스 네트워크', {size: 22, weight: 600, max: 755});
card(320, 770, 1310, 930, '#FFF9F0', '#E0BA85', 28);
icon('ec2', 343, 786, 50); text(410, 820, variant('Amazon EC2 · 1대', 'Amazon EC2 · govbiz-app · 1대'), {size: 30, weight: 600});
text(1600, 817, '프라이빗 서브넷 · CloudFront VPC origin만 진입', {size: 19, fill: muted, anchor: 'end', max: 620});
card(345, 850, 1260, 785, '#F7FAFC', '#C5D8E4', 25);
icon('docker', 365, 859, 49, 33); text(428, 884, 'Docker Compose', {size: 24, weight: 600});

// Private database: not another container on the application EC2 host.
card(1680, 840, 355, 255, '#F0F5FF', '#CBD9ED', 24);
text(1701, 875, 'PRIVATE · DB 서브넷 그룹', {size: 19, weight: 600, fill: '#446588', max: 315});
card(1710, 900, 295, 165, '#F7FAFF', '#C8D9EE');
icon('rds', 1733, 922, 50); text(1800, 956, 'Amazon RDS', {size: 25, weight: 600, max: 185});
icon('mysql', 1733, 985, 55, 43); text(1800, 1014, 'MySQL', {size: 29, weight: 600});
text(1800, 1043, variant('원본 데이터 · 백업', 'MySQL 8.4 · 원본 DB'), {size: 18, max: 185});

// Proposed CD: ECR image retrieval and remote deployment commands are distinct.
if (deployed) {
  edge('M2280 410V530H1817V555', {cd: true});
  label(2130, 513, '이미지 push · digest 고정', 370, deploy);
  edge('M1690 410V470H1215V555', {cd: true});
  text(1240, 511, '검증 통과 → SSM', {size: 18, fill: deploy, max: 290});
} else {
  edge('M1450 315H1817V555', {cd: true}); label(1635, 294, '이미지 push · OIDC', 330, deploy);
  edge('M1180 410V555', {cd: true}); text(1200, 486, '승인 후 배포 · OIDC', {size: 18, fill: deploy, max: 295});
}
edge('M1215 685V770', {cd: true}); text(1240, 734, '배포 명령', {size: 18, fill: deploy, max: 160});
edge('M1620 635H1535V770', {cd: true}); text(1512, 734, '이미지 pull', {size: 18, fill: deploy, anchor: 'end', max: 150});

// Runtime paths, routed through clear gutters between nodes.
edge('M325 665H275V1255H375', {both: true});
edge('M610 1255H785', {both: true}); label(698, 1235, '/api/*', 155); label(698, 1285, '프록시', 155);
edge('M1135 1260H1260', {both: true}); label(1197, 1238, '내부 HTTP', 114);
edge('M785 1180H740V970H610', {both: true}); label(678, 947, '복원 상태', 116);
edge('M960 1130V1040', {both: true}); text(982, 1092, '키워드 검색', {size: 18, fill: muted, max: 145});
edge('M1100 1130V1080H1655V1000H1710', {both: true}); label(1430, 1062, variant('SQL · MyBatis', 'SQL · MyBatis · TLS'), 240);
edge('M1135 1185H1200V1105H2095V1055H2130', {both: true}); label(1820, 1135, '공고 수집 · 원문 조회', 285);
label(1820, 1162, 'HTTPS · NAT / IGW 경유', 285);
edge('M1570 1260H2130', {both: true}); label(1850, 1240, 'HTTPS · 임베딩 / LLM', 335);
label(1850, 1290, 'NAT / IGW 경유', 335);
edge('M960 1390V1490', {both: true}); text(984, 1449, '작업 발행 · 소비', {size: 18, fill: muted, max: 225});
edge('M1415 1390V1490', {both: true}); text(1436, 1449, '벡터 저장 · 검색', {size: 18, fill: muted, max: 183});

card(375, 900, 235, 140, '#FFF5F4', '#EAC9C5');
icon('redis', 394, 921, 47); text(455, 951, 'Redis', {size: 31, weight: 600, max: 130});
text(395, 991, '로그인 전 검색 결과·조건', {size: 18, max: 195});
text(395, 1022, '로그인 복원 · TTL 30분', {size: 17, fill: muted, max: 195});
card(785, 900, 350, 140, '#FFFBEF', '#E6DCAE');
icon('elasticsearch', 809, 922, 51); text(878, 955, 'Elasticsearch', {size: 28, weight: 600, max: 232});
text(809, 998, 'Nori · BM25 키워드 검색', {size: 21, max: 300});
text(809, 1026, '현재 엔진 유지 · OpenSearch 아님', {size: 17, fill: muted, max: 300});
text(1280, 946, '컨테이너 내부 통신', {size: 22, weight: 600, max: 290});
text(1280, 982, 'AI · 검색 엔진 · 큐', {size: 21, fill: muted, max: 290});
text(1280, 1014, '인터넷에 직접 공개하지 않음', {size: 19, fill: muted, max: 290});

card(375, 1130, 235, 260, '#F0FCF7', '#B8DEC9');
text(394, 1162, 'PRIVATE ORIGIN', {size: 17, weight: 600, fill: '#3E7063', max: 195});
icon('nginx', 395, 1184, 51); text(461, 1220, 'Nginx', {size: 29, weight: 600, max: 128});
text(395, 1256, 'VPC 내부 API 프록시', {size: 18, max: 195});
text(395, 1302, '내부 HTTP :80', {size: 21, weight: 600, max: 195});
text(395, 1335, '공인 IP · 별도 도메인 없음', {size: 17, fill: muted, max: 195});
text(395, 1376, 'API 전용 · 정적 화면 없음', {size: 17, fill: muted, max: 195});
card(785, 1130, 350, 260, '#F0F8EC', '#C4DBB5');
text(809, 1162, 'CORE API · :8080', {size: 17, weight: 600, fill: '#587449'});
icon('springboot', 808, 1181, 59); text(884, 1222, 'Spring Boot', {size: 29, weight: 600, max: 230});
icon('kotlin', 809, 1251, 26); text(846, 1273, 'Kotlin', {size: 18});
icon('mybatis', 963, 1246, 147, 37);
text(809, 1314, '검색 · 계정 · 대화 · RAG', {size: 21, max: 300});
text(809, 1346, '키워드 + 의미 검색 결합 · RRF', {size: 18, fill: muted, max: 300});
text(809, 1376, '스케줄러 / 작업 큐 소비자', {size: 18, fill: muted, max: 300});
card(1260, 1130, 310, 260, '#F0FAFA', '#BEDDD9');
text(1281, 1162, 'AI SERVICE · :8000', {size: 17, weight: 600, fill: '#387C75'});
icon('fastapi', 1280, 1181, 58); text(1354, 1222, 'FastAPI', {size: 31, weight: 600, max: 194});
icon('python', 1282, 1251, 29); text(1324, 1275, 'Python', {size: 20});
text(1281, 1320, '조건 해석 · 추천 점수화', {size: 20, max: 267});
text(1281, 1358, '임베딩 · 근거 답변 · 검토', {size: 20, max: 267});

card(785, 1490, 350, 130, '#FFF8ED', '#DCA353');
icon('rabbitmq', 809, 1516, 54); text(882, 1545, 'RabbitMQ', {size: 30, weight: 600, max: 230});
text(882, 1583, '리포트 · 중복 검토 작업 큐', {size: 19, max: 232});
card(1260, 1490, 310, 130, '#FCF3F7', '#E9C4D2');
icon('qdrant', 1282, 1519, 55); text(1355, 1545, 'Qdrant', {size: 31, weight: 600, max: 195});
text(1355, 1583, '공고 · 근거 벡터', {size: 19, max: 195});
// Logical application arrows above share this outbound route; it is not the ingress route.
card(1680, 1360, 355, 315, '#F7F4FB', '#D5C9E4', 24);
text(1705, 1400, 'OUTBOUND · 인터넷 요청 경로', {size: 19, weight: 600, max: 310});
icon('nat', 1710, 1424, 44); text(1776, 1454, 'NAT Gateway', {size: 24, weight: 600, max: 235});
text(1705, 1490, '퍼블릭 서브넷 · EIP · 별도 비용', {size: 18, fill: muted, max: 310});
edge('M1855 1508V1540');
icon('igw', 1710, 1552, 44); text(1776, 1583, 'Internet Gateway', {size: 22, weight: 600, max: 235});
text(1705, 1634, 'EC2 → NAT → IGW → 외부 API', {size: 18, fill: muted, max: 310});
icon('ebs', 366, 1651, 31); text(411, 1675, variant('EBS 영속 볼륨 · Elasticsearch / Redis / RabbitMQ / Qdrant 데이터 보관', 'EBS 40 GiB · Elasticsearch / Redis / RabbitMQ / Qdrant 영속 데이터'), {size: 20, fill: muted, max: 1160});
text(2020, 1757, '단일 EC2 · 고가용성 / 무중단 배포 구성 아님', {size: 19, fill: '#8E651F', anchor: 'end', max: 830});

// Internet clients and external APIs are outside the AWS boundary.
text(65, 1155, '사용자', {size: 29, weight: 600, anchor: 'middle'});
icon('chrome', 41, 1182, 49); icon('firefox', 41, 1251, 49); icon('safari', 41, 1320, 49);
text(65, 1405, '브라우저', {size: 21, fill: muted, anchor: 'middle'});
text(2130, 926, 'EXTERNAL SERVICES', {size: 16, weight: 600, fill: muted, max: 225});
card(2130, 955, 220, 200, '#FAF9F5', '#E1DCD0');
text(2240, 999, '공식 공고 API', {size: 24, weight: 600, anchor: 'middle', max: 190});
label(2240, 1040, '기업마당 · K-Startup', 192);
label(2240, 1076, '과기정통부 · 충남 공지', 192);
text(2240, 1121, '제공처별 설정에 따라 사용', {size: 15, anchor: 'middle', fill: muted, max: 195});
card(2130, 1200, 220, 240, '#FFFFFF', '#C9D4DB');
icon('openai', 2203, 1222, 74);
text(2240, 1340, 'OpenAI', {size: 34, weight: 600, anchor: 'middle', max: 190});
label(2240, 1384, '임베딩 · LLM API', 190);
p.push('</g>');

// Vercel external rewrites preserve /api; browser requests never change to the AWS origin.
card(75, 720, 510, 310, '#F7F9FC', '#CCD6E0', 28);
text(101, 756, 'FRONTEND · 별도 배포', {size: 18, weight: 600, fill: muted, max: 450});
icon('vercel', 102, 784, 62); text(188, 829, 'Vercel', {size: 39, weight: 600, max: 355});
icon('react', 101, 863, 47); text(169, 898, 'React', {size: 31, weight: 600, max: 115});
icon('typescript', 307, 873, 31); text(354, 898, 'TypeScript', {size: 22, max: 200});
text(101, 943, variant('<project>.vercel.app · HTTPS', 'govbiz.vercel.app · HTTPS'), {size: 24, weight: 600, max: 455});
text(101, 979, variant('/api/* → AWS 프록시 · 화면은 CDN', '/api/* → 서버 미들웨어 → AWS'), {size: 22, max: 455});
text(101, 1010, variant('기본 주소 사용 · API 캐시 끔 · 배포 전', '인증 헤더 추가 · API 캐시 끔 · 화면은 CDN'), {size: 17, fill: muted, max: 455});
edge('M585 935H640V595H745', {both: true});
text(649, 574, 'HTTPS', {size: 18, fill: muted, max: 85});
text(674, 1187, 'VPC origin', {size: 19, fill: muted, anchor: 'end', max: 155});
text(674, 1216, '비공개 연결', {size: 18, fill: muted, anchor: 'end', max: 155});
edge('M980 390V430H330V720', {cd: true});
text(351, 595, '프론트 Git 연동', {size: 21, fill: deploy, max: 300});
text(351, 632, variant('빌드 · 배포 예정', 'Vercel 빌드 · 자동 배포'), {size: 20, fill: deploy, max: 300});
edge('M485 1030V1120', {both: true});
text(459, 1070, '화면 + API · HTTPS', {size: 20, fill: muted, anchor: 'end', max: 300});
text(459, 1100, '같은 Vercel 주소 · /api', {size: 17, fill: muted, anchor: 'end', max: 300});

p.push('<path d="M80 1810H2740" stroke="#E4EBF0" stroke-width="2"/>');
text(80, 1848, variant('주황 점선: 추가할 배포 경로 · Vercel + AWS 배포 예정안이며 실제 구축·검증 완료를 의미하지 않음', '실선: 서비스 통신 · 주황 점선: 배포 경로 · CodeBuild는 Core / AI 이미지만 교체 · 운영 환경값·Compose는 별도 관리'), {size: 20, fill: '#8E651F', max: 2640});
text(80, 1880, variant('별도 도메인 구매 없음 · 주소는 예시 · CloudFront / NAT 운영 비용 발생 · 쿠키·OAuth·API 캐시 금지·시간 제한은 배포 시 검증 · IAM·라우팅·백업 세부 생략 · ALB / S3 / ECS 미포함', '기존 배포 확인 기록 + 저장소 설정 기준 · 작성 시 AWS 세션 만료로 실시간 상태 재조회 안 됨 · 단일 EC2 / 중단 가능 · OAuth·백업 복구·부하 검증 완료를 뜻하지 않음 · 비밀값 미표기'), {size: 16, fill: muted, max: 2640});
p.push('</svg>');
const svg = p.join('\n');
await fs.writeFile(path.join(root, `${basename}.svg`), svg);
console.log(`Created ${basename}.svg and aws-logo-sources.json`);

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
    const errors = await page.evaluate(({W, H}) => {
      const frame = document.querySelector('svg').getBoundingClientRect();
      return [...document.querySelectorAll('svg text')].flatMap(node => {
        const b = node.getBoundingClientRect(), limit = Number(node.dataset.maxWidth);
        const x = b.left - frame.left, y = b.top - frame.top;
        return b.width > limit || x < 0 || y < 0 || x + b.width > W || y + b.height > H
          ? [{text: node.textContent, width: b.width, limit, x, y}] : [];
      });
    }, {W, H});
    if (errors.length) throw new Error(`Text bounds failed: ${JSON.stringify(errors)}`);
    const shown = await page.locator('image').evaluateAll(nodes => new Set(nodes.map(n => n.dataset.brand)).size);
    if (shown !== assets.size) throw new Error(`Unused logo: ${assets.size - shown}`);
    await page.screenshot({path: path.join(root, `${basename}.png`), fullPage: true});
    console.log(`Created ${basename}.png (${W * 2} × ${H * 2}); ${shown} logos and text bounds verified`);
  } finally {
    await browser.close();
  }
}
