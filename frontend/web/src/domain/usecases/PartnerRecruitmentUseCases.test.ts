import { describe, expect, it, vi } from 'vitest'

import type { PartnerRecruitmentInput } from '../entities/PartnerRecruitment'
import {
  BrowsePartnerRecruitmentsUseCase,
  ClosePartnerRecruitmentUseCase,
  CreatePartnerRecruitmentUseCase,
  GetPartnerRecruitmentDetailUseCase,
  UpdatePartnerRecruitmentUseCase,
  validatePartnerRecruitmentInput,
} from './PartnerRecruitmentUseCases'

const input: PartnerRecruitmentInput = {
  sourceCode: ' BIZINFO ',
  sourceProgramId: 'PBLN-1',
  title: ' AI 실증 참여기관 구합니다 ',
  body: ' 본문 ',
  ownRole: 'LEAD',
  seekingRole: 'PARTICIPANT',
  seekingCount: 1,
  region: ' 서울 ',
  minimumCompanyAgeYears: null,
  capabilities: [' 데이터 구축 ', '데이터 구축', ' ', '라벨링'],
  recruitmentDeadline: '2026-09-20',
}

describe('PartnerRecruitmentUseCases', () => {
  it('browse trims the keyword and regions and falls back to the first page', async () => {
    const browse = vi.fn().mockResolvedValue({ recruitments: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
    await new BrowsePartnerRecruitmentsUseCase({ browse }).execute({ keyword: ' 스마트 ', seekingRoles: [], regions: [' 서울 ', ' '], mineOnly: false, sourceCode: '', sort: 'DEADLINE', page: 0 })
    expect(browse).toHaveBeenCalledWith({ keyword: '스마트', seekingRoles: [], regions: ['서울'], mineOnly: false, sourceCode: '', sort: 'DEADLINE', page: 1 }, undefined)
  })

  it('detail rejects ids that cannot exist before calling the repository', async () => {
    const getDetail = vi.fn().mockResolvedValue(null)
    const useCase = new GetPartnerRecruitmentDetailUseCase({ getDetail })
    expect(() => useCase.execute(0)).toThrow(RangeError)
    expect(() => useCase.execute(1.5)).toThrow(RangeError)
    await useCase.execute(7)
    expect(getDetail).toHaveBeenCalledWith(7, undefined)
  })

  it('create trims text, removes blank and duplicate capabilities, and sends the normalized input', async () => {
    const create = vi.fn().mockResolvedValue({ outcome: 'created' })
    await new CreatePartnerRecruitmentUseCase({ create }).execute(input)
    expect(create).toHaveBeenCalledWith({
      ...input,
      sourceCode: 'BIZINFO',
      title: 'AI 실증 참여기관 구합니다',
      body: '본문',
      region: '서울',
      capabilities: ['데이터 구축', '라벨링'],
    }, undefined)
  })

  it('create rejects inputs that break the recruitment rules without calling the repository', () => {
    const create = vi.fn()
    const useCase = new CreatePartnerRecruitmentUseCase({ create })
    expect(() => useCase.execute({ ...input, ownRole: 'DEMAND' })).toThrow('ownRole')
    expect(() => useCase.execute({ ...input, title: 'x'.repeat(81) })).toThrow('title')
    expect(() => useCase.execute({ ...input, seekingCount: 10 })).toThrow('seekingCount')
    expect(() => useCase.execute({ ...input, minimumCompanyAgeYears: 0 })).toThrow('minimumCompanyAgeYears')
    expect(() => useCase.execute({ ...input, recruitmentDeadline: '2026/09/20' })).toThrow('recruitmentDeadline')
    expect(() => useCase.execute({ ...input, sourceProgramId: ' ' })).toThrow('program')
    expect(create).not.toHaveBeenCalled()
  })

  it('update normalizes the content without a program and close rejects impossible ids', async () => {
    const update = vi.fn().mockResolvedValue({ outcome: 'updated' })
    const close = vi.fn().mockResolvedValue({ outcome: 'closed' })
    const { sourceCode: _sourceCode, sourceProgramId: _sourceProgramId, ...content } = input
    await new UpdatePartnerRecruitmentUseCase({ update }).execute(7, { ...content, title: ' 수정 ', capabilities: [' 라벨링 ', '라벨링', ' '] })
    expect(update).toHaveBeenCalledWith(7, { ...content, title: '수정', body: '본문', region: '서울', capabilities: ['라벨링'] }, undefined)
    expect(() => new UpdatePartnerRecruitmentUseCase({ update }).execute(0, content)).toThrow(RangeError)
    expect(() => new UpdatePartnerRecruitmentUseCase({ update }).execute(7, { ...content, title: '' })).toThrow(RangeError)

    await new ClosePartnerRecruitmentUseCase({ close }).execute(7)
    expect(close).toHaveBeenCalledWith(7, undefined)
    expect(() => new ClosePartnerRecruitmentUseCase({ close }).execute(1.5)).toThrow(RangeError)
  })

  it('validatePartnerRecruitmentInput names the first broken field or null', () => {
    expect(validatePartnerRecruitmentInput({ ...input, sourceCode: 'BIZINFO', title: '제목', body: '본문', region: '서울', capabilities: [] })).toBeNull()
    expect(validatePartnerRecruitmentInput({ ...input, sourceCode: 'BIZINFO', title: '제목', body: '', region: '서울', capabilities: [] })).toBe('body')
    expect(validatePartnerRecruitmentInput({ ...input, sourceCode: 'BIZINFO', title: '제목', body: '본문', region: '서울', capabilities: Array.from({ length: 11 }, (_, index) => `역량 ${index}`) })).toBe('capabilities')
  })
})
