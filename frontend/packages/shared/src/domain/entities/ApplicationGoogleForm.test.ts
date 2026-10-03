import { describe, expect, it } from 'vitest'
import { applicationGoogleFormSchema } from '../../data/models/ApplicationGoogleFormDto'
import {
  buildGoogleFormPrefillUrl,
  countGoogleFormAnswers,
  suggestGoogleFormAnswers,
  type ApplicationGoogleForm,
  type ApplicationGoogleFormQuestion,
} from './ApplicationGoogleForm'

const question = (entryId: string | null, label: string, kind: ApplicationGoogleFormQuestion['kind'] = 'SHORT_TEXT',
  options: string[] = [], allowsOther = false): ApplicationGoogleFormQuestion =>
  ({ entryId, label, description: '', required: true, kind, options, allowsOther })

const form: ApplicationGoogleForm = {
  responderUrl: 'https://docs.google.com/forms/d/e/public-id/viewform',
  title: '특강 신청',
  questions: [
    question('1', '1. 기업명'),
    question('2', '참석자 성명을 말씀해주세요.', 'LONG_TEXT'),
    question('3', '메일주소(abcd@efgmail.com)'),
    question('4', '참석 가능한 일정', 'MULTI_CHOICE', ['09.17  [TIPS]', '09.22'], true),
    question('5', '개인정보 동의', 'SINGLE_CHOICE', ['네. 동의합니다.'], true),
    question('6', '업종', 'DROPDOWN', ['제조업', '정보통신업']),
    question(null, '사업자등록증', 'UNSUPPORTED'),
    question('7', '사업자 등록번호'),
    question('8', '소속대학교'),
  ],
}

const profile = {
  email: 'manager@company.co.kr',
  company: { companyName: '합성테크', businessNumber: '1248100998', region: '서울특별시', industry: '정보통신업', foundedYear: 2021, homepageUrl: null },
}

describe('suggestGoogleFormAnswers', () => {
  it('fills only text questions the company profile can answer', () => {
    const answers = suggestGoogleFormAnswers(form, profile)
    expect(answers).toEqual({
      1: { values: ['합성테크'], other: null },
      3: { values: ['manager@company.co.kr'], other: null },
      7: { values: ['124-81-00998'], other: null },
    })
  })

  it('fills the email alone when no company is registered', () => {
    expect(Object.keys(suggestGoogleFormAnswers(form, { email: 'a@b.co', company: null }))).toEqual(['3'])
  })
})

describe('buildGoogleFormPrefillUrl', () => {
  it('repeats checkbox entries, keeps option spacing and drops unknown choices', () => {
    const url = new URL(buildGoogleFormPrefillUrl(form, {
      1: { values: ['  합성테크 '], other: null },
      2: { values: [''], other: null },
      4: { values: ['09.17  [TIPS]', '없는 선택지'], other: '온라인 참석' },
      6: { values: ['제조업', '정보통신업'], other: null },
    }))
    expect(url.origin + url.pathname).toBe(form.responderUrl)
    expect(url.searchParams.get('usp')).toBe('pp_url')
    expect(url.searchParams.get('entry.1')).toBe('합성테크')
    expect(url.searchParams.has('entry.2')).toBe(false)
    expect(url.searchParams.getAll('entry.4')).toEqual(['09.17  [TIPS]', '__other_option__'])
    expect(url.searchParams.get('entry.4.other_option_response')).toBe('온라인 참석')
    expect(url.searchParams.getAll('entry.6')).toEqual(['제조업'])
  })

  it('sends the other answer instead of a choice for single-choice questions', () => {
    const url = new URL(buildGoogleFormPrefillUrl(form, { 5: { values: ['네. 동의합니다.'], other: '부분 동의' } }))
    expect(url.searchParams.getAll('entry.5')).toEqual(['__other_option__'])
    expect(url.searchParams.get('entry.5.other_option_response')).toBe('부분 동의')
  })

  it('counts only answers that reach the link', () => {
    expect(countGoogleFormAnswers(form, { 1: { values: ['a'], other: null }, 2: { values: [' '], other: null }, 6: { values: ['기타'], other: null } })).toBe(1)
  })
})

describe('applicationGoogleFormSchema', () => {
  it('accepts the core response and rejects foreign or inconsistent forms', () => {
    expect(applicationGoogleFormSchema.parse(form)).toEqual(form)
    for (const broken of [
      { ...form, responderUrl: 'https://evil.example/forms/d/e/public-id/viewform' },
      { ...form, responderUrl: 'https://docs.google.com/forms/d/e/public-id/viewform?usp=pp_url' },
      { ...form, questions: [question(null, '성명')] },
      { ...form, questions: [question('1', '일정', 'MULTI_CHOICE')] },
      { ...form, questions: [question('1', '성명'), question('1', '이메일')] },
      { ...form, questions: [question('1', '성명', 'SHORT_TEXT', [], true)] },
    ]) expect(applicationGoogleFormSchema.safeParse(broken).success).toBe(false)
  })
})
