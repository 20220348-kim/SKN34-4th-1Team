package ai.govbiz.core.supportprogram.service.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramRankingExclusions
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import java.time.Instant

data class SupportProgramSearchPreviewResult(
    val query: String,
    val programs: List<SupportProgram>,
    val totalCount: Int,
    val resultToken: String? = null,
    val expiresAt: Instant? = null,
    /** 이번 검색에서 추천에서 뺀 후보 수입니다. 로그인 뒤 복원한 결과는 null입니다. */
    val exclusionCounts: SupportProgramRankingExclusions? = null,
)

data class SupportProgramSearchRestoredResult(
    val result: SupportProgramSearchPreviewResult,
    val context: SupportProgramConversationContext,
)
