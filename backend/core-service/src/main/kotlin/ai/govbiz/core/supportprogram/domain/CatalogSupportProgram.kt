package ai.govbiz.core.supportprogram.domain

/** 외부 공고를 정규화한 검색 후보와 결정적인 정렬 값을 묶은 업무 모델입니다. */
data class CatalogSupportProgram(
    val program: SupportProgram,
    val sortTimestamp: String,
    val startupDetails: SupportProgramStartupDetails? = null,
)
