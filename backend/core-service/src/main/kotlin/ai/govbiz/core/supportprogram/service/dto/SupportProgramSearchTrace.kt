package ai.govbiz.core.supportprogram.service.dto

/**
 * 비공개 검색 품질 평가에서 후보 선정과 최종 추천 결과를 함께 기록하는 실행 흔적입니다.
 *
 * candidateIds와 finalProgramIds는 제공처 코드와 원본 공고 ID를 합친 `sourceCode:sourceProgramId` 형식입니다.
 * presentProgramCount는 이번 검색 시점에 색인이 준비된 제공처의 공개 공고 수(접수 상태 필터 전)입니다.
 */
data class SupportProgramSearchTrace(
    val result: SupportProgramSearchResult,
    val candidateIds: List<String>,
    val finalProgramIds: List<String>,
    val presentProgramCount: Int,
    val eligibleProgramCount: Int,
    val eligibleCatalogFingerprint: String,
) {
    init {
        require(result.query.isNotBlank()) { "search trace requires a nonblank query" }
        require(presentProgramCount >= eligibleProgramCount) {
            "eligible program count must not exceed present program count"
        }
        require(eligibleCatalogFingerprint.matches(Regex("[0-9a-f]{64}"))) {
            "eligible catalog SHA-256 must be lowercase hexadecimal"
        }
    }
}
