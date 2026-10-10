export type ServiceInformationSection = 'terms' | 'privacy' | 'support'

/** 운영 문서가 확정되면 이 내용과 문의처를 교체합니다. 현재 문서는 운영 약관·처리방침으로 확정되지 않았습니다. */
export const serviceInformation = {
  terms: {
    title: '이용약관',
    preparing: true,
    sections: [
      { title: '문서 준비 중', body: '이용약관은 아직 확정되지 않았어요. 아래는 확정할 내용의 초안이며 정식 운영 문서가 아니에요.' },
      { title: '서비스 제공 범위', body: '공고 탐색·관심 공고·신청 준비·협업 기능의 제공 범위와 AI 결과의 이용 조건을 확정할 예정이에요.' },
      { title: '계정과 이용 조건', body: '가입·계정 관리·이용 제한·탈퇴 및 운영자의 책임과 문의 경로를 확정해야 해요.' },
    ],
  },
  privacy: {
    title: '개인정보 처리방침',
    preparing: true,
    sections: [
      { title: '문서 준비 중', body: '개인정보 처리방침은 아직 확정되지 않았어요. 아래는 검토할 항목이며 실제 운영 정책으로 확정된 내용이 아니에요.' },
      { title: '정보 처리 범위', body: '계정·기업 정보·질문과 작성 답변·알림 기기 정보의 수집 목적, 보관 기간과 삭제 범위를 확정해야 해요.' },
      { title: '외부 처리와 문의', body: '외부 AI 처리 범위, 관련 업체, 처리 위치와 개인정보 관련 문의처를 확인해 문서에 반영해야 해요.' },
    ],
  },
  support: {
    title: '도움말·문의',
    preparing: true,
    sections: [
      { title: '지원사업 찾기', body: 'AI 검색에서 조건을 정리한 뒤 확인하고 검색해요. 직접 조건을 고르려면 필터 검색을 이용하세요.' },
      { title: '신청 준비', body: '공고와 양식을 선택해 답변을 작성해요. 저장·분석·문서 생성이 진행 중이면 기존 작업의 상태를 먼저 확인하세요.' },
      { title: '문의처 준비 중', body: '실제 문의처는 아직 정해지지 않았어요. 이 화면에서는 문의를 접수하거나 내용을 전송하지 않아요.', onlyWhenContactMissing: true },
    ],
  },
} as const

export const serviceContact: { email: string | null; url: string | null } = { email: null, url: null }
