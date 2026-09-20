package ai.govbiz.core._common.test

import ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.*
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.`when`

/** Contract stub only; never used as evidence of native editing quality. */
fun stubDocumentMapping(client: ApplicationDocumentMcpClient, singleTarget: String? = null) {
    `when`(client.configuration()).thenReturn(AiDocumentConfigurationPayload("application-document-mcp-v1", "b".repeat(64)))
    val fallback = AiDocumentMappingRequest(sourceBase64 = "", sourceSha256 = "", format = "hwpx", scope = "stub", fields = emptyList())
    `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: fallback)).thenAnswer { invocation ->
        val request = invocation.getArgument<AiDocumentMappingRequest>(0)
        val bindings = request.fields.mapIndexed { index, field -> ApplicationDocumentPlacement(field.id, singleTarget ?: request.hwpTargets.filter { it.editable }.getOrNull(index)?.id ?: "mock-target-$index") }
        AiDocumentMappingPayload("application-document-mcp-v1", "b".repeat(64), request.sourceSha256, "native-map-v2", "contract-stub",
            bindings, bindings.map { it.targetId }, mapOf("sourceSha256" to request.sourceSha256,
                "targets" to bindings.map { mapOf("targetId" to it.targetId, "editable" to true, "currentText" to "") }))
    }
}
