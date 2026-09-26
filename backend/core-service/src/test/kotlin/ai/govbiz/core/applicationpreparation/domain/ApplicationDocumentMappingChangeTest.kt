package ai.govbiz.core.applicationpreparation.domain

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ApplicationDocumentMappingChangeTest {
    private fun snapshot(bindings: List<ApplicationDocumentPlacement> = listOf(ApplicationDocumentPlacement("company:name", "field-a")),
                         scope: List<String> = listOf("field-a"), kind: String = "PDF_INPUT",
                         page: Int = 0, x: Double = .2, semantic: String = "first") =
        ApplicationDocumentMapSnapshot("application-document-mcp-v1", "a".repeat(64), "b".repeat(64),
            "map", "engine", bindings, scope, mapOf("targets" to listOf(
                mapOf("targetId" to "field-a", "kind" to kind,
                    "nativeLocator" to mapOf("page" to page,
                        "box" to mapOf("x" to x, "y" to .2, "width" to .3, "height" to .04)),
                    "analysis" to mapOf("semanticSection" to semantic)),
                mapOf("targetId" to "field-b", "kind" to "PDF_INPUT",
                    "nativeLocator" to mapOf("page" to 1,
                        "box" to mapOf("x" to .5, "y" to .2, "width" to .3, "height" to .04))))))

    @Test fun unchangedBindingAndSemanticMetadataDoNotRequireMigration() {
        assertTrue(mappingChanges(snapshot(), snapshot(semantic = "renamed heading")).isEmpty())
    }

    @Test fun targetAddedRemovedAndMultipleTargetsChangedAreExplicit() {
        val old = snapshot()
        assertEquals("TARGET_ADDED", mappingChanges(snapshot(bindings = emptyList(), scope = emptyList()), old)
            .first { it.factId == "company:name" }.type)
        assertEquals("TARGET_REMOVED", mappingChanges(old, snapshot(bindings = emptyList(), scope = emptyList()))
            .first { it.factId == "company:name" }.type)
        assertEquals("TARGET_CHANGED", mappingChanges(old, snapshot(
            bindings = listOf(ApplicationDocumentPlacement("company:name", "field-b")), scope = listOf("field-b")))
            .first { it.factId == "company:name" }.type)
        assertEquals("TARGET_CHANGED", mappingChanges(old, snapshot(bindings = listOf(
            ApplicationDocumentPlacement("company:name", "field-a"),
            ApplicationDocumentPlacement("company:name", "field-b")), scope = listOf("field-a", "field-b")))
            .first { it.factId == "company:name" }.type)
    }

    @Test fun pdfBoxPageKindAndScopeChangesRequireMigration() {
        val old = snapshot()
        assertEquals("BOX_CHANGED", mappingChanges(old, snapshot(x = .21)).first().type)
        assertEquals("BOX_CHANGED", mappingChanges(old, snapshot(page = 1)).first().type)
        assertEquals("KIND_CHANGED", mappingChanges(old, snapshot(kind = "PDF_FIELD")).first().type)
        assertEquals("SCOPE_CHANGED", mappingChanges(old, snapshot(scope = listOf("field-a", "field-b"))).last().type)
        assertEquals("BOX_CHANGED", mappingChanges(snapshot(bindings = listOf(
            ApplicationDocumentPlacement("company:name", "field-a", ApplicationDocumentBox(.2f, .2f, .3f, .04f)))),
            snapshot(bindings = listOf(ApplicationDocumentPlacement("company:name", "field-a",
                ApplicationDocumentBox(.21f, .2f, .3f, .04f))))).first().type)
    }
}
