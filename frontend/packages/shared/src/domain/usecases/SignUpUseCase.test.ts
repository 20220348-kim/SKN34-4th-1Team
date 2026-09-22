import { describe, expect, it, vi } from 'vitest'
import { isValidSignUpPassword, SignUpUseCase } from './SignUpUseCase'
import { ChangePasswordUseCase } from './AccountProfileUseCases'
import { ResetPasswordUseCase } from './ResetPasswordUseCase'

describe('신규 비밀번호의 BCrypt UTF-8 길이 제한', () => {
  it.each([
    ['ascii minimum', 'a'.repeat(8), true],
    ['ascii maximum', 'a'.repeat(72), true],
    ['ascii too long', 'a'.repeat(73), false],
    ['too short', '가'.repeat(7), false],
    ['Korean maximum', '가'.repeat(24), true],
    ['Korean too long', '가'.repeat(25), false],
    ['emoji maximum', '😀'.repeat(18), true],
    ['emoji too long', '😀'.repeat(19), false],
    ['mixed maximum', '가'.repeat(23) + 'abc', true],
    ['mixed too long', '가'.repeat(23) + 'abcd', false],
  ])('%s', (_, password, expected) => {
    expect(isValidSignUpPassword(password)).toBe(expected)
  })

  it('가입·변경·재설정은 잘못된 암호를 API로 보내지 않는다', () => {
    const signUp = vi.fn()
    const changePassword = vi.fn()
    const resetPassword = vi.fn()
    const password = '가'.repeat(25)
    expect(() => new SignUpUseCase({ signUp }).execute({ email: 'user@example.com', password, emailPassToken: 'a'.repeat(43) })).toThrow(RangeError)
    expect(() => new ChangePasswordUseCase({ changePassword }).execute(password)).toThrow(RangeError)
    expect(() => new ResetPasswordUseCase({ resetPassword }).execute({ token: 'a'.repeat(43), newPassword: password })).toThrow(RangeError)
    expect(signUp).not.toHaveBeenCalled()
    expect(changePassword).not.toHaveBeenCalled()
    expect(resetPassword).not.toHaveBeenCalled()
  })
})
