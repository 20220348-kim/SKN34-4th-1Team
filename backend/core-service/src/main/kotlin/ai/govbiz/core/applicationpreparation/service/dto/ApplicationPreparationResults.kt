package ai.govbiz.core.applicationpreparation.service.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationPreparationSummary
import ai.govbiz.core.applicationpreparation.domain.StoredApplicationPreparation
import ai.govbiz.core.applicationpreparation.domain.ConfirmedApplicationFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretation

data class ApplicationPreparationDetailResult(
    val preparation: StoredApplicationPreparation,
    val form: ApplicationFormManifest,
    val facts: List<ConfirmedApplicationFact> = emptyList(),
    val contents: List<ai.govbiz.core.applicationpreparation.domain.ApplicationContentVersion> = emptyList(),
)

data class ApplicationInterpretationResult(val runId: Long, val interpretation: ApplicationInterpretation)

data class ApplicationPreparationListItemResult(
    val preparation: ApplicationPreparationSummary,
    val form: ApplicationFormManifest,
    /** 필수 문항 중 PROVIDED 사실이 저장된 수. */
    val answeredRequired: Int = 0,
    val requiredTotal: Int = 0,
    /** 카탈로그에 현재 공고가 있을 때만 채운다. */
    val applicationPeriod: String? = null,
    val applicationEndDate: java.time.LocalDate? = null,
)

data class ApplicationPreparationPageResult(
    val items: List<ApplicationPreparationListItemResult>,
    val nextBeforeId: Long?,
)

/** 한 답변 버전의 문서 파일을 한 번에 내려받는 결과. 파일이 하나면 그 파일 그대로, 여럿이면 zip이다. */
data class ApplicationDocumentArchiveResult(
    val fileName: String,
    val mediaType: String,
    val bytes: ByteArray,
    val fileCount: Int,
)
