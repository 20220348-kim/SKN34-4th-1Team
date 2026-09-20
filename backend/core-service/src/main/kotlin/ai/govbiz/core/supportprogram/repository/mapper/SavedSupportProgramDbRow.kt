package ai.govbiz.core.supportprogram.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 관심 공고 한 행을 현재 공고 행과 함께 읽기 위한 DB 행 값입니다. */
data class SavedSupportProgramDbRow(
    var id: Long = 0,
    var savedAt: LocalDateTime? = null,
    var program: SupportProgramDbRow? = null,
)
