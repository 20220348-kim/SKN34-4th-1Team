package ai.govbiz.core.supportprogram.service.evaluation.config

import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.evaluation.SupportProgramSearchEvaluationFixtureExportCommandLineRunner
import org.springframework.boot.CommandLineRunner
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import tools.jackson.databind.ObjectMapper

/** 공개 HTTP 요청 없이 현재 적격 공고를 평가 fixture 초안으로 내보내는 실행 프로필 구성입니다. */
@Configuration(proxyBeanMethods = false)
@Profile(SupportProgramSearchEvaluationFixtureExportConfig.PROFILE)
@EnableConfigurationProperties(SupportProgramSearchEvaluationFixtureExportProperties::class)
class SupportProgramSearchEvaluationFixtureExportConfig {

    @Bean
    fun supportProgramSearchEvaluationFixtureExportCommandLineRunner(
        properties: SupportProgramSearchEvaluationFixtureExportProperties,
        supportProgramRepository: SupportProgramRepository,
        objectMapper: ObjectMapper,
    ): CommandLineRunner = SupportProgramSearchEvaluationFixtureExportCommandLineRunner(
        properties = properties,
        supportProgramRepository = supportProgramRepository,
        objectMapper = objectMapper,
    )

    companion object {
        const val PROFILE = "evaluation-fixture-export"
    }
}
