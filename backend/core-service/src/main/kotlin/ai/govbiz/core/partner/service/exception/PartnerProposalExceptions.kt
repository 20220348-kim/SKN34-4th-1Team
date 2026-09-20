package ai.govbiz.core.partner.service.exception

/** 요청한 제안이 없거나 당사자가 아닌 계정이 조회할 때 발생합니다. 존재 여부를 드러내지 않습니다. */
class ProposalNotFoundException : RuntimeException()

/** 자기 모집글에는 제안을 보낼 수 없습니다. */
class ProposalToOwnRecruitmentException : RuntimeException()

/** 마감된 모집글에는 제안을 보낼 수 없습니다. */
class RecruitmentClosedException : RuntimeException()

/** 같은 모집글에 이미 제안을 보냈을 때 발생합니다. 철회·거절·만료된 제안도 다시 보낼 수 없습니다. */
class ProposalAlreadySentException : RuntimeException()

/** 대기 중이 아닌 제안을 수락·거절·철회하려 할 때 발생합니다. */
class ProposalNotPendingException : RuntimeException()

/** 모집글 작성자가 아닌 계정의 수락·거절, 제안자가 아닌 계정의 철회입니다. */
class ProposalActionForbiddenException : RuntimeException()
