package ai.govbiz.core._sampleitem.controller.dto

import ai.govbiz.core._sampleitem.domain.ProcessingStatus
import ai.govbiz.core._sampleitem.domain.SampleCategory
import ai.govbiz.core._sampleitem.domain.SampleItemPhase

/** 예제 준비 API가 소유하는 공개 응답 DTO입니다. */
data class SampleItemPreparationResponse(
    val phase: SampleItemPhase,
    val item: Item,
    val processing: Processing,
) {
    data class Item(
        val name: String,
        val category: SampleCategory?,
        val note: String?,
    )

    data class Processing(
        val status: ProcessingStatus,
    )
}
