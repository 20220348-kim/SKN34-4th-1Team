package ai.govbiz.core.account.service.dto

/** 계정을 지우면 함께 사라지거나 닫히는 것들입니다. 확인 화면이 숫자를 보여 주는 데 씁니다. */
data class AccountDeletionPreview(
    val hasCompany: Boolean,
    /** 아직 마감하지 않은 내 모집글 수입니다. 삭제하면 마감돼 받은 제안은 만료로 보입니다. */
    val openRecruitmentCount: Int,
    val receivedPendingProposalCount: Int,
    /** 삭제하면 철회되는 내가 보낸 대기 제안 수입니다. */
    val sentPendingProposalCount: Int,
)
