package ai.govbiz.core.planusage.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.planusage.controller.dto.PlanUsageResponse
import ai.govbiz.core.planusage.controller.dto.StartPlanTrialRequest
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.service.PlanUsageService
import jakarta.validation.Valid
import org.springframework.http.CacheControl
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 로그인한 회원이 출시 전 무료 체험을 시작합니다. 결제 수단을 받지 않으며 끝나면 무료로 돌아갑니다. */
@RestController
@RequestMapping("/api/v1/plan-trials")
class PlanTrialController(private val service: PlanUsageService) {

    @PostMapping
    fun start(account: Account, @RequestBody @Valid request: StartPlanTrialRequest): ResponseEntity<PlanUsageResponse> =
        ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore())
            .body(PlanUsageResponse.from(service.startTrial(account, PlanCode.valueOf(request.plan))))
}
