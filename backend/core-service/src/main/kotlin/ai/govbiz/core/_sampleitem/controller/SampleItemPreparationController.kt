package ai.govbiz.core._sampleitem.controller

import ai.govbiz.core._sampleitem.controller.dto.SampleItemPreparationRequest
import ai.govbiz.core._sampleitem.controller.dto.SampleItemPreparationResponse
import ai.govbiz.core._sampleitem.controller.dto.SampleItemRequest
import ai.govbiz.core._sampleitem.domain.SampleItem
import ai.govbiz.core._sampleitem.service.SampleItemPreparationService
import jakarta.validation.Valid
import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 프런트엔드 Data Layer와 Core API 수직 슬라이스를 보여 주는 공개 예제 API입니다. */
@RestController
@RequestMapping("/api/v1/sample-items")
class SampleItemPreparationController(
    private val preparationService: SampleItemPreparationService,
) {

    @PostMapping(
        path = ["/prepare"],
        consumes = [MediaType.APPLICATION_JSON_VALUE],
        produces = [MediaType.APPLICATION_JSON_VALUE],
    )
    fun prepare(
        @Valid @RequestBody request: SampleItemPreparationRequest,
    ): SampleItemPreparationResponse {
        val requestedItem = requireNotNull(request.item)
        val preparation = preparationService.prepare(
            SampleItem.create(requestedItem.name, requestedItem.category, requestedItem.note),
        )
        val item = preparation.item
        return SampleItemPreparationResponse(
            phase = preparation.phase,
            item = SampleItemPreparationResponse.Item(item.name, item.category, item.note),
            processing = SampleItemPreparationResponse.Processing(preparation.processingStatus),
        )
    }
}
