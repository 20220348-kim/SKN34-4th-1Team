import { useEffect, useRef, useState } from 'react'

import { type BusinessLookup, formatBusinessNumberInput, isValidBusinessNumber } from '../../../domain/entities/Company'
import type { LookupBusinessUseCase } from '../../../domain/usecases/CompanyUseCases'
import { companyFormMessages } from './companyRegistrationForm'

export type BusinessLookupState =
  | { status: 'idle' }
  | { status: 'looking' }
  | { status: 'found'; business: BusinessLookup }
  | { status: 'failed'; reason: BusinessLookupFailure; message: string }

/** 미등록 번호는 입력 칸 오류로, 조회 불가(Bizno 장애·한도)는 카드로 안내하도록 나눕니다. */
export type BusinessLookupFailure = 'not-found' | 'unavailable'

export type BusinessLookupOutcome =
  | { outcome: 'invalid' }
  | { outcome: 'found'; business: BusinessLookup }
  | { outcome: 'failed'; reason: BusinessLookupFailure; message: string }

/**
 * 사업자등록번호 입력과 Bizno 조회 상태입니다. 입력 중 하이픈을 붙이고, 번호가 바뀌면 이전 조회 결과를 버려
 * 다른 회사 정보가 섞이지 않게 합니다. 프로필 등록 폼과 온보딩 2단계가 함께 씁니다.
 */
export function useBusinessLookup(lookupUseCase: Pick<LookupBusinessUseCase, 'execute'>) {
  const [businessNumber, setBusinessNumber] = useState('')
  const [lookup, setLookup] = useState<BusinessLookupState>({ status: 'idle' })
  const isMounted = useRef(true)

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  async function lookupBusiness(): Promise<BusinessLookupOutcome> {
    if (lookup.status === 'looking') return { outcome: 'failed', reason: 'unavailable', message: companyFormMessages.lookupUnavailable }
    if (!isValidBusinessNumber(businessNumber)) return { outcome: 'invalid' }
    setLookup({ status: 'looking' })
    try {
      const result = await lookupUseCase.execute(businessNumber)
      if (!isMounted.current) return { outcome: 'failed', reason: 'unavailable', message: companyFormMessages.lookupUnavailable }
      if (result.outcome === 'found') {
        setLookup({ status: 'found', business: result.business })
        return { outcome: 'found', business: result.business }
      }
      const reason: BusinessLookupFailure = result.outcome === 'not-found' ? 'not-found' : 'unavailable'
      const message = reason === 'not-found' ? companyFormMessages.businessNotFound : companyFormMessages.lookupUnavailable
      setLookup({ status: 'failed', reason, message })
      return { outcome: 'failed', reason, message }
    } catch {
      const message = companyFormMessages.lookupUnavailable
      if (isMounted.current) setLookup({ status: 'failed', reason: 'unavailable', message })
      return { outcome: 'failed', reason: 'unavailable', message }
    }
  }

  return {
    businessNumber,
    /** 입력 중 하이픈을 붙이고, 번호가 바뀌면 이전 조회 결과는 버립니다. */
    updateBusinessNumber: (value: string) => {
      setBusinessNumber(formatBusinessNumberInput(value))
      setLookup({ status: 'idle' })
    },
    canLookup: isValidBusinessNumber(businessNumber) && lookup.status !== 'looking',
    isLooking: lookup.status === 'looking',
    lookup,
    lookupBusiness,
    reset: () => {
      setBusinessNumber('')
      setLookup({ status: 'idle' })
    },
  }
}
