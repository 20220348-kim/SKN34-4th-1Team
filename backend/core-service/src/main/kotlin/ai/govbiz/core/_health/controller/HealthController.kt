package ai.govbiz.core._health.controller

import ai.govbiz.core._health.controller.dto.HealthResponse
import org.springframework.beans.factory.annotation.Value
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/health")
class HealthController(
    @param:Value("\${spring.application.name}") private val serviceName: String,
) {

    @GetMapping
    fun health(): HealthResponse = HealthResponse.up(serviceName)
}
