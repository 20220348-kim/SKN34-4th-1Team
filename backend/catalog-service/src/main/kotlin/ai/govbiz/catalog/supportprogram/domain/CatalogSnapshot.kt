package ai.govbiz.catalog.supportprogram.domain

/** 한 제공처의 같은 DB 시점에서 읽은 공개 카탈로그입니다. */
data class CatalogSnapshot(
    val catalogId: String,
    val revision: Long,
    val status: SupportProgramSyncStatus,
    val programs: List<CatalogSupportProgram>,
)

object CatalogSource {
    val CODES = setOf("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")
}
