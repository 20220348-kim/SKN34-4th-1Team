package ai.govbiz.core.assistant.config

import ai.govbiz.core.assistant.service.AssistantToolTokenService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import java.time.Clock
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AssistantAgentProperties::class)
class AssistantAgentConfig {
    @Bean
    fun assistantToolTokenService(
        properties: AssistantAgentProperties,
        @Qualifier("seoulClock") clock: Clock,
    ) = AssistantToolTokenService(properties, clock)

    /** 관심 공고 원문 확보·색인을 공고별로 병렬 실행하는 풀입니다. 요청당 최대 10건, 전체 예산 6초입니다. */
    @Bean(destroyMethod = "shutdownNow")
    fun assistantDocumentExecutor(): ExecutorService = Executors.newFixedThreadPool(4) { runnable ->
        Thread(runnable, "assistant-document-").apply { isDaemon = true }
    }

    /** 에이전트 경로만의 주소당 분당 상한입니다. 전체 분당·동시 실행 한도는 공유 Bean이 이미 걸므로 여기서는 사실상 걸지 않습니다. */
    @Bean
    fun assistantAgentAdmissionService(properties: AssistantAgentProperties) = SupportProgramRequestAdmissionService(
        SupportProgramRequestAdmissionProperties(
            perClientPerMinute = properties.agentPerClientPerMinute, globalPerMinute = 10_000, maxConcurrent = 100,
        ),
    )
}
