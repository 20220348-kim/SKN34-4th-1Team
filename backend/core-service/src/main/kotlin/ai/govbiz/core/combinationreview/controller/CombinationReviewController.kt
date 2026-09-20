package ai.govbiz.core.combinationreview.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.combinationreview.controller.dto.CombinationReviewPageResponse
import ai.govbiz.core.combinationreview.controller.dto.CombinationReviewResponse
import ai.govbiz.core.combinationreview.controller.dto.CreateCombinationReviewRequest
import ai.govbiz.core.combinationreview.controller.dto.ReplaceCombinationReviewInputRequest
import ai.govbiz.core.combinationreview.service.CombinationReviewService
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import java.net.URI
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/combination-reviews")
class CombinationReviewController(private val service: CombinationReviewService) {
    @PostMapping
    fun create(
        account: Account,
        @RequestBody @Valid request: CreateCombinationReviewRequest,
    ): ResponseEntity<CombinationReviewResponse> {
        val review = service.create(account, request.toDraft())
        return ResponseEntity.created(URI.create("/api/v1/combination-reviews/${review.id}"))
            .cacheControl(CacheControl.noStore()).body(CombinationReviewResponse.from(review))
    }

    @GetMapping
    fun list(
        account: Account,
        @RequestParam(required = false) @Min(1) beforeId: Long?,
        @RequestParam(defaultValue = "20") @Min(1) @Max(50) size: Int,
    ): ResponseEntity<CombinationReviewPageResponse> = ResponseEntity.ok().cacheControl(CacheControl.noStore())
        .body(CombinationReviewPageResponse.from(service.listOwned(account, beforeId, size)))

    @GetMapping("/{id}")
    fun detail(account: Account, @PathVariable @Min(1) id: Long): ResponseEntity<CombinationReviewResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(CombinationReviewResponse.from(service.findOwned(account, id)))

    @DeleteMapping("/{id}")
    fun delete(account: Account, @PathVariable @Min(1) id: Long): ResponseEntity<Void> {
        service.deleteOwned(account, id)
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }

    @PutMapping("/{id}/inputs")
    fun replace(
        account: Account,
        @PathVariable @Min(1) id: Long,
        @RequestBody @Valid request: ReplaceCombinationReviewInputRequest,
    ): ResponseEntity<Void> {
        service.replaceOwned(account, id, request.expectedRevision, request.toDraft())
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }
}
