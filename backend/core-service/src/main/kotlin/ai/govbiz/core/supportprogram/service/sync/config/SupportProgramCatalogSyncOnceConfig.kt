package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogSyncOnceService
import ai.govbiz.core.supportprogram.service.sync.SupportProgramIndexSyncService
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.CommandLineRunner
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.ConfigurableApplicationContext
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.core.env.MapPropertySource

/** 자동 스케줄러 없이 기존 수집·색인·영속성 구현을 한 번 호출하는 CLI 진입점입니다. */
@Configuration(proxyBeanMethods = false)
@Profile(SupportProgramCatalogSyncOnceConfig.PROFILE)
@EnableConfigurationProperties(SupportProgramCatalogSyncOnceProperties::class)
@ai.govbiz.core.supportprogram.service.projection.config.EmbeddedCatalogOnly
class SupportProgramCatalogSyncOnceConfig {
    @Bean
    fun supportProgramCatalogSyncOnceService(
        @Qualifier("bizInfoSupportProgramCatalogFacade") bizInfo: SupportProgramCatalogFacade,
        @Qualifier("kStartupSupportProgramCatalogFacade") kStartup: SupportProgramCatalogFacade,
        @Qualifier("msitSupportProgramCatalogFacade") msit: SupportProgramCatalogFacade,
        @Qualifier("cnTradeNoticeSupportProgramCatalogFacade") cnTrade: SupportProgramCatalogFacade,
        repository: SupportProgramRepository,
        indexService: SupportProgramIndexSyncService,
        publicationService: ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService,
    ) = SupportProgramCatalogSyncOnceService(bizInfo, kStartup, msit, cnTrade, repository, indexService, publicationService)

    @Bean
    fun supportProgramCatalogSyncOnceCommandLineRunner(
        service: SupportProgramCatalogSyncOnceService,
        properties: SupportProgramCatalogSyncOnceProperties,
    ) = CommandLineRunner { service.run(properties) }

    companion object {
        const val PROFILE = "catalog-sync-once"

        /** Bean 생성 전에 적용하므로 환경변수/CLI가 true여도 예약 작업을 시작하지 않습니다. */
        fun isolate(context: ConfigurableApplicationContext) {
            val environment = context.environment
            if (!environment.matchesProfiles(PROFILE)) return
            require(environment.getProperty("app.catalog.projection.enabled", Boolean::class.java, false).not()) {
                "catalog-sync-once belongs to Catalog after remote ownership is enabled"
            }
            require(environment.activeProfiles.toSet() == setOf(PROFILE)) { "catalog-sync-once must run alone" }
            require(environment.getProperty("spring.main.web-application-type") == "none") { "catalog-sync-once must not serve HTTP" }
            environment.propertySources.addFirst(MapPropertySource("catalog-sync-once-isolation", disabledProperties))
        }

        private val disabledProperties = listOf(
            "app.bizinfo.sync.enabled", "app.kstartup.sync.enabled", "app.msit.sync.enabled",
            "app.cntrade-notice.sync.enabled", "app.support-program-index.enabled",
            "app.daily-report.enabled", "app.daily-report.queue.enabled", "app.daily-report.queue.delivery-enabled",
            "app.combination-review.queue.enabled", "app.application-form-discovery.queue.enabled", "app.application-form-analysis.enabled",
            "app.account.oauth.unlink.enabled", "app.account.oauth.unlink.queue-enabled",
            "app.daily-report.mail-enabled", "app.account.password-reset.mail-enabled", "spring.flyway.enabled",
        ).associateWith { false }
    }
}
