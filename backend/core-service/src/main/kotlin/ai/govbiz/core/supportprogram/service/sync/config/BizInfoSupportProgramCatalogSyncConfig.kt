package ai.govbiz.core.supportprogram.service.sync.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.annotation.EnableScheduling

/** 기업마당 지원사업 카탈로그 동기화 작업을 예약 실행할 수 있게 설정합니다. */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@EnableConfigurationProperties(BizInfoSupportProgramCatalogSyncProperties::class)
class BizInfoSupportProgramCatalogSyncConfig
