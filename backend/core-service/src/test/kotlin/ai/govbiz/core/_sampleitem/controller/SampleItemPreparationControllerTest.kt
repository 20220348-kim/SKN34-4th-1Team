package ai.govbiz.core._sampleitem.controller

import ai.govbiz.core._common.config.JsonDeserializationConfig
import ai.govbiz.core._sampleitem.service.SampleItemPreparationService
import java.util.stream.Stream
import org.hamcrest.Matchers.nullValue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

@WebMvcTest(SampleItemPreparationController::class)
@Import(
    SampleItemPreparationService::class,
    JsonDeserializationConfig::class,
)
class SampleItemPreparationControllerTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Test
    fun preparesAValidSampleItemWithoutStartingProcessing() {
        mockMvc.perform(
            post(PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "item": {
                        "name": "  Example item  ",
                        "category": "BASIC",
                        "note": "  Demonstrates the vertical slice.  "
                      }
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.phase").value("READY_FOR_PROCESSING"))
            .andExpect(jsonPath("$.item.name").value("Example item"))
            .andExpect(jsonPath("$.item.category").value("BASIC"))
            .andExpect(jsonPath("$.item.note").value("Demonstrates the vertical slice."))
            .andExpect(jsonPath("$.processing.status").value("NOT_STARTED"))
    }

    @Test
    fun preservesUnknownOptionalValuesAsNull() {
        mockMvc.perform(
            post(PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    { "item": { "name": "Example item", "category": null, "note": null } }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.item.category").value(nullValue()))
            .andExpect(jsonPath("$.item.note").value(nullValue()))
    }

    @Test
    fun rejectsBlankRequiredValuesWithStableProblemDetail() {
        mockMvc.perform(
            post(PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{ \"item\": { \"name\": \" \" } }"),
        )
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:request-validation-failed"))
            .andExpect(jsonPath("$.status").value(400))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[0].field").value("item.name"))
    }

    @Test
    fun rejectsAQuotedEnumBeforeItReachesTheDomainLayer() {
        mockMvc.perform(
            post(PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{ \"item\": { \"name\": \"Example\", \"category\": 1 } }"),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
    }

    @ParameterizedTest
    @MethodSource("invalidItemRequests")
    fun rejectsNullOrOversizedItemFieldsWithStableProblemDetail(
        body: String,
        expectedField: String,
    ) {
        mockMvc.perform(
            post(PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body),
        )
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:request-validation-failed"))
            .andExpect(jsonPath("$.status").value(400))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[0].field").value(expectedField))
    }

    @Test
    fun rejectsUnsupportedMediaTypeWithStableProblemDetail() {
        mockMvc.perform(
            post(PATH)
                .contentType(MediaType.TEXT_PLAIN)
                .content("not-json"),
        )
            .andExpect(status().isUnsupportedMediaType())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:unsupported-media-type"))
            .andExpect(jsonPath("$.status").value(415))
            .andExpect(jsonPath("$.title").value("Unsupported Media Type"))
            .andExpect(jsonPath("$.detail").value("This endpoint accepts application/json requests."))
            .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"))
            .andExpect(jsonPath("$.instance").value(PATH))
            .andExpect(jsonPath("$.errors").isArray())
            .andExpect(jsonPath("$.errors").isEmpty())
    }

    private companion object {
        const val PATH = "/api/v1/sample-items/prepare"

        @JvmStatic
        fun invalidItemRequests(): Stream<Arguments> =
            Stream.of(
                Arguments.of("{ \"item\": null }", "item"),
                Arguments.of(
                    "{ \"item\": { \"name\": \"${"a".repeat(101)}\" } }",
                    "item.name",
                ),
                Arguments.of(
                    """
                    {
                      "item": {
                        "name": "Example",
                        "note": "${"a".repeat(501)}"
                      }
                    }
                    """.trimIndent(),
                    "item.note",
                ),
            )
    }
}
