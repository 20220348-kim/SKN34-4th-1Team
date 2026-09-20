import { useState } from 'react'

/** 실제 회원별 저장 API가 연결되기 전, 상세 화면의 관심 등록 버튼 상태만 관리합니다. */
export function useSupportProgramBookmarkPreviewViewModel() {
  const [isSaved, setIsSaved] = useState(false)

  return {
    isSaved,
    label: isSaved ? '관심 공고 해제' : '관심 공고 등록',
    toggle: () => setIsSaved(value => !value),
  }
}
