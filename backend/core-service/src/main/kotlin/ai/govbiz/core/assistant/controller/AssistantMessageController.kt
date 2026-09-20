package ai.govbiz.core.assistant.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.assistant.controller.dto.AssistantMessageRequest
import ai.govbiz.core.assistant.controller.dto.AssistantMessageResponse
import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.assistant.service.AssistantMessageService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 도우미 자유 질문 입구입니다. 비로그인도 물을 수 있고, 세션이 있으면 회원 상태 답에 씁니다.
 * 요청량·동시 실행 한도는 검색·원문 질문과 같은 Bean을 공유하므로 도우미가 한도를 따로 늘리지 않습니다.
 * 도구 에이전트가 켜져 있으면 모델을 여러 번 부르므로 주소당 분당 상한(`app.assistant.agent-per-client-per-minute`)을 더 겁니다.
 */
@RestController
@RequestMapping("/api/v1/assistant")
class AssistantMessageController(
    private val service: AssistantMessageService,
    private val admission: SupportProgramRequestAdmissionService,
    @param:Qualifier("assistantAgentAdmissionService") private val agentAdmission: SupportProgramRequestAdmissionService,
    private val properties: AssistantAgentProperties,
) {
    @PostMapping("/messages")
    fun answer(
        account: Account?,
        @RequestBody @Valid request: AssistantMessageRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<AssistantMessageResponse> = admission.execute(httpRequest.remoteAddr) {
        withAgentLimit(httpRequest.remoteAddr) {
            ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(AssistantMessageResponse.from(service.answer(account, request.toDomain())))
        }
    }

    private fun <T> withAgentLimit(clientAddress: String, action: () -> T): T =
        if (properties.agentEnabled) agentAdmission.execute(clientAddress, action) else action()
}
