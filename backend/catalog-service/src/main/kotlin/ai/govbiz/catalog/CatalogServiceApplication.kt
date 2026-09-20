package ai.govbiz.catalog

import ai.govbiz.catalog.supportprogram.service.sync.config.SupportProgramCatalogSyncOnceConfig
import org.springframework.boot.SpringApplication
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import kotlin.system.exitProcess

@SpringBootApplication
class CatalogServiceApplication

fun main(args: Array<String>) {
    val context = runApplication<CatalogServiceApplication>(*args) {
        addInitializers(SupportProgramCatalogSyncOnceConfig::isolate)
    }
    if (context.environment.matchesProfiles(SupportProgramCatalogSyncOnceConfig.PROFILE)) {
        exitProcess(SpringApplication.exit(context))
    }
}
