package ai.govbiz.core.combinationreview.domain.exception

/** 검토 식별·입력 버전·실행 예약에 관한 업무 실패. HTTP와 영속성 구현에 의존하지 않는다. */
class CombinationReviewNotFoundException : RuntimeException()
class CombinationReviewRevisionConflictException : RuntimeException()
class CombinationReviewRunConflictException : RuntimeException()
class CombinationReviewCapacityException : RuntimeException()
