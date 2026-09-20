import { describe, expect, it } from 'vitest'

import { loginPathFor, readReturnPath, signupPathFor } from './returnPath'

describe('인증 화면의 복귀 경로', () => {
  it('선택한 검색 토큰과 기존 쿼리를 로그인·가입 URL에 그대로 보존한다', () => {
    const target = '/app/chat?searchResult=ce5a0b64-5496-47e4-8bab-05392e7661c9&mode=filter'
    for (const link of [loginPathFor(target), signupPathFor(target)]) {
      expect(readReturnPath(link.slice(link.indexOf('?')))).toBe(target)
    }
  })

  it.each(['', '/'])('복귀 경로 %s가 기본 공개 화면이면 불필요한 next를 붙이지 않는다', (target) => {
    expect(loginPathFor(target)).toBe('/login')
    expect(signupPathFor(target)).toBe('/signup')
  })

  it.each(['https://outside.example', '//outside.example', '/\\outside.example', '/app/chat\n', 'app/chat'])(
    '외부 주소 또는 잘못된 경로 %s는 기본 작업 화면으로 돌린다', (target) => {
      expect(readReturnPath('?next=' + encodeURIComponent(target))).toBe('/app/chat')
      expect(readReturnPath('?next=' + encodeURIComponent(target), '')).toBe('')
    },
  )
})