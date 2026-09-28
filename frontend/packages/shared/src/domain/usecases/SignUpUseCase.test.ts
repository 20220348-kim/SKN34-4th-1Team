import { describe, expect, it, vi } from 'vitest'
import { isPasswordWithinByteLimit, isValidSignUpPassword, signUpPasswordIssue, SignUpUseCase } from './SignUpUseCase'
import { ChangePasswordUseCase } from './AccountProfileUseCases'
import { ResetPasswordUseCase } from './ResetPasswordUseCase'

describe('신규 비밀번호는 영문·숫자·특수문자 8~72자만 받는다', () => {
  it.each([
    ['ascii minimum', 'a'.repeat(8), null],
    ['ascii maximum', 'a'.repeat(72), null],
    ['symbols', 'Abc123!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~', null],
    ['ascii too long', 'a'.repeat(73), 'tooLong'],
    ['too short', 'a'.repeat(7), 'tooShort'],
    ['Korean', '가'.repeat(8), 'invalidCharacter'],
    ['emoji', '😀'.repeat(8), 'invalidCharacter'],
    ['space', 'pass word1', 'invalidCharacter'],
    ['mixed', 'abcdefg한', 'invalidCharacter'],
    ['length before characters', '가'.repeat(7), 'tooShort'],
    ['Korean over the byte limit', '가'.repeat(25), 'invalidCharacter'],
  ])('%s', (_, password, expected) => {
    expect(signUpPasswordIssue(password)).toBe(expected)
    expect(isValidSignUpPassword(password)).toBe(expected === null)
  })

  // 문자 규칙과 별개로 BCrypt의 UTF-8 72바이트 경계를 그대로 지킵니다.
  it.each([
    ['ascii maximum', 'a'.repeat(72), true],
    ['ascii too long', 'a'.repeat(73), false],
    ['Korean maximum', '가'.repeat(24), true],
    ['Korean too long', '가'.repeat(25), false],
    ['emoji maximum', '😀'.repeat(18), true],
    ['emoji too long', '😀'.repeat(19), false],
    ['mixed too long', '가'.repeat(23) + 'abcd', false],
  ])('byte limit: %s', (_, password, expected) => {
    expect(isPasswordWithinByteLimit(password)).toBe(expected)
  })

  it('가입·변경·재설정은 잘못된 암호를 API로 보내지 않는다', () => {
    const signUp = vi.fn()
    const changePassword = vi.fn()
    const resetPassword = vi.fn()
    const password = '가'.repeat(8)
    expect(() => new SignUpUseCase({ signUp }).execute({ email: 'user@example.com', password, emailPassToken: 'a'.repeat(43) })).toThrow(RangeError)
    expect(() => new ChangePasswordUseCase({ changePassword }).execute(password)).toThrow(RangeError)
    expect(() => new ResetPasswordUseCase({ resetPassword }).execute({ token: 'a'.repeat(43), newPassword: password })).toThrow(RangeError)
    expect(signUp).not.toHaveBeenCalled()
    expect(changePassword).not.toHaveBeenCalled()
    expect(resetPassword).not.toHaveBeenCalled()
  })
})
