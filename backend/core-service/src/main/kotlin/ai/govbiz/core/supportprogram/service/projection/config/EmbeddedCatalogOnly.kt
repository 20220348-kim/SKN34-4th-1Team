package ai.govbiz.core.supportprogram.service.projection.config

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty

/** 전환 호환 경로입니다. 원격 Catalog 모드에서는 Core의 원본 수집·색인 writer를 조립하지 않습니다. */
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
@ConditionalOnProperty(prefix = "app.catalog.projection", name = ["enabled"], havingValue = "false", matchIfMissing = true)
annotation class EmbeddedCatalogOnly
