/**
 * 중복 검토 근거 원문을 화면에 보여 줄 줄 목록으로 정리합니다. 저장된 인용문은 바꾸지 않고, 웹과 모바일이 같은 규칙으로 보여 줍니다.
 * PDF는 화면 줄바꿈이 문장 중간에 남고, HWP·HWPX는 표 칸 하나가 한 줄이 되며, 글꼴 전용 문자 · 쪽 번호 · 출력 도장이 섞여 들어옵니다.
 * 규칙은 공고 485개의 첨부 1,027개(인용 후보 10,468개)와 그 표본 250개를 사람이 읽어 판정한 결과로 맞췄습니다.
 */
export type EvidenceLine = {
  kind: 'heading' | 'item' | 'note' | 'table' | 'text'
  /** 글머리 단계입니다. □ 1단, ◦ ○ ❍ • 2단, ▪ - · 3단. */
  level: 1 | 2 | 3
  marker: string
  text: string
  /** 중복 · 제한 · 환수처럼 검토와 관련된 낱말이 든 줄입니다. */
  related: boolean
}

export type EvidencePreviewEntry = { type: 'line'; line: EvidenceLine } | { type: 'gap'; count: number }

// BMP 사용자 정의 영역과 한글 문서가 쓰는 보충 사용자 정의 영역(동그라미 번호 등)입니다. 화면에서는 네모 상자로 보입니다.
const privateUse = /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu
// 쪽 번호("- 4 -", "(2쪽 중 2쪽)")와 출력 도장("정책매장운영팀 1230013 2026/08/31-10:27:41")입니다.
const stampLine = /^\s*(?:-\s?\d{1,3}\s?-|.*\d{4}\/\d{2}\/\d{2}-\d{2}:\d{2}(?::\d{2})?|\(?\d{1,3}\s?쪽\s?중\s?\d{1,3}\s?쪽\)?)\s*$/
// 빈 서식 자리입니다. 날짜 자리는 연도만 있거나 월·일이 비었을 때만 지웁니다("생년월일", "2026년 3월 27일"은 그대로).
const placeholderLine = /^(?:ㅇ|-|·|\.|[.\s·]+|[\s⇨➡→↓▼⇩➜]+|\((?:인|서명|날인)[^)]*\)|[0O○]{2,}[0O○.,\s]*(?:명|원|천원|백만원|개사|개|%)?|ㅇㅇ.*|(?:\d{4}|20XX)?\s*년\s*(?:0{0,2}|X{0,2}|dd)\s*월\s*(?:0{0,2}|X{0,2}|dd)\s*일|\d{2,4}\s*(?:\.\s*){2,3})$/
// 서명란입니다("대표자 : (서명 또는 날인)", "성명 : 홍길동 (인)"). 서식 여부와 관계없이 지웁니다.
const signatureLine = /^(?:성\s*명|대\s*표\s*자|신\s*청\s*인|기\s*업\s*명|업\s*소\s*명|신청기업|동의자(?:\s*확인)?)\s*:?.*\((?:서명|인|날인)[^)]*\)\s*$/
// 빈 서식에서만 지우는 값 없는 칸 이름입니다("주소 :").
const emptyFormField = /^[가-힣·\s]{1,12}:\s*(?:\((?:인|서명|날인)[^)]*\))?$/
// 숫자 글머리는 소수("1.01%")와 구분하고, 라틴 o·전각 ｏ·자모 ㅇ도 글머리로 씁니다.
const markerPattern = /^(□|▢|■|❏|☑|◦|○(?!○)|〇|❍|●|•|⦁|∘|￭|▸|▶|▪|ㆍ|·|-|–|※|✽|＊|\*{1,4}|♣|[ㅇᄋoOｏ](?=\s)|[ㅇᄋ](?=[가-힣(「『“‘[])|[①-⑳]|[❶-❿]|[➀-➉]|[➊-➓]|[㉑-㉟]|\d{1,2}(?:\.(?!\d)|\))|[가-하](?:\.(?=\s)|\))|\(\d{1,2}\)(?!\s*\|)|➡|↓)\s*/
// PDF 기호 글꼴이 라틴 문자로 잘못 읽힌 글머리(Ÿ, ¦ 등)입니다.
const misreadBullet = /(^|\s)[œŸØøü¡¤¨Þþ¦ž](?=\s)/g
// PDF Wingdings 글머리가 라틴 소문자로 읽힌 경우입니다(l ● · m ❍ · n ■ · q ❑ · u ◆ · v ❖). PDF에서 줄 첫머리 뒤에 한글이 올 때만 바꿉니다.
const misreadWingdingsBullet = /^[lmnquv§](?=\s+[가-힣(「])/
// 그 밖의 기호 글머리입니다. 글자·숫자가 아닌 기호 하나 뒤에 공백이 오면 글머리로 봅니다(따옴표·괄호·물결·등호·마침표 같은 문장 부호는 제외).
const genericMarker = /^((?![~～=+<>%.,:;'"’‘“”/\u{5C}()\u{3008}-\u{3011}\u{3014}-\u{301B}［］｢｣])[\u{2010}-\u{2BFF}\u{3000}-\u{303F}\u{3200}-\u{32FF}\u{FF01}-\u{FF0F}\u{FFE8}-\u{FFEE}\u{00A7}\u{00B6}\u{00B7}ﾷ᧛#]|\u{20DD}|\u{20DE})\s+(?=\S)/u
// 화살표·네모·체크 상자·가운뎃점처럼 글머리로만 쓰이는 기호는 뒤에 공백이 없어도 글머리로 봅니다("➜신청").
const tightMarker = /^([\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2610}-\u{2612}\u{261B}-\u{261F}\u{2022}\u{2023}\u{2700}-\u{27BF}\u{2B05}-\u{2B07}\u{2B60}-\u{2B9F}\u{2024}\u{2219}\u{22C5}\u{30FB}\u{FF65}])\s*(?=[가-힣A-Za-z0-9([「『<])/u
const startsWithMarker = (line: string) => markerPattern.test(line) || genericMarker.test(line) || tightMarker.test(line)
// PDF Wingdings 동그라미 숫자가 Windows-1252 자리로 읽힌 글자입니다(Œ ① · 0x8D ② · Ž ③ · 0x8F ④ · 0x90 ⑤).
const misreadCircledNumbers: Record<string, string> = { 'Œ': '①', '\u008D': '②', 'Ž': '③', '\u008F': '④', '\u0090': '⑤' }
const misreadCircledNumber = /(?<![A-Za-z])[Œ\u008DŽ\u008F\u0090](?![A-Za-z])/g
// 장 번호만 따로 떨어진 줄입니다(Ⅳ, 3). 숫자는 다음 줄이 짧은 제목일 때만 잇습니다.
const sectionNumber = /^(?:([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])|(\d{1,2}))\.?$/
const shortTitle = /^[가-힣A-Za-z·,\s()]{2,25}$/
// 문장 끝입니다. 명사형 끝맺음("기재", "제외")도 끝으로 보고, 숫자 뒤 마침표("2026. 10. 14.")는 끝으로 보지 않습니다.
const sentenceEndPattern = /(?:다|함|음|임|됨|요|것|람|니다|시오|까|기재|작성|제출|참고|요망|가능|불가|필수|금지|제외|처리|예정)[.)\]」』]?$|[:;!?。]$|(?<!\d)\.$/
const headingPattern = /^(?:\d{1,2}\.(?!\d)|[가-하]\.(?=\s)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\.?|제\s?\d{1,2}\s?장)\s*(?=.*[가-힣A-Za-z])\S/
const notHeading = /「|제\s?\d+\s?조|:|[에및의을를등]$|(?:다|함|음|임|됨)\.?$|[.;!?]$/
const levels: Record<string, 1 | 2 | 3> = { '□': 1, '▢': 1, '■': 1, '❏': 1, '☑': 1, '▪': 3, 'ㆍ': 3, '·': 3, '-': 3, '–': 3, '․': 3, '‣': 3 }
// 검토와 관련된 낱말입니다. 조사를 허용하고("선정이 취소"), "기타 사업" · "가동시작" · "사업자" 같은 겹침은 피합니다.
const keywordSource = [
  '중복', '환수', '병행\\s?(?:지원|수혜|참여|수행|신청)', '내용(?:과|이)\\s?동일', '반환\\s?명령', '재신청\\s?불가', '신청을?\\s?금지', '3책\\s?5공', '기\\s?수혜', '수혜\\s?(?:이력|기업|자)', '제외\\s?대상',
  '(?:참여|신청|지원|대출|융자|지급)[을를이가은는]?\\s?(?:제한|불가)',
  '(?:선정|지원|승인|협약|융자|교부\\s?결정)[을를이가은는]?\\s?(?:취소|중단)',
  '(?:대상|사업|지원|평가|선정)(?:에서)?\\s?(?:우선\\s?)?제외',
  '동일(?:한)?\\s?(?:및\\s?유사\\s?)?(?:사업|과제|서비스|기술|아이템|항목)',
  '유사(?:한)?\\s?(?:지원\\s?)?사업',
  '(?<![가-힣])동시(?:에|\\s?(?:지원|신청|수혜|참여|수행|접수))',
  '(?<![가-힣])(?:다른|타(?![당인입]))\\s?[가-힣·/]{0,10}(?:\\s[가-힣·/]{1,10})?\\s?(?:사업|과제|지원금)(?![자장])',
  '(?<![가-힣])타\\s?기관',
].join('|')
const relatedPattern = new RegExp(keywordSource)
const keywords = new RegExp(keywordSource, 'g')
// 개인정보 동의서의 이용 목적 문구("참여제한 여부 확인")는 근거가 아니라서 관련 줄로 치지 않습니다.
const consentLine = /수집[·‧ㆍ]?\s?이용\s?목적|동의(?:함|합니다|하십니까|하지\s?않음)/
const formSignals = [/작성요령/, /제출 시 삭제/, /\(인\)|\(서명|날인/, /년\s+월\s+일|20XX|00\s?월/, /ㅇㅇ/, /기재내용/, /신청서|서약서|확약서|동의서/]

/** 줄바꿈 · 탭을 뺀 제어 문자(C0 · C1)와 보이지 않는 서식 문자입니다. 원문 추출에서 섞여 들어와 화면에 보이지 않는 글자로 남습니다. */
const isControlCharacter = (code: number) => (code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f) || code === 0xad || (code >= 0x200b && code <= 0x200f) || code === 0xfeff

/** 한 줄의 공백 · 글꼴 전용 문자 · 자간을 벌린 제목을 정리합니다. NUL은 칸 구분자라 공백으로 바꿉니다. */
function cleanLine(line: string): string {
  return [...line.split(String.fromCharCode(0)).join(' ').replace(misreadCircledNumber, (character) => misreadCircledNumbers[character] ?? character)]
    .filter((character) => !isControlCharacter(character.codePointAt(0)!)).join('').trim()
    // 줄 첫머리의 글꼴 전용 문자는 글머리 기호라 •로 바꾸고, 그 밖의 자리에서는 지웁니다.
    .replace(privateUse, (_match, offset: number) => offset === 0 ? '•' : '')
    .replace(misreadBullet, '$1•')
    .replace(/(?<=[가-힣])ž(?=[가-힣])/g, '·')
    .replace(/\s+ð\s+/g, ' → ')
    // "사 업 명 :", "성 주 군 수", "동 의"처럼 글자 사이를 벌린 제목만 붙입니다(문장 속 한 글자 낱말은 그대로 둡니다).
    .replace(/^((?:□|◦|○|❍|•|\d{1,2}\.)\s*)?((?:[가-힣]\s+)+[가-힣])(?=\s*:)/, (_match, marker: string | undefined, label: string) => `${marker ?? ''}${label.replace(/\s+/g, '')}`)
    .replace(/^(?:[가-힣]\s+)+[가-힣]$/, (label) => label.replace(/\s+/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 문장이 끝난 줄인지 봅니다. 괄호가 덜 닫혔거나("…포함") 한 글자 조각으로 끝나면("있어서 다") 끝나지 않은 것으로 봅니다. */
function endsSentence(line: string): boolean {
  if (!sentenceEndPattern.test(line) || /\s[가-힣]$/.test(line)) return false
  return line.split('(').length <= line.split(')').length
}

function isRelated(text: string): boolean {
  return !consentLine.test(text) && relatedPattern.test(text.replace(/「[^」]*」/g, ''))
}

function classify(text: string): Omit<EvidenceLine, 'related'> {
  if (headingPattern.test(text) && text.length <= 30 && !notHeading.test(text)) return { kind: 'heading', level: 1, marker: '', text }
  const match = markerPattern.exec(text) ?? genericMarker.exec(text) ?? tightMarker.exec(text)
  if (!match) return { kind: 'text', level: 1, marker: '', text }
  const marker = match[1]!.replace(/\s+/g, '')
  const body = text.slice(match[0].length).trim()
  if (marker === '※' || marker === '✽' || marker === '＊' || marker.startsWith('*')) return { kind: 'note', level: 3, marker, text: body }
  return { kind: 'item', level: levels[marker] ?? 2, marker, text: body }
}

type PhysicalLine = { raw: string; text: string; trailingSpace: boolean }

/**
 * PDF 줄 잇기를 해도 되는 원문 조각인지 봅니다. 빈 서식, 체크 상자가 많은 표, 행 번호가 붙은 표는 줄을 이으면 칸이 한 덩어리로 뭉칩니다.
 */
function allowsPdfJoin(text: string, lines: readonly PhysicalLine[]): boolean {
  if (isApplicationFormText(text)) return false
  // 줄 첫머리의 □는 장 글머리라 빼고, 줄 안에 든 체크 상자만 셉니다.
  const checkboxes = lines.reduce((count, line) => count + (line.text.replace(/^[□☐]\s*/, '').match(/[□☐]/g)?.length ?? 0), 0)
  if (checkboxes >= 4) return false
  return lines.filter((line) => /^\d{1,3}\s+\S/.test(line.text)).length < 3
}

/**
 * PDF 앞줄과 이을지 정합니다. 앞줄이 조각 안의 가장 긴 줄만큼 꽉 차 있고(오른쪽 끝에서 줄이 바뀐 것) 문장이 끝나지 않았을 때만 잇습니다.
 * 칸 사이가 크게 벌어진 줄, 점수 칸으로 끝나는 줄, 괄호만 있는 줄, 한두 글자짜리 세로 칸 글자, 제목·글머리로 시작하는 줄은 잇지 않습니다.
 */
function continuesPdfLine(previous: PhysicalLine, joinedPrevious: string, current: PhysicalLine, fullWidth: number): boolean {
  if (previous.text.length < Math.max(18, fullWidth * 0.75)) return false
  if (joinedPrevious.length + current.text.length >= 200) return false
  if (endsSentence(joinedPrevious) || startsWithMarker(current.text) || headingPattern.test(current.text)) return false
  if (/\S {3,}\S/.test(previous.raw) || /\S {3,}\S/.test(current.raw)) return false
  return !/\s\d{1,3}(?:점)?$/.test(previous.text) && !/^\(.*\)$/.test(previous.text) && !/^[가-힣]{1,2}$/.test(current.text)
}

/** 원문 조각을 화면에 보여 줄 줄 목록으로 정리합니다. format은 원문 파일 형식(PDF · HWP · HWPX · DOCX · XLSX)입니다. */
export function formatEvidenceText(text: string, format: string): EvidenceLine[] {
  const form = isApplicationFormText(text)
  const physical: PhysicalLine[] = text.split('\n')
    .filter((raw) => !stampLine.test(raw))
    .map((raw) => {
      const line = raw.replace(/\r$/, '')
      const cleaned = cleanLine(line)
      return { raw: line, trailingSpace: /[ \t]$/.test(line), text: format === 'PDF' ? cleaned.replace(misreadWingdingsBullet, '•') : cleaned }
    })
    .filter((line) => line.text && !placeholderLine.test(line.text) && !signatureLine.test(line.text) && !(form && emptyFormField.test(line.text)))
  const pdfJoin = format === 'PDF' && allowsPdfJoin(text, physical)
  const fullWidth = Math.max(0, ...physical.map((line) => line.text.length))
  // 원문 줄 끝에 공백을 남기는 PDF는 낱말 사이에서만 공백을 남겨서, 공백 없이 바뀐 줄은 낱말 중간("세금계 / 산서")으로 보고 붙여 씁니다.
  const spaceSignal = physical.some((line) => line.trailingSpace)
  const joined: string[] = []
  physical.forEach((line, index) => {
    const previous = joined.at(-1)
    const previousLine = physical[index - 1]
    const section = previous === undefined ? null : sectionNumber.exec(previous)
    if (previous !== undefined && section && (section[1] || shortTitle.test(line.text))) joined[joined.length - 1] = `${section[1] ?? `${section[2]}.`} ${line.text}`
    else if (previous !== undefined && line.text.startsWith(':')) joined[joined.length - 1] = `${previous} ${line.text}`
    else if (previous !== undefined && previousLine && pdfJoin && continuesPdfLine(previousLine, previous, line, fullWidth)) {
      const glue = spaceSignal && !previousLine.trailingSpace && /[가-힣]$/.test(previous) && /^[가-힣]/.test(line.text) ? '' : ' '
      joined[joined.length - 1] = `${previous}${glue}${line.text}`
    } else joined.push(line.text)
  })
  // 표 칸이 한 줄씩 풀린 부분(글머리 없는 짧은 줄 4개 이상)은 "표" 한 줄로 묶습니다. 숫자·날짜만 있는 칸도 표 칸으로 보고, 12칸마다 끊습니다.
  const tableCell = (line: string) => line.length <= 16 && !startsWithMarker(line) && !/^(?:\[(?:별지|붙임|서식)|【)/.test(line)
    && (!/(?:다|니다|요)\.?$|[.!?。]$/.test(line) || /^[\d.,%~\s-]+$/.test(line))
  const classified: Omit<EvidenceLine, 'related'>[] = []
  for (let start = 0; start < joined.length;) {
    let end = start
    while (end < joined.length && end - start < 12 && tableCell(joined[end]!)) end += 1
    if (end - start >= 4) {
      classified.push({ kind: 'table', level: 1, marker: '', text: joined.slice(start, end).join(' · ') })
      start = end
    } else {
      classified.push(classify(joined[start]!))
      start += 1
    }
  }
  return reviseLines(classified).map((line) => ({ ...line, related: line.kind !== 'table' && isRelated(line.text) }))
}

/** 번호 계열입니다. "2. …" 제목과 "3." 글머리가 이웃하면 같은 목록입니다. */
function numberingOf(line: Omit<EvidenceLine, 'related'>): string | null {
  const source = line.kind === 'heading' ? line.text : line.kind === 'item' ? line.marker : ''
  if (/^\d{1,2}[.)]/.test(source)) return 'digit'
  if (/^[가-하][.)]/.test(source)) return 'hangul'
  return null
}

/**
 * 줄 판정을 이웃 줄과 맞춥니다. 같은 번호 목록이 이웃하면 제목이 아니라 글머리로 보고,
 * 본문 없는 글머리는 번호면 다음 줄에 붙이고, 기호면 지웁니다.
 */
function reviseLines(lines: Omit<EvidenceLine, 'related'>[]): Omit<EvidenceLine, 'related'>[] {
  const revised = lines.map((line, index) => {
    const family = line.kind === 'heading' ? numberingOf(line) : null
    if (!family) return line
    const neighbors = [index - 2, index - 1, index + 1, index + 2].map((other) => lines[other]).filter((other) => other !== undefined)
    if (!neighbors.some((other) => numberingOf(other) === family)) return line
    const match = /^(\d{1,2}[.)]|[가-하][.)])\s*/.exec(line.text)!
    return { kind: 'item' as const, level: 2 as const, marker: match[1]!, text: line.text.slice(match[0].length) }
  })
  const result: Omit<EvidenceLine, 'related'>[] = []
  revised.forEach((line, index) => {
    if ((line.kind !== 'item' && line.kind !== 'note') || !/^[\s.·]*$/.test(line.text)) { result.push(line); return }
    const next = revised[index + 1]
    if (/[\d①-⑳❶-❿➀-➓㉑-㉟]/.test(line.marker) && next && next.kind === 'text') revised[index + 1] = { ...next, kind: 'item', level: line.level, marker: line.marker }
  })
  return result
}

const rank = (line: EvidenceLine) => line.kind === 'heading' ? 0 : line.kind === 'item' ? line.level : line.kind === 'note' ? 4 : 5
const isHeader = (line: EvidenceLine) => line.kind === 'heading' || (line.kind === 'item' && line.level === 1) || (line.kind === 'text' && line.text.length <= 20 && !endsSentence(line.text))

/**
 * 기본 보기입니다. 관련 낱말이 든 줄과 앞뒤 한 줄, 그 줄이 딸린 상위 항목(가까운 제목이나 더 높은 단계 글머리)을 보이고 나머지는 접힌 줄 수로 바꿉니다.
 * 관련 줄이 □ 머리나 짧은 제목이면 딸린 줄을 다음 같은 단계 머리까지(최대 6줄) 함께 보입니다.
 * 관련 줄이 없으면 불가 · 금지 · 취소 같은 약한 신호 줄을, 그것도 없으면 표를 뺀 앞 fallback줄을 보입니다.
 */
export function evidencePreview(lines: readonly EvidenceLine[], fallback = 6): EvidencePreviewEntry[] {
  const keep = new Set<number>()
  const related = lines.flatMap((line, index) => line.related ? [index] : [])
  for (const index of related) {
    [index - 1, index, index + 1].forEach((value) => keep.add(value))
    const line = lines[index]!
    for (let above = index - 1; above >= Math.max(0, index - 8); above -= 1) {
      if (rank(lines[above]!) < rank(line)) { keep.add(above); break }
    }
    if (isHeader(line)) {
      for (let below = index + 1; below < lines.length && below <= index + 6; below += 1) {
        const next = lines[below]!
        if (next.kind === 'heading' || (next.kind === 'item' && rank(next) <= rank(line))) break
        keep.add(below)
      }
    }
  }
  if (related.length === 0) {
    const weak = lines.flatMap((line, index) => line.kind !== 'table' && /불가|금지|제외|취소|제한|반환/.test(line.text) ? [index] : [])
    if (weak.length > 0) weak.forEach((index) => [index - 1, index, index + 1].forEach((value) => keep.add(value)))
    else lines.flatMap((line, index) => line.kind === 'table' ? [] : [index]).slice(0, fallback).forEach((index) => keep.add(index))
  }
  const entries: EvidencePreviewEntry[] = []
  let hidden = 0
  lines.forEach((line, index) => {
    if (!keep.has(index)) { hidden += 1; return }
    if (hidden > 0) entries.push({ type: 'gap', count: hidden })
    hidden = 0
    entries.push({ type: 'line', line })
  })
  if (hidden > 0) entries.push({ type: 'gap', count: hidden })
  return entries
}

/** 강조할 낱말과 나머지를 나눕니다. */
export function splitEvidenceKeywords(text: string): { text: string; keyword: boolean }[] {
  const parts: { text: string; keyword: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(keywords)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), keyword: false })
    parts.push({ text: match[0], keyword: true })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), keyword: false })
  return parts
}

/** 작성요령 · (인) · 년 월 일 같은 서식 신호가 3개 이상이면 빈 신청서 서식으로 봅니다. */
export function isApplicationFormText(text: string): boolean {
  return formSignals.filter((signal) => signal.test(text)).length >= 3
}

/** 인용이 저장된 원문 조각의 앞이나 뒤를 잘라 냈는지 알려 줍니다. 원문 조각에서 찾지 못하면 잘리지 않은 것으로 봅니다. */
export function evidenceQuoteCut(blockText: string, quote: string): { start: boolean; end: boolean } {
  const index = blockText.indexOf(quote)
  if (index < 0) return { start: false, end: false }
  return { start: blockText.slice(0, index).trim() !== '', end: blockText.slice(index + quote.length).trim() !== '' }
}

/** Core 원문 추출기의 위치 표기(PDF page 3 part 1 등)를 사용자 말로 바꿉니다. 모르는 표기는 그대로 둡니다. */
export function evidenceLocatorLabel(locator: string): string {
  const part = (value: string | undefined) => value && value !== '1' ? ` (${value})` : ''
  let match = /^PDF page (\d+) part (\d+)$/.exec(locator)
  if (match) return `${match[1]}쪽${part(match[2])}`
  match = /^(?:HWP|DOCX) paragraphs (\d+)-(\d+)$/.exec(locator)
  if (match) return `문단 ${match[1]}–${match[2]}`
  match = /^(?:HWP|DOCX) paragraph (\d+) part (\d+)$/.exec(locator)
  if (match) return `문단 ${match[1]}${part(match[2])}`
  match = /^HWPX section(\d+) paragraphs? (\d+)(?:-(\d+))?(?: part (\d+))?$/.exec(locator)
  if (match) {
    const section = Number(match[1]) > 0 ? `${Number(match[1]) + 1}구역 ` : ''
    return `${section}문단 ${match[2]}${match[3] ? `–${match[3]}` : ''}${part(match[4])}`
  }
  if (/^HWP \S+ form controls near record \d+$/.test(locator)) return '입력 칸 주변 글'
  match = /^XLSX sheet (.+) row (\d+) part (\d+)$/.exec(locator)
  if (match) return `${match[1]} 시트 ${match[2]}행${part(match[3])}`
  return locator
}

/** 위치 표기 앞머리로 원문 파일 형식을 알아냅니다. 원문 목록에서 파일을 찾지 못했을 때 씁니다. */
export function evidenceFormatOf(locator: string): string {
  return /^(PDF|HWPX|HWP|DOCX|XLSX)\b/.exec(locator)?.[1] ?? ''
}
