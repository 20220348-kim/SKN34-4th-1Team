/**
 * 이메일 주소의 형식 검사와 정규화입니다. 웹·모바일의 로그인·회원가입·비밀번호 찾기가 같은 규칙을 씁니다.
 *
 * 형식 검사는 서버로 보내기 전에 분명히 잘못된 입력만 거릅니다(OWASP 권고: 넓게 허용하고 명백한 오류만 거절).
 * 가입 여부는 여기서 알 수 없고 서버도 알려 주지 않으며, 실제 도달 여부는 메일의 링크·인증번호로 확인합니다.
 */

/** RFC 5321이 허용하는 주소 최대 길이입니다. 서버 상한(320자)보다 좁아 서버 검증에 걸리기 전에 안내합니다. */
export const MAX_EMAIL_LENGTH = 254
/** `@` 앞 부분(local part)의 최대 길이입니다. */
export const MAX_EMAIL_LOCAL_PART_LENGTH = 64
const MAX_DOMAIN_LABEL_LENGTH = 63
/** 도메인 한 마디는 글자·숫자로 시작·끝나고 가운데에만 하이픈을 둘 수 있습니다. 한글 도메인 같은 국제화 문자를 허용합니다. */
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u

export type EmailAddressProblem = 'empty' | 'too-long' | 'invalid'

/** 서버와 같은 규칙(앞뒤 공백 제거·소문자)으로 이메일을 정규화합니다. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * 이메일 형식 문제를 돌려줍니다. 문제가 없으면 `null`입니다.
 * 앞뒤 공백은 무시하고, `@` 하나를 기준으로 앞은 1~64자, 뒤는 점으로 나뉜 두 마디 이상의 도메인이어야 합니다.
 * 브라우저의 `type="email"`이 통과시키는 `user@localhost` 같은 주소는 실제 메일이 갈 수 없어 거절합니다.
 */
export function checkEmailAddress(input: string): EmailAddressProblem | null {
  const value = input.trim()
  if (!value) return 'empty'
  if (value.length > MAX_EMAIL_LENGTH) return 'too-long'
  if (/\s/u.test(value) || /\p{C}/u.test(value)) return 'invalid'
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return 'invalid'
  const localPart = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (localPart.length > MAX_EMAIL_LOCAL_PART_LENGTH || localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
    return 'invalid'
  }
  const labels = domain.split('.')
  if (labels.length < 2 || labels.some((label) => label.length > MAX_DOMAIN_LABEL_LENGTH || !DOMAIN_LABEL.test(label))) {
    return 'invalid'
  }
  return null
}

export function isEmailAddress(input: string): boolean {
  return checkEmailAddress(input) === null
}
