package ai.govbiz.core.supportprogram.service.evaluation.config

import ai.govbiz.core.supportprogram.service.evaluation.SupportProgramSearchEvaluationCaptureCommandLineRunner
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.Clock
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.CommandLineRunner
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import tools.jackson.databind.ObjectMapper

/** 공개 HTTP 요청 없이 검색 품질 평가 결과만 파일로 남기는 실행 프로필 구성입니다. */
@Configuration(proxyBeanMethods = false)
@Profile(SupportProgramSearchEvaluationCaptureConfig.PROFILE)
@EnableConfigurationProperties(SupportProgramSearchEvaluationCaptureProperties::class)
class SupportProgramSearchEvaluationCaptureConfig {

    @Bean
    fun supportProgramSearchEvaluationCaptureCommandLineRunner(
        properties: SupportProgramSearchEvaluationCaptureProperties,
        searchService: SupportProgramSearchService,
        objectMapper: ObjectMapper,
        @Qualifier("seoulClock") clock: Clock,
    ): CommandLineRunner = SupportProgramSearchEvaluationCaptureCommandLineRunner(
        properties = properties,
        searchService = searchService,
        objectMapper = objectMapper,
        clock = clock,
    )

    companion object {
        const val PROFILE = "evaluation-capture"
    }
}
