package ai.govbiz.catalog.internal.controller

import ai.govbiz.catalog.internal.controller.dto.CatalogSnapshotResponse
import ai.govbiz.catalog.internal.service.CatalogSnapshotService
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RestController

@RestController
class CatalogSnapshotController(private val service: CatalogSnapshotService) {
    @GetMapping("/internal/v1/catalog/snapshots/{sourceCode}")
    fun snapshot(@PathVariable sourceCode: String): CatalogSnapshotResponse =
        CatalogSnapshotResponse.from(service.get(sourceCode))

    @GetMapping("/health")
    fun health() = mapOf("status" to "UP")

    @GetMapping("/readiness")
    fun readiness(): ResponseEntity<Map<String, String>> =
        if (service.isReady()) ResponseEntity.ok(mapOf("status" to "UP"))
        else ResponseEntity.status(503).body(mapOf("status" to "DOWN"))
}
