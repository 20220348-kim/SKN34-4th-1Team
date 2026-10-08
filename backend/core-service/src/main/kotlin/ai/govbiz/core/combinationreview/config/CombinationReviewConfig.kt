package ai.govbiz.core.combinationreview.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration

/** 큐 사용 여부와 관계없이 중복 검토 설정을 시작 시점에 검증합니다. */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(CombinationReviewProperties::class)
class CombinationReviewConfig
