package ai.govbiz.core.combinationreview.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.combinationreview.controller.dto.*
import ai.govbiz.core.combinationreview.service.CombinationReviewRunService
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import java.net.URI
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/combination-reviews/{reviewId}/runs")
class CombinationReviewRunController(private val service: CombinationReviewRunService) {
    @PostMapping
    fun start(account: Account, @PathVariable @Min(1) reviewId: Long, @RequestBody @Valid request: StartCombinationReviewRunRequest): ResponseEntity<CombinationReviewRunResponse> {
        val result = service.start(account, reviewId, request.expectedRevision, request.requestKey, request.additionalFacts)
        return ResponseEntity.status(if (result.created) 202 else 200).cacheControl(CacheControl.noStore())
            .location(URI.create("/api/v1/combination-reviews/$reviewId/runs/${result.run.id}"))
            .body(CombinationReviewRunResponse.from(result.run))
    }

    @GetMapping("/{runId}")
    fun detail(account: Account, @PathVariable @Min(1) reviewId: Long, @PathVariable @Min(1) runId: Long): ResponseEntity<CombinationReviewRunResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(CombinationReviewRunResponse.from(service.findOwned(account, reviewId, runId)))

    @GetMapping
    fun list(account: Account, @PathVariable @Min(1) reviewId: Long,
             @RequestParam(required = false) @Min(1) beforeId: Long?, @RequestParam(defaultValue = "20") @Min(1) @Max(50) size: Int): ResponseEntity<CombinationReviewRunPageResponse> {
        val rows = service.listOwned(account, reviewId, beforeId, size)
        val items = rows.take(size)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(CombinationReviewRunPageResponse(
            items.map(CombinationReviewRunSummaryResponse::from), items.lastOrNull()?.id?.takeIf { rows.size > size },
        ))
    }

    @GetMapping("/{runId}/sources/{documentIndex}")
    fun source(account: Account, @PathVariable @Min(1) reviewId: Long, @PathVariable @Min(1) runId: Long,
               @PathVariable @Min(0) @Max(11) documentIndex: Int): ResponseEntity<ByteArray> {
        val (document, bytes) = service.download(account, reviewId, runId, documentIndex)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_OCTET_STREAM)
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=source-$documentIndex.${document.format.lowercase()}")
            .header("X-Content-Type-Options", "nosniff").body(bytes)
    }
}
