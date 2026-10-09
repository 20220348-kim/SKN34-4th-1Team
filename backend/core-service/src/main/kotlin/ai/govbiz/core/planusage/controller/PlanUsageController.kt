package ai.govbiz.core.planusage.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.planusage.controller.dto.PlanUsageResponse
import ai.govbiz.core.planusage.service.PlanUsageService
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 화면이 현재 요금제를 보여 주기 위한 조회입니다. 로그인하지 않았으면 요금제 없이 돌려줍니다. */
@RestController
@RequestMapping("/api/v1/plan-usage")
class PlanUsageController(private val service: PlanUsageService) {

    @GetMapping
    fun usage(account: Account?): ResponseEntity<PlanUsageResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(PlanUsageResponse.from(service.usage(account)))
}
