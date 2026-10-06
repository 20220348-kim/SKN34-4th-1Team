import { describe, expect, it } from 'vitest'

import { appPaths, publicPaths } from './appPaths'
import { documentTitleFor, screenTitleFor } from './screenTitles'

/** 경로 변수(`:id`)를 실제 값처럼 채웁니다. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, '12')
}

describe('화면별 브라우저 제목', () => {
  // `/app/admin`은 화면 없이 회원 관리로 가는 묶음 경로라 제목이 없습니다.
  const routes = [...Object.values(appPaths).filter((path) => path !== appPaths.admin), ...Object.values(publicPaths),
    '/examples/sample-item/hook', '/examples/sample-item/redux']

  it.each(routes)('%s에 화면 이름이 있다', (path) => {
    expect(screenTitleFor(concrete(path))).not.toBeNull()
  })

  it('"화면 이름 · GovBiz"로 쓰고 고정 경로를 :id 경로보다 먼저 맞춘다', () => {
    expect(documentTitleFor('/app/saved-programs')).toBe('관심 공고함 · GovBiz')
    expect(documentTitleFor('/app/application-preparations/new')).toBe('새 문서 · GovBiz')
    expect(documentTitleFor('/app/application-preparations/12')).toBe('답변 입력 · GovBiz')
    expect(documentTitleFor('/app/application-preparations/12/documents')).toBe('신청 문서 초안 · GovBiz')
    expect(documentTitleFor('/app/combination-reviews/new')).toBe('새 검토 · GovBiz')
    expect(documentTitleFor('/app/combination-reviews/12/runs/30')).toBe('검토 결과 · GovBiz')
    expect(documentTitleFor('/app/partners/')).toBe('파트너 관리 · GovBiz')
    expect(documentTitleFor('/partners')).toBe('파트너 모집 · GovBiz')
  })

  it('검색 화면은 검색 방식 탭 이름을 쓰고, 모르는 주소는 GovBiz만 쓴다', () => {
    expect(documentTitleFor('/')).toBe('AI 대화 검색 · GovBiz')
    expect(documentTitleFor('/app/chat', '?mode=filter')).toBe('필터 검색 · GovBiz')
    expect(documentTitleFor('/app/unknown')).toBe('GovBiz')
  })
})
