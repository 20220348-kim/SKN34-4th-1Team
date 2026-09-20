/** 계정을 지우면 함께 사라지거나 닫히는 것들입니다. 삭제 확인 모달이 숫자로 보여 줍니다. */
export type AccountDeletionPreview = {
  hasCompany: boolean
  /** 아직 마감하지 않은 내 모집글 수입니다. 삭제하면 마감돼 받은 제안은 만료로 보입니다. */
  openRecruitmentCount: number
  receivedPendingProposalCount: number
  /** 삭제하면 철회되는 내가 보낸 대기 제안 수입니다. */
  sentPendingProposalCount: number
}
