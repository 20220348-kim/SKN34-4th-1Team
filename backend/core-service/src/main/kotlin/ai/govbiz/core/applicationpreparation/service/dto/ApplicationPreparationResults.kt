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
)

data class ApplicationPreparationPageResult(
    val items: List<ApplicationPreparationListItemResult>,
    val nextBeforeId: Long?,
)
