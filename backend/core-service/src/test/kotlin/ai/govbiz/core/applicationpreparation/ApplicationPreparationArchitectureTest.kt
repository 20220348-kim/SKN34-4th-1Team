package ai.govbiz.core.applicationpreparation

import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ApplicationPreparationArchitectureTest {
    @Test
    fun innerLayersDoNotReferenceForbiddenPackages() {
        val root = Path.of("src/main/kotlin/ai/govbiz/core/applicationpreparation")
        val forbidden = mapOf(
            "service" to listOf("controller"),
            "repository" to listOf("service", "controller"),
            "client" to listOf("service", "controller", "repository"),
            "domain" to listOf("controller", "service", "repository", "client"),
        )
        // DiscoveryJobRepository is outside this scope: 3rd project commit 18fbea9 (ilil1).
        // Allow only those exact exception references in their existing files, never an entire layer.
        val existing = mapOf(
            "ApplicationFormDiscoveryJobRepository.kt" to listOf(
                "ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException"),
        )
        val violations = mutableListOf<String>()
        forbidden.forEach { (layer, targets) ->
            Files.walk(root.resolve(layer)).use { paths ->
                paths.filter { it.toString().endsWith(".kt") }.forEach { path ->
                    var code = Files.readString(path).replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
                        .replace(Regex("//[^\n]*"), "")
                    if (layer == "repository") {
                        existing[path.fileName.toString()].orEmpty().forEach { known ->
                            code = code.replace(known, "")
                        }
                    }
                    targets.forEach { target ->
                        val dependency = "ai.govbiz.core.applicationpreparation.$target."
                        if (dependency in code) violations += "$path -> $target"
                    }
                }
            }
        }
        assertTrue(violations.isEmpty(), violations.joinToString("\n"))
    }
}
