package ai.govbiz.core._sampleitem.controller.dto

import jakarta.validation.Valid
import jakarta.validation.constraints.NotNull

/** 예제 준비 API의 공개 요청 DTO입니다. */
data class SampleItemPreparationRequest(
    @field:NotNull
    @field:Valid
    val item: SampleItemRequest?,
)
