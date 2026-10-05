package ai.govbiz.core.supportprogram.client.catalog.dto

import com.fasterxml.jackson.annotation.JsonProperty
import java.time.LocalDate
import java.time.LocalDateTime

/** Catalog v1의 제공처별 완전한 공개 스냅샷입니다. 내부 DB 숫자 ID는 전송하지 않습니다. */
data class CatalogSnapshotResponse(
    val schemaVersion: Int,
    val catalogId: String,
    val revision: Long,
    val status: CatalogSyncStatusResponse,
    val programs: List<CatalogProgramResponse>,
)

data class CatalogSyncStatusResponse(
    val sourceCode: String,
    @param:JsonProperty(required = true)
    val publishedGeneration: Long?,
    @param:JsonProperty(required = true)
    val publishedCatalogFingerprint: String?,
    val publishedProgramCount: Int,
    val indexReady: Boolean,
    @param:JsonProperty(required = true)
    val lastSuccessfulSyncAt: LocalDateTime?,
    @param:JsonProperty(required = true)
    val lastFailedSyncAt: LocalDateTime?,
    val lastSyncOutcome: String,
)

data class CatalogProgramResponse(
    val program: CatalogProgramPayload,
    val sortTimestamp: String,
    @param:JsonProperty(required = true)
    val startupDetails: CatalogStartupDetailsPayload?,
)

data class CatalogProgramPayload(
    val id: String,
    val sourceCode: String,
    val title: String,
    val organization: String,
    val summary: String,
    val categories: List<String>,
    val regions: List<String>,
    val targetDescription: String,
    val applicationPeriod: String,
    @param:JsonProperty(required = true)
    val applicationStartDate: LocalDate?,
    @param:JsonProperty(required = true)
    val applicationEndDate: LocalDate?,
    val status: String,
    val sourceName: String,
    val sourceUrl: String,
    val applicationRoute: CatalogApplicationRoutePayload? = null,
    // 공식 문의처·우대 사항·주관 기관 유형은 이 필드를 보내기 전 Catalog와도 projection이 이어지도록 생략을 허용합니다.
    val contact: CatalogContactPayload? = null,
    val preferenceDescription: String? = null,
    val supervisingInstitutionType: String? = null,
)

data class CatalogApplicationRoutePayload(
    val method: String?,
    val url: String?,
    val type: String,
)

data class CatalogContactPayload(
    val department: String?,
    val phoneNumber: String?,
    val text: String?,
)

data class CatalogStartupDetailsPayload(
    val startupStages: List<String>,
    val applicantTypes: List<String>,
    val founderAges: List<String>,
)
