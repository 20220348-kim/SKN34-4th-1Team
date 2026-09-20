package ai.govbiz.core._sampleitem.controller.dto

import ai.govbiz.core._sampleitem.domain.SampleCategory
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size

/** 샘플 항목의 공개 입력 DTO입니다. */
data class SampleItemRequest(
    @field:NotBlank
    @field:Size(max = 100)
    val name: String?,
    val category: SampleCategory?,
    @field:Size(max = 500)
    val note: String?,
)
