package ai.govbiz.core.supportprogram.service.projection

import ai.govbiz.core.supportprogram.client.catalog.config.CatalogClientProperties
import ai.govbiz.core.supportprogram.client.catalog.exception.CatalogServiceCallException
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
@ConditionalOnProperty(prefix = "app.catalog.projection", name = ["enabled"], havingValue = "true")
class CatalogProjectionScheduler(
    private val service: CatalogProjectionService,
    private val properties: CatalogClientProperties,
) {
    @Scheduled(
        initialDelayString = "\${app.catalog.projection.initial-delay:PT5S}",
        fixedDelayString = "\${app.catalog.projection.fixed-delay:PT30S}",
        scheduler = "catalogProjectionTaskScheduler",
    )
    fun synchronize() {
        for (sourceCode in properties.sources) {
            try {
                if (service.synchronize(sourceCode)) log.info("catalog_projection source={} outcome=applied", sourceCode)
            } catch (exception: CatalogServiceCallException) {
                log.warn("catalog_projection source={} outcome=retained_previous failure={}", sourceCode, exception.failure)
            } catch (exception: RuntimeException) {
                log.error("catalog_projection source={} outcome=retained_previous failure={}", sourceCode, exception.javaClass.simpleName)
            }
        }
    }

    private companion object {
        val log = LoggerFactory.getLogger(CatalogProjectionScheduler::class.java)
    }
}
