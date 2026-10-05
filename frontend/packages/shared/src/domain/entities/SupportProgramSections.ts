import type { SupportProgramContact, SupportProgramDetail } from './SupportProgram'

const TARGET_PREFIX = '지원 대상: '
const EXCLUDED_PREFIX = '제외 대상: '

/**
 * 공고 원문의 지원 대상과 제외 대상을 나눕니다. K-Startup은 두 공식 필드를 서버가 `지원 대상: …`, `제외 대상: …` 줄로
 * 이어 붙여 보내므로 그 형식일 때만 나누고, 다른 제공처는 본문이 우연히 같은 글자를 담아도 원문 그대로 둡니다.
 */
export function splitSupportProgramTarget(sourceCode: string, targetDescription: string): { target: string; excluded: string | null } {
  if (sourceCode !== 'KSTARTUP') return { target: targetDescription, excluded: null }
  const lines = targetDescription.split('\n')
  if (!lines.every((line) => line.startsWith(TARGET_PREFIX) || line.startsWith(EXCLUDED_PREFIX))) {
    return { target: targetDescription, excluded: null }
  }
  const target = lines.find((line) => line.startsWith(TARGET_PREFIX))?.slice(TARGET_PREFIX.length).trim() ?? ''
  const excluded = lines.find((line) => line.startsWith(EXCLUDED_PREFIX))?.slice(EXCLUDED_PREFIX.length).trim() || null
  return { target, excluded }
}

/** 공식 신청 필드로 분류한 신청 경로의 짧은 이름입니다. 분류할 수 없으면 `null`이라 화면은 원문 확인을 안내합니다. */
export function supportProgramApplicationRouteLabel(route: SupportProgramDetail['applicationRoute']): string | null {
  switch (route.type) {
    case 'GOOGLE_FORMS': return '온라인 신청 (구글 설문)'
    case 'OTHER_ONLINE_FORM': return '온라인 신청 (접수 사이트)'
    case 'FILE': return '이메일·우편·방문 제출'
    case 'UNKNOWN': return null
  }
}

/** 문의처 한 줄의 조각입니다. 전화번호 조각만 `tel:` 링크에 쓸 숫자를 `tel`에 둡니다. */
export type SupportProgramContactPart = { text: string; tel: string | null }

/**
 * 문의처를 담당 부서 · 전화번호 · 문의처 원문 순서의 조각으로 나눕니다. K-Startup의 하이픈 없는 전화번호는 국내 번호 규칙에
 * 맞을 때만 하이픈을 넣어 전화로 잇고, 기업마당 원문은 그 안의 하이픈 전화번호만 잇습니다. 규칙에 맞지 않는 번호는 받은 그대로 둡니다.
 */
export function supportProgramContactParts(contact: SupportProgramContact): SupportProgramContactPart[] {
  const groups: SupportProgramContactPart[][] = []
  const department = contact.department?.trim()
  const phoneNumber = contact.phoneNumber?.trim()
  const text = contact.text?.trim()
  if (department) groups.push([{ text: department, tel: null }])
  if (phoneNumber) groups.push([phoneNumberPart(phoneNumber)])
  if (text) groups.push(splitPhoneNumbers(text))
  return groups.flatMap((group, index) => index === 0 ? group : [{ text: ' · ', tel: null }, ...group])
}

/** 원문에서 하이픈으로 적은 국내 전화번호입니다. 앞뒤가 숫자로 이어지면 더 긴 번호의 일부라 잇지 않습니다. */
const PHONE_IN_TEXT = /0\d{1,3}-\d{3,4}-\d{4}|1[568]\d{2}-\d{4}/g

function phoneNumberPart(raw: string): SupportProgramContactPart {
  const digits = raw.replace(/-/g, '')
  const formatted = /^\d+$/.test(digits) ? formatPhoneDigits(digits) : null
  return formatted ? { text: formatted, tel: digits } : { text: raw, tel: null }
}

function splitPhoneNumbers(text: string): SupportProgramContactPart[] {
  const parts: SupportProgramContactPart[] = []
  const pattern = new RegExp(PHONE_IN_TEXT.source, 'g')
  let start = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = match.index + match[0].length
    const digits = match[0].replace(/-/g, '')
    if (/[\d-]/.test(text.charAt(match.index - 1)) || /\d/.test(text.charAt(end)) || !formatPhoneDigits(digits)) continue
    if (match.index > start) parts.push({ text: text.slice(start, match.index), tel: null })
    parts.push({ text: match[0], tel: digits })
    start = end
  }
  if (start < text.length) parts.push({ text: text.slice(start), tel: null })
  return parts
}

/** 국내 전화번호 숫자를 하이픈 형식으로 바꿉니다. 지역·휴대·인터넷·대표번호 규칙에 맞지 않으면 `null`입니다. */
function formatPhoneDigits(digits: string): string | null {
  if (/^1\d{3}$/.test(digits)) return digits
  if (/^1[568]\d{6}$/.test(digits)) return `${digits.slice(0, 4)}-${digits.slice(4)}`
  if (digits.startsWith('02')) return /^02\d{7,8}$/.test(digits) ? `02-${digits.slice(2, -4)}-${digits.slice(-4)}` : null
  if (digits.startsWith('050')) {
    return /^050\d{8,9}$/.test(digits) ? `${digits.slice(0, 4)}-${digits.slice(4, -4)}-${digits.slice(-4)}` : null
  }
  if (/^0[1-9]\d{8,9}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, -4)}-${digits.slice(-4)}`
  return null
}
