package ai.govbiz.core.applicationpreparation.service.exception

import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMapSnapshot
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMappingChange

/** Carries a validated proposal to the owner-scoped approval flow without publishing it. */
class ApplicationDocumentMappingChangedException(
    val previous: ApplicationDocumentMapSnapshot,
    val proposed: ApplicationDocumentMapSnapshot,
    val changes: List<ApplicationDocumentMappingChange>,
) : RuntimeException("기존 입력 위치 또는 편집 범위가 새 분석과 달라 자동 작성을 중단했습니다.")
