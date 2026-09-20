package ai.govbiz.core.supportprogram.domain

import java.time.LocalDateTime

/** 회원이 관심 공고함에 담은 공고 하나입니다. [program]은 담을 때가 아니라 조회 시점의 현재 공고 내용입니다. */
data class SavedSupportProgram(
    val savedAt: LocalDateTime,
    val program: SupportProgram,
)

/** 관심 공고 원문 선수집(outbox) 상태입니다. DONE은 하루가 지나면 다시 PENDING이 됩니다. */
enum class SavedSupportProgramPrefetchStatus {
    PENDING,
    PUBLISHED,
    DONE,
    FAILED,
}
