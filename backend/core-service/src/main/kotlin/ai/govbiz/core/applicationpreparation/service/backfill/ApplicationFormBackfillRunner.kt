package ai.govbiz.core.applicationpreparation.service.backfill

import org.springframework.boot.CommandLineRunner
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.nio.file.Path
import javax.sql.DataSource
import tools.jackson.databind.ObjectMapper
import org.springframework.boot.SpringApplication
import org.springframework.context.ConfigurableApplicationContext
import kotlin.system.exitProcess

@Component
@ConditionalOnProperty(name = ["app.application-form-backfill.apply"], havingValue = "true")
class ApplicationFormBackfillRunner(
    private val importer: ApplicationFormBackfillService, private val dataSource: DataSource, private val json: ObjectMapper,
    @param:Value("\${app.application-form-backfill.input}") private val input: String,
    @param:Value("\${app.application-form-backfill.sha256}") private val hash: String,
    @param:Value("\${app.application-form-backfill.expected-jdbc-url}") private val expectedJdbcUrl: String,
    @param:Value("\${app.application-form-analysis.enabled:false}") private val workerEnabled: Boolean,
    @param:Value("\${app.application-form-backfill.exit-after-run:false}") private val exitAfterRun: Boolean,
    private val context: ConfigurableApplicationContext,
) : CommandLineRunner {
    override fun run(vararg args: String) {
        check(!workerEnabled) { "Disable the system worker during backfill" }
        require(expectedJdbcUrl.isNotBlank()) { "An explicit target database is required" }
        dataSource.connection.use { check(it.metaData.url == expectedJdbcUrl) { "Backfill target database mismatch" } }
        println(json.writeValueAsString(importer.apply(Path.of(input), hash)))
        if (exitAfterRun) exitProcess(SpringApplication.exit(context))
    }
}
