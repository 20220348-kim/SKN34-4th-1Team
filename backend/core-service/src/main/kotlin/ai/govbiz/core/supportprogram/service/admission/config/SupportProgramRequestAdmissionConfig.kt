package ai.govbiz.core.supportprogram.service.admission.config

import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Primary

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SupportProgramRequestAdmissionProperties::class)
class SupportProgramRequestAdmissionConfig {
    /** 공유 한도 Bean입니다. 도우미 에이전트 전용 한도 Bean이 하나 더 있어 기본(무자격) 주입은 이쪽입니다. */
    @Bean
    @Primary
    fun supportProgramRequestAdmissionService(
        properties: SupportProgramRequestAdmissionProperties,
    ) = SupportProgramRequestAdmissionService(properties)
}
