package ai.govbiz.core.admin.controller

import ai.govbiz.core.admin.controller.dto.QueueOperationsResponse
import ai.govbiz.core.admin.service.QueueOperationsService
import ai.govbiz.core.admin.web.AdminPrincipal
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/admin/queues")
class QueueOperationsController(private val service: QueueOperationsService) {
    @GetMapping
    fun status(admin: AdminPrincipal): ResponseEntity<List<QueueOperationsResponse>> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.status().map(QueueOperationsResponse::from))
}
