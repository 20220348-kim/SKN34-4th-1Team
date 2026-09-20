package ai.govbiz.core.supportprogram.service.evaluation.config

import java.nio.file.Path
import java.time.LocalDate
import org.springframework.boot.context.properties.ConfigurationProperties

/** 평가용 실제 공고 스냅샷의 식별자·기준 날짜·출력 위치입니다. */
@ConfigurationProperties(prefix = "app.support-program-search-fixture-export")
data class SupportProgramSearchEvaluationFixtureExportProperties(
    val name: String,
    val referenceDate: LocalDate,
    val outputPath: Path,
) {
    init {
        require(name.isNotBlank() && name == name.trim()) {
            "app.support-program-search-fixture-export.name must be a nonblank string without surrounding whitespace"
        }
        require(outputPath.toString().isNotBlank()) {
            "app.support-program-search-fixture-export.output-path must not be blank"
        }
    }
}
