/** 자동 제목에 쓰는 공고 짧은 이름의 최대 글자 수입니다. 넘으면 말줄임표로 줄입니다. */
const shortNameLength = 18

/**
 * 공고 제목에서 검토 제목에 넣을 짧은 이름을 만듭니다. 앞의 [지역]·(기관) 꼬리표와 연도, 뒤의 "참여기업 모집 공고" 같은
 * 공통 꼬리를 빼고 길면 줄입니다. 다 빼서 비면 원래 제목을 줄여 씁니다.
 */
export function shortProgramName(title: string): string {
  let name = title.trim()
  name = name.replace(/^(?:\s*[[【(〔][^\]】)〕]{1,15}[\]】)〕]\s*)+/u, '')
  name = name.replace(/^\s*20\d{2}\s*(?:년도?|년)?\s*/u, '')
  for (let index = 0; index < 2; index++) {
    name = name.replace(/\s*(?:참여\s*기업|참여\s*기관|지원\s*기업|입주\s*기업|참가\s*기업|수요\s*기업)?\s*(?:모집\s*공고|모집|공고|신청\s*안내|안내)\s*$/u, '')
  }
  name = name.trim() || title.trim()
  return Array.from(name).length > shortNameLength ? `${Array.from(name).slice(0, shortNameLength).join('').trim()}…` : name
}

/** 새 검토의 자동 제목입니다: "사업 1 짧은 이름 X 사업 2 짧은 이름 검토". */
export function reviewAutoTitle(first: string, second: string): string {
  return `${shortProgramName(first)} X ${shortProgramName(second)} 검토`
}
