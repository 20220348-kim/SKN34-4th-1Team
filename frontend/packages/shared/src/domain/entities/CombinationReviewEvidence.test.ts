import { describe, expect, it } from 'vitest'
import {
  evidenceFormatOf, evidenceHasContext, evidenceLocatorLabel, evidencePreview, evidenceQuoteCut, evidenceQuoteRange, formatEvidenceText, isApplicationFormText,
  splitEvidenceKeywords,
} from './CombinationReviewEvidence'

// 아래 원문은 로컬 검토 실행(2026-10-07)에 저장된 실제 인용의 일부입니다.
const pdfExclusions = [
  '◦ 지원 제외 대상에 해당하는 중소기업 또는 소상공인',
  '▪ 국세‧지방세 체납 중인 기업 또는 대표자. 다만, 세금 분납 계획에 따라 세금을 ',
  '성실하게 납부하고 있는 경우에는 신청 가능',
  '▪ 신청 사업의 내용이 동 사업 및 타 정부지원 사업 등을 통해 지원받은 내용과 ',
  '유사·중복되는 경우',
  ' 3. 2026년 모집 개요',
  '□ 모집대상',
  '   * 입점 희망 매장은 1구역(T1, 제1·2매장) 중 택 1',
  '- 4 -',
  '정책매장운영팀 1230013 2026/08/31-10:27:41',
].join('\n')

const lines = (text: string, format: string) => formatEvidenceText(text, format).map(({ kind, level, marker, text: body }) => [kind, level, marker, body])

describe('evidence quote formatting shared by web and mobile', () => {
  it('joins PDF line wraps, keeps bullet levels and drops page numbers and print stamps', () => {
    expect(lines(pdfExclusions, 'PDF')).toEqual([
      ['item', 2, '◦', '지원 제외 대상에 해당하는 중소기업 또는 소상공인'],
      ['item', 3, '▪', '국세‧지방세 체납 중인 기업 또는 대표자. 다만, 세금 분납 계획에 따라 세금을 성실하게 납부하고 있는 경우에는 신청 가능'],
      ['item', 3, '▪', '신청 사업의 내용이 동 사업 및 타 정부지원 사업 등을 통해 지원받은 내용과 유사·중복되는 경우'],
      ['heading', 1, '', '3. 2026년 모집 개요'],
      ['item', 1, '□', '모집대상'],
      ['note', 3, '*', '입점 희망 매장은 1구역(T1, 제1·2매장) 중 택 1'],
    ])
    expect(formatEvidenceText(pdfExclusions, 'PDF').map((line) => line.related)).toEqual([true, false, true, false, false, false])
  })

  it('does not join HWP paragraphs and turns private-use bullets into a visible bullet', () => {
    const hwp = '\uf06d 신청기간: 연중 1회 수시 신청\n- 2025년도 지원 사업장의 경우 2026년도 별도 신청하지 않으며\n\uf071 근로자 요건(반드시 개인별로 판단하여야 합니다.)\n판판대로 ð 신청자격'
    expect(lines(hwp, 'HWP')).toEqual([
      ['item', 2, '•', '신청기간: 연중 1회 수시 신청'],
      ['item', 3, '-', '2025년도 지원 사업장의 경우 2026년도 별도 신청하지 않으며'],
      ['item', 2, '•', '근로자 요건(반드시 개인별로 판단하여야 합니다.)'],
      ['text', 1, '', '판판대로 → 신청자격'],
    ])
  })

  it('closes letter-spaced labels without merging one-syllable words inside a sentence', () => {
    expect(lines('\uf06d 행 사 명: 2026년 판매전\n성 주 군 수\n제   출   서   류\n그 밖에 각 호의 사항', 'PDF').map(([, , , text]) => text))
      .toEqual(['행사명: 2026년 판매전', '성주군수', '제출서류', '그 밖에 각 호의 사항'])
  })

  it('folds table cells that were split one per line into one table line and drops blank form cells', () => {
    const hwpx = '▢ 제출서류 목록\n연번\n제   출   서   류\n제출부수\n1\n참가신청서(날인 필수) 【양식1】\nㅇ\n-\n※ 타 기관 지원을 받는 경우 중복지원 불가함'
    expect(lines(hwpx, 'HWPX')).toEqual([
      ['item', 1, '▢', '제출서류 목록'],
      ['table', 1, '', '연번 · 제출서류 · 제출부수 · 1'],
      ['text', 1, '', '참가신청서(날인 필수) 【양식1】'],
      ['note', 3, '※', '타 기관 지원을 받는 경우 중복지원 불가함'],
    ])
  })

  it('reads the other bullet styles found in real notices and joins a lone chapter number with its title', () => {
    // 한글 문서의 동그라미 번호는 보충 사용자 정의 영역 글자라 화면에서 네모 상자로 보입니다.
    const circled = String.fromCodePoint(0xf02b2)
    const hwp = [`${circled} 중소기업 지원사업의 처리`, '❶ 수집·이용에 관한 사항', '⦁ 해외사업 추진 조직 및 진출 의지', 'ㅇ 채용 조건: 정규직', '♣ 참여합니다', '✽ 위생도마, 도마꽂이', 'Ⅳ', '신청절차 및 선정기준'].join('\n')
    expect(lines(hwp, 'HWPX')).toEqual([
      ['item', 2, '•', '중소기업 지원사업의 처리'],
      ['item', 2, '❶', '수집·이용에 관한 사항'],
      ['item', 2, '⦁', '해외사업 추진 조직 및 진출 의지'],
      ['item', 2, 'ㅇ', '채용 조건: 정규직'],
      ['item', 2, '♣', '참여합니다'],
      ['note', 3, '✽', '위생도마, 도마꽂이'],
      ['heading', 1, '', 'Ⅳ 신청절차 및 선정기준'],
    ])
  })

  it('reads more bullet styles, misread symbol-font bullets and control characters from new notices', () => {
    const control = String.fromCharCode(0x8d)
    const pdf = ['￭ 신용보증지원 없이 융자 가능한 자', '〇 지원금 : 최대 10,000천원', '▸ 대학-기업 공동 아이디어', '➀ <서식1> 신청서류', 'ᄋ 방송시기 : 2027년 상반기', '＊ 사업자등록 후 신청',
      `Œ 홈페이지 접속 → ${control} 신청`, '∘ 쿠폰비 지원(150만원)'].join('\n')
    expect(lines(pdf, 'PDF')).toEqual([
      ['item', 2, '￭', '신용보증지원 없이 융자 가능한 자'],
      ['item', 2, '〇', '지원금 : 최대 10,000천원'],
      ['item', 2, '▸', '대학-기업 공동 아이디어'],
      ['item', 2, '➀', '<서식1> 신청서류'],
      ['item', 2, 'ᄋ', '방송시기 : 2027년 상반기'],
      ['note', 3, '＊', '사업자등록 후 신청'],
      ['item', 2, '①', '홈페이지 접속 → ② 신청'],
      ['item', 2, '∘', '쿠폰비 지원(150만원)'],
    ])
  })

  it('treats any symbol followed by a space, and arrow or box symbols even without one, as a bullet but keeps quotes and ranges as text', () => {
    const hwp = ['‣ 신청자격 확인', '☞ 문의: 기업지원과', '➜신청서 제출', '☐동의합니다', '◾ 지원내용', '’26년 사업 계획', '~ 2026. 10. 8.(목)까지', '［붙임］ 신청서'].join('\n')
    expect(lines(hwp, 'HWP').map(([kind, , marker, text]) => `${kind}|${marker}|${text}`)).toEqual([
      'item|‣|신청자격 확인', 'item|☞|문의: 기업지원과', 'item|➜|신청서 제출', 'item|☐|동의합니다', 'item|◾|지원내용',
      "text||’26년 사업 계획", 'text||~ 2026. 10. 8.(목)까지', 'text||［붙임］ 신청서',
    ])
  })

  it('joins a split table colon to its label and stops joining PDF lines past 300 characters', () => {
    expect(lines('기 업 명\n:\n(주)가나다', 'HWP').map(([, , , text]) => text)).toEqual(['기업명 :', '(주)가나다'])
    const row = '수행기관 프로그램 구분 출연자 업체당 지원 세부 내용 방송시간 쿠폰비 지원 직접 방송 출연 기회 제공 그립 셀러브리티 채널 활용 팔로워 모집'
    const merged = formatEvidenceText(Array.from({ length: 6 }, () => row).join('\n'), 'PDF')
    expect(merged.length).toBeGreaterThan(1)
    expect(Math.max(...merged.map((line) => line.text.length))).toBeLessThan(300)
  })

  it('drops blank dates, signatures and empty field labels of a blank form but keeps real dates and labels elsewhere', () => {
    const form = ['붙임 2 참여 서약서', '위 사항을 성실히 실천할 것을 서약합니다.', '2026년 월 일', '20XX 년 00 월 00 일', '년      월      일', '(서명 또는 인)', '주소 :', '대표자 : (서명 또는 날인)', '업소명 : 성주식당'].join('\n')
    expect(lines(form, 'HWP').map(([, , , text]) => text)).toEqual(['붙임 2 참여 서약서', '위 사항을 성실히 실천할 것을 서약합니다.', '업소명 : 성주식당'])
    expect(lines('2026년 3월 27일\n문의 :\n기업지원과', 'HWP').map(([, , , text]) => text)).toEqual(['2026년 3월 27일', '문의 :', '기업지원과'])
  })

  it('previews related lines with one line of context and their parent item and counts what it folds', () => {
    const formatted = formatEvidenceText(['□ 신청방법', '◦ 이메일 접수', '◦ 접수 기간', '◦ 문의처', '◦ 타 기관 지원을 받는 경우 중복지원 불가', '◦ 결과 통보', '◦ 협약', '◦ 사업비 지급'].join('\n'), 'HWPX')
    expect(evidencePreview(formatted).map((entry) => entry.type === 'gap' ? `gap ${entry.count}` : entry.line.text))
      .toEqual(['신청방법', 'gap 2', '문의처', '타 기관 지원을 받는 경우 중복지원 불가', '결과 통보', 'gap 2'])
    const unrelated = formatEvidenceText(Array.from({ length: 9 }, (_value, index) => `◦ 일정 ${index + 1}`).join('\n'), 'HWPX')
    expect(evidencePreview(unrelated).map((entry) => entry.type === 'gap' ? `gap ${entry.count}` : entry.line.text))
      .toEqual(['일정 1', '일정 2', '일정 3', '일정 4', '일정 5', '일정 6', 'gap 3'])
  })

  it('splits keywords for highlighting', () => {
    expect(splitEvidenceKeywords('허위, 중복지원인 경우 지원금을 환수할 수 있음')).toEqual([
      { text: '허위, ', keyword: false }, { text: '중복', keyword: true }, { text: '지원인 경우 지원금을 ', keyword: false },
      { text: '환수', keyword: true }, { text: '할 수 있음', keyword: false },
    ])
    expect(splitEvidenceKeywords('다른 창업지원사업에 선정되어')[0]).toEqual({ text: '다른 창업지원사업', keyword: true })
  })

  // 아래는 공고 485개의 인용 후보 표본 250개를 읽어 판정한 결과에서 나온 사례입니다.
  const related = (sentences: string[]) => formatEvidenceText(sentences.map((sentence) => `◦ ${sentence}`).join('\n'), 'HWP').filter((line) => line.related).map((line) => line.text)

  it('finds restriction sentences with particles and skips look-alike words, law names and consent purposes', () => {
    expect(related([
      '선정이 취소될 수 있음', '지원 대상에서 제외됨', '신청 불가', '내용과 동일한 경우', '동일사업(기술)은 재신청 불가', '현재 수행 중인 타 과제 현황', "'25 사업 수혜자는 후순위",
      '기타 사업 추진', '기타 기관, 법인 또는 단체', '가동시작 전 점검', '자동시설 구축', '다른 사업자에게 인계', '전용 및 병행 공간 확보',
      '「부정이익 환수 등에 관한 법률」에 따른 신고', '수집·이용 목적: 참여제한 여부 확인',
    ])).toEqual([
      '선정이 취소될 수 있음', '지원 대상에서 제외됨', '신청 불가', '내용과 동일한 경우', '동일사업(기술)은 재신청 불가', '현재 수행 중인 타 과제 현황', "'25 사업 수혜자는 후순위",
    ])
  })

  it('does not join PDF table rows, column gaps or short lines, and glues words split without a trailing space', () => {
    const table = ['1 사업신청서 1부 필수 서식 1 원본 제출 및 사본 1부', '2 사업자등록증 1부 필수 원본 제출 및 사본 1부 제출', '3 중소기업확인서 1부 필수 원본 제출 및 사본 1부 제출', '4 국세 완납증명서 1부'].join('\n')
    expect(formatEvidenceText(table, 'PDF')).toHaveLength(4)
    const columns = ['기업명            대표자명            사업자등록번호', '주소            연락처            이메일 주소 기재']
    expect(formatEvidenceText(columns.join('\n'), 'PDF')).toHaveLength(2)
    const prose = ['계약 기간 동안 제출한 전자세금계산서와 사업비 집행 내역이 사실과 다른 경우에는 전자세금계', '산서를 다시 발급받아 제출해야 하며 사업비는 지방보조금 ', '관리 기준에 따라 환수합니다.'].join('\n')
    expect(lines(prose, 'PDF').map(([, , , text]) => text)).toEqual(['계약 기간 동안 제출한 전자세금계산서와 사업비 집행 내역이 사실과 다른 경우에는 전자세금계산서를 다시 발급받아 제출해야 하며 사업비는 지방보조금', '관리 기준에 따라 환수합니다.'])
  })

  it('still joins PDF lines in notices that use □ as section bullets, but not in checkbox forms', () => {
    const notice = ['□ 사업목적 : 기업의 자발적이고도 선제적인 체질개선 및 혁신활동을 촉진', '하여 사회적 비용을 최소화함', '□ 사업목표 : 신산업·탄소중립·디지털 전환·공급망 안정 등 미래사업재편', '유형에 해당하는 기업의 사업재편 승인지원', '□ 접수규모 : 20개사 내외', '□ 문의처 : 협회 사업팀'].join('\n')
    expect(lines(notice, 'PDF').map(([, , , text]) => text)).toEqual([
      '사업목적 : 기업의 자발적이고도 선제적인 체질개선 및 혁신활동을 촉진 하여 사회적 비용을 최소화함', '사업목표 : 신산업·탄소중립·디지털 전환·공급망 안정 등 미래사업재편 유형에 해당하는 기업의 사업재편 승인지원', '접수규모 : 20개사 내외', '문의처 : 협회 사업팀',
    ])
    const form = ['경쟁 정도 □매우치열 □치열 □보통 □낮음 주요 경쟁업체를 기재하는 칸입니다', '시장 진입방법 및 판매 경로를 자세히 기재하는 칸입니다']
    expect(formatEvidenceText(form.join('\n'), 'PDF')).toHaveLength(2)
  })

  it('keeps decimals out of bullets and headings and treats sibling numbered lines as one list', () => {
    expect(lines('1.01%~1.25% 0.5%\n52.9500', 'PDF').map(([kind]) => kind)).toEqual(['text', 'text'])
    expect(lines('1. 사업 개요\n2. 지원 내용\n3. 신청 방법', 'HWP').map(([kind, , marker]) => `${kind}${marker}`)).toEqual(['item1.', 'item2.', 'item3.'])
    expect(lines('가. 사업목적', 'HWP')).toEqual([['heading', 1, '', '가. 사업목적']])
    expect(lines('3\n신청자격 및 입주조건\n○ 공고일 기준 사업자등록', 'HWPX')[0]).toEqual(['heading', 1, '', '3. 신청자격 및 입주조건'])
  })

  it('drops empty bullets, signature lines and arrow-only lines but keeps real content that starts with zeros or reads 생년월일', () => {
    expect(lines(['➡', '➌', '사업계획서 제출', '⇨ ⇨', '대표자 : 홍길동 (인)', '생년월일', '0000.00.00 보호활동, 소외계층지원 등 사회공헌', '2026. . .'].join('\n'), 'HWP')).toEqual([
      ['item', 2, '➌', '사업계획서 제출'], ['text', 1, '', '생년월일'], ['text', 1, '', '0000.00.00 보호활동, 소외계층지원 등 사회공헌'],
    ])
  })

  it('reads PDF Wingdings letters as bullets and NUL separators as spaces', () => {
    const nul = String.fromCharCode(0)
    expect(lines(`l 입주신청서 제출\n아래${nul}항목${nul}중${nul}하나에${nul}해당하면${nul}지원${nul}불가`, 'PDF')).toEqual([
      ['item', 2, '•', '입주신청서 제출'], ['text', 1, '', '아래 항목 중 하나에 해당하면 지원 불가'],
    ])
  })

  it('previews a box header with its following lines when the header itself is related', () => {
    const formatted = formatEvidenceText(['□ 신청방법 : 이메일', '□ 지원 제외 대상', '◦ 국세 체납 기업', '◦ 휴·폐업 기업', '□ 문의처', '◦ 기업지원과'].join('\n'), 'HWP')
    expect(evidencePreview(formatted).map((entry) => entry.type === 'gap' ? `gap ${entry.count}` : entry.line.text))
      .toEqual(['신청방법 : 이메일', '지원 제외 대상', '국세 체납 기업', '휴·폐업 기업', 'gap 2'])
  })

  it('recognizes blank application forms by several form signals', () => {
    expect(isApplicationFormText('붙임 2 참여 서약서\n위 사항을 성실히 실천할 것을 선서합니다.\n2026년    월     일\n대 표 자 :  (서명)')).toBe(true)
    expect(isApplicationFormText('□ 신청방법 : 이메일 접수\n※ 제출서류 미비 시 지원 제외')).toBe(false)
  })

  it('treats only a quote that starts or ends mid-line as cut and still tells whether the block has surrounding text', () => {
    const block = '□ 지원 제외 대상\n◦ 신청 사업의 내용이 타 정부지원 사업 등을 통해 지원받은 내용과 유사·중복되는 경우\n◦ 국세 체납 기업\n□ 신청방법'
    // 예전 800자 창은 줄 중간의 공백에서 끊겨 앞뒤가 잘립니다.
    expect(evidenceQuoteCut(block, '타 정부지원 사업 등을 통해 지원받은 내용과 유사·중복되는 경우\n◦ 국세')).toEqual({ start: true, end: true })
    expect(evidenceQuoteCut(block, '□ 지원 제외 대상\n◦ 신청 사업의 내용이')).toEqual({ start: false, end: true })
    // 줄 단위 인용(글머리 항목)은 조각 안에 앞뒤 줄이 더 있어도 잘리지 않았고, 앞뒤 원문은 있습니다.
    const item = '◦ 신청 사업의 내용이 타 정부지원 사업 등을 통해 지원받은 내용과 유사·중복되는 경우\n◦ 국세 체납 기업'
    expect(evidenceQuoteCut(block, item)).toEqual({ start: false, end: false })
    expect(evidenceHasContext(block, item)).toBe(true)
    // 줄 앞뒤의 공백 · 탭과 \r\n 줄바꿈은 줄 경계로 봅니다. 인용이 줄바꿈을 품고 시작하거나 끝나도 같습니다.
    expect(evidenceQuoteCut('□ 제목\r\n  ◦ 항목 하나\t\r\n□ 다음', '◦ 항목 하나')).toEqual({ start: false, end: false })
    expect(evidenceQuoteCut('□ 제목\n◦ 항목 하나\n□ 다음', '\n◦ 항목 하나\n')).toEqual({ start: false, end: false })
    // 인용이 조각 전체이거나 조각에서 찾지 못하면 잘리지 않았고 앞뒤 원문도 없습니다(앞뒤 공백만 있는 것도 없는 것으로 봅니다).
    expect(evidenceQuoteCut(block, block)).toEqual({ start: false, end: false })
    expect(evidenceHasContext(block, block)).toBe(false)
    expect(evidenceHasContext(`\n${block}\n`, block)).toBe(false)
    expect(evidenceQuoteCut(block, '없는 문장')).toEqual({ start: false, end: false })
    expect(evidenceHasContext(block, '없는 문장')).toBe(false)
  })

  it('finds the lines of an uncut quote inside the whole formatted block without marking the same line elsewhere', () => {
    const block = ['□ 지원 제외 대상', '◦ 해당 없음', '◦ 타 기관 지원을 받는 경우 중복지원 불가', '◦ 해당 없음', '□ 신청방법', '◦ 이메일 접수'].join('\n')
    const blockLines = formatEvidenceText(block, 'HWPX')
    expect(evidenceQuoteRange(blockLines, formatEvidenceText('◦ 타 기관 지원을 받는 경우 중복지원 불가\n◦ 해당 없음', 'HWPX'))).toEqual({ start: 2, end: 4 })
    expect(blockLines.slice(2, 4).map((line) => line.text)).toEqual(['타 기관 지원을 받는 경우 중복지원 불가', '해당 없음'])
    // 따로 읽으면 제목인 번호 줄이 조각 안에서 같은 번호 목록의 글머리로 바뀌어도 같은 줄로 봅니다.
    const numbered = formatEvidenceText('1. 목적\n2. 지원 제외 대상\n3. 신청방법', 'HWP')
    expect(numbered[1]).toMatchObject({ kind: 'item', marker: '2.' })
    expect(formatEvidenceText('2. 지원 제외 대상', 'HWP')[0]).toMatchObject({ kind: 'heading' })
    expect(evidenceQuoteRange(numbered, formatEvidenceText('2. 지원 제외 대상', 'HWP'))).toEqual({ start: 1, end: 2 })
    expect(evidenceQuoteRange(blockLines, formatEvidenceText('없는 문장', 'HWPX'))).toBeNull()
  })

  it('names every Core locator in user terms and keeps unknown ones', () => {
    expect([
      'PDF page 3 part 1', 'PDF page 12 part 2', 'HWP paragraphs 123-219', 'HWP paragraph 5 part 2', 'HWPX section0 paragraphs 1-305',
      'HWPX section1 paragraph 7 part 1', 'HWP Section0 form controls near record 100', 'DOCX paragraphs 4-9', 'XLSX sheet 신청서 row 12 part 1', 'PDF 3쪽, 문단 2',
    ].map(evidenceLocatorLabel)).toEqual([
      '3쪽', '12쪽 (2)', '문단 123–219', '문단 5 (2)', '문단 1–305', '2구역 문단 7', '입력 칸 주변 글', '문단 4–9', '신청서 시트 12행', 'PDF 3쪽, 문단 2',
    ])
    expect(['PDF page 1 part 1', 'HWPX section0 paragraphs 1-2', 'HWP paragraphs 1-2', '알 수 없음'].map((locator) => evidenceFormatOf(locator))).toEqual(['PDF', 'HWPX', 'HWP', ''])
  })
  it('shows Core layout extraction as stored: no screen PDF joins, and rebuilt table rows stay rows that can be related', () => {
    const layoutVersion = 'pdfbox-3.0.8-tika-4.0.0-hwp-form-controls-v2-hwpx-direct-paragraph-v1-evidence-layout-v1'
    expect(evidenceFormatOf('PDF page 3 part 1', { format: 'PDF', parserVersion: layoutVersion })).toBe('PDF_LAYOUT')
    expect(evidenceFormatOf('HWPX section0 paragraphs 1-2', { format: 'HWPX', parserVersion: layoutVersion })).toBe('HWPX_LAYOUT')
    expect(evidenceFormatOf('PDF page 3 part 1', { format: 'PDF', parserVersion: 'pdfbox-3.0.8-tika-4.0.0' })).toBe('PDF')
    const text = [
      'l 지원 제외 대상에 해당하는 중소기업 또는 소상공인으로서 국세 체납 중인 기업',
      '세금 분납 계획에 따라 성실하게 납부하고 있는 경우에는 신청 가능',
      '구분 | 내용 | 비고',
      '제외 대상 | 동일 과제로 타 사업 수혜 기업 | 선정 취소',
    ].join('\n')
    const lines = formatEvidenceText(text, 'PDF_LAYOUT')
    expect(lines.map((line) => [line.kind, line.marker, line.text])).toEqual([
      ['item', '•', '지원 제외 대상에 해당하는 중소기업 또는 소상공인으로서 국세 체납 중인 기업'],
      ['text', '', '세금 분납 계획에 따라 성실하게 납부하고 있는 경우에는 신청 가능'],
      ['table', '', '구분 | 내용 | 비고'],
      ['table', '', '제외 대상 | 동일 과제로 타 사업 수혜 기업 | 선정 취소'],
    ])
    expect(lines.map((line) => line.related)).toEqual([true, false, false, true])
    expect(formatEvidenceText('제외 대상 | 동일 과제로 타 사업 수혜 기업', 'HWPX_LAYOUT')).toEqual([
      { kind: 'table', level: 1, marker: '', text: '제외 대상 | 동일 과제로 타 사업 수혜 기업', related: true },
    ])
  })
})
