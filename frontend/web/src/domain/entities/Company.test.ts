import { describe, expect, it } from 'vitest'

import {
  formatBusinessNumberInput,
  isValidBusinessNumber,
  isValidHomepageUrl,
  normalizeHomepageUrl,
} from './Company'

describe('Company input rules', () => {
  it('formats a business number progressively while typing and caps it at ten digits', () => {
    expect(formatBusinessNumberInput('1')).toBe('1')
    expect(formatBusinessNumberInput('1248')).toBe('124-8')
    expect(formatBusinessNumberInput('12481')).toBe('124-81')
    expect(formatBusinessNumberInput('124810')).toBe('124-81-0')
    expect(formatBusinessNumberInput('124-81-00998')).toBe('124-81-00998')
    expect(formatBusinessNumberInput(' 124 81 00998 12')).toBe('124-81-00998')
    expect(isValidBusinessNumber(formatBusinessNumberInput('1248100998'))).toBe(true)
    expect(isValidBusinessNumber('124-81')).toBe(false)
  })

  it('adds https:// to a bare host and accepts only http(s) addresses', () => {
    expect(normalizeHomepageUrl('  company.co.kr/about ')).toBe('https://company.co.kr/about')
    expect(normalizeHomepageUrl('http://company.co.kr')).toBe('http://company.co.kr')
    expect(normalizeHomepageUrl('HTTPS://Company.co.kr')).toBe('HTTPS://Company.co.kr')
    expect(normalizeHomepageUrl('   ')).toBe('')

    expect(isValidHomepageUrl('https://company.co.kr')).toBe(true)
    expect(isValidHomepageUrl('http://localhost:3000/path?x=1')).toBe(true)
    expect(isValidHomepageUrl('ftp://company.co.kr')).toBe(false)
    expect(isValidHomepageUrl('https://')).toBe(false)
    expect(isValidHomepageUrl('https://company .co.kr')).toBe(false)
    expect(isValidHomepageUrl(`https://a.b/${'x'.repeat(500)}`)).toBe(false)
  })
})
