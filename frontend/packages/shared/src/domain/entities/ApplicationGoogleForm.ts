import { formatBusinessNumber, type Company } from './Company'

/** UNSUPPORTED는 날짜·파일 업로드·표 형식처럼 링크로 채울 수 없어 구글 설문에서 직접 답하는 문항입니다. */
export type ApplicationGoogleFormQuestionKind = 'SHORT_TEXT' | 'LONG_TEXT' | 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'DROPDOWN' | 'UNSUPPORTED'

export type ApplicationGoogleFormQuestion = {
  /** 미리 채운 링크의 `entry.{번호}`입니다. UNSUPPORTED 문항만 null입니다. */
  entryId: string | null
  label: string
  description: string
  required: boolean
  kind: ApplicationGoogleFormQuestionKind
  /** 링크로 체크하려면 선택지 문구가 정확히 같아야 하므로 공백까지 원문 그대로입니다. */
  options: string[]
  /** 선택지 끝에 "기타" 자유 입력이 있는지입니다. 객관식·체크박스만 있습니다. */
  allowsOther: boolean
}

/** 구글 설문으로 신청하는 공고의 공개 설문입니다. 답변은 사용자가 이 화면에서 고르고 제출은 구글 설문에서 합니다. */
export type ApplicationGoogleForm = {
  responderUrl: string
  title: string
  questions: ApplicationGoogleFormQuestion[]
}

/**
 * 한 문항의 답입니다. 단답·장문은 `values[0]`의 글, 객관식·드롭다운은 고른 선택지 하나, 체크박스는 고른 선택지들입니다.
 * `other`는 "기타"를 골랐을 때 적은 글이며 고르지 않았으면 null입니다.
 */
export type ApplicationGoogleFormAnswer = { values: string[]; other: string | null }

/** `entryId`별 답입니다. */
export type ApplicationGoogleFormAnswers = Record<string, ApplicationGoogleFormAnswer>

/** 기업 정보로 채울 수 있는 값입니다. 성명·연락처처럼 GovBiz가 모르는 값은 사용자가 직접 적습니다. */
export type ApplicationGoogleFormProfile = {
  email: string | null
  company: Pick<Company, 'companyName' | 'businessNumber' | 'region' | 'industry' | 'foundedYear' | 'homepageUrl'> | null
}

const OTHER_OPTION = '__other_option__'
const textKinds: ApplicationGoogleFormQuestionKind[] = ['SHORT_TEXT', 'LONG_TEXT']

/**
 * 단답·장문 문항 제목으로 기업 정보 하나를 고릅니다. 제목에서 공백·번호를 빼고 비교하며, 성명·연락처·주소처럼
 * 기업 정보만으로 완성할 수 없는 문항은 비워 둡니다. 동의·선택 문항은 사용자가 직접 고르게 채우지 않습니다.
 */
function profileValue(label: string, profile: ApplicationGoogleFormProfile): string | null {
  const key = label.replace(/\s+/g, '').toLowerCase()
  const company = profile.company
  if (/이메일|e-?mail|메일주소/.test(key)) return profile.email
  if (!company) return null
  if (/사업자(등록)?번호/.test(key)) return formatBusinessNumber(company.businessNumber)
  if (/기업명|회사명|업체명|상호|법인명|사업체명|소속기업/.test(key) || /^[\d.]*소속\??$/.test(key)) return company.companyName
  if (/소재지/.test(key)) return company.region
  if (/업종/.test(key)) return company.industry
  if (/(설립|창업|개업)(연도|년도)/.test(key)) return String(company.foundedYear)
  if (/홈페이지|웹사이트|website/.test(key)) return company.homepageUrl
  return null
}

/** 기업 정보로 채울 수 있는 단답·장문 문항의 답입니다. 사용자가 고치거나 지울 수 있는 제안입니다. */
export function suggestGoogleFormAnswers(form: ApplicationGoogleForm, profile: ApplicationGoogleFormProfile): ApplicationGoogleFormAnswers {
  const answers: ApplicationGoogleFormAnswers = {}
  for (const question of form.questions) {
    if (!question.entryId || !textKinds.includes(question.kind)) continue
    const value = profileValue(question.label, profile)
    if (value) answers[question.entryId] = { values: [value], other: null }
  }
  return answers
}

/** 링크에 실릴 답만 남깁니다. 빈 글, 설문에 없는 선택지, 객관식의 두 번째 선택은 버립니다. */
function linkValues(question: ApplicationGoogleFormQuestion, answer: ApplicationGoogleFormAnswer | undefined): [string, string][] {
  if (!question.entryId || !answer) return []
  const key = `entry.${question.entryId}`
  if (textKinds.includes(question.kind)) {
    const text = answer.values[0]?.trim() ?? ''
    return text ? [[key, text]] : []
  }
  const chosen = answer.values.filter((value) => question.options.includes(value))
  const other = question.allowsOther ? answer.other?.trim() ?? '' : ''
  const single = question.kind !== 'MULTI_CHOICE'
  if (single && other) return [[key, OTHER_OPTION], [`${key}.other_option_response`, other]]
  const values: [string, string][] = (single ? chosen.slice(0, 1) : chosen).map((value) => [key, value])
  return other ? [...values, [key, OTHER_OPTION], [`${key}.other_option_response`, other]] : values
}

/** 답이 링크에 실리는 문항 수입니다. */
export function countGoogleFormAnswers(form: ApplicationGoogleForm, answers: ApplicationGoogleFormAnswers): number {
  return form.questions.filter((question) => question.entryId && linkValues(question, answers[question.entryId]).length > 0).length
}

/**
 * 답을 미리 채운 구글 설문 주소입니다. 구글 설문이 공식으로 만드는 "미리 채워진 링크"와 같은 형식이며 제출은 하지 않습니다.
 * 답은 주소에 실려 브라우저 기록에 남을 수 있습니다.
 */
export function buildGoogleFormPrefillUrl(form: ApplicationGoogleForm, answers: ApplicationGoogleFormAnswers): string {
  const url = new URL(form.responderUrl)
  const params = new URLSearchParams([['usp', 'pp_url']])
  for (const question of form.questions) {
    for (const [key, value] of linkValues(question, question.entryId ? answers[question.entryId] : undefined)) params.append(key, value)
  }
  url.search = params.toString()
  url.hash = ''
  return url.toString()
}
