package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram

/** 상위 Service에 전체 검증을 마친 정규화 지원사업 목록을 제공하는 Facade 계약입니다. */
fun interface SupportProgramCatalogFacade {
    fun load(): List<CatalogSupportProgram>
}
