package ai.govbiz.core.supportprogram.domain

/** 로그인 후 재검색 없이 복원할 한 번의 검색 결과와 당시 검색 조건입니다. */
data class SupportProgramSearchSnapshot(
    val query: String,
    val programs: List<SupportProgram>,
    val context: SupportProgramConversationContext,
)
