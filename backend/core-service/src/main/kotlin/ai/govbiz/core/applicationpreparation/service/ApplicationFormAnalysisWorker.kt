package ai.govbiz.core.applicationpreparation.service

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** 기존 Core 프로세스의 scheduler를 사용한다. 신규 실행 계층이나 계정별 큐는 만들지 않는다. */
@Component
@ConditionalOnProperty(name = ["app.application-form-analysis.enabled"], havingValue = "true")
class ApplicationFormAnalysisWorker(private val service: ApplicationFormAnalysisService) {
    @Scheduled(fixedDelayString = "\${app.application-form-analysis.delay-ms:30000}", scheduler = "applicationFormAnalysisTaskScheduler")
    fun run() { service.runNext() }
}
