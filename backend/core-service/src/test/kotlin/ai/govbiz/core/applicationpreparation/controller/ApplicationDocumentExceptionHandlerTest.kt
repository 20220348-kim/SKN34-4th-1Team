package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus

class ApplicationDocumentExceptionHandlerTest {
    private val handler = ApplicationDocumentExceptionHandler()

    @Test
    fun disabledGenerationReturnsServiceUnavailableWithItsPublicCode() {
        val response = handler.handle(ApplicationDocumentException("APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE",
            "문서 생성 작업 처리가 비활성화되어 있습니다."))
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.statusCode)
        assertEquals(503, response.body?.status)
        assertEquals("APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE", response.body?.properties?.get("code"))
        assertEquals("no-store", response.headers.cacheControl)
    }

    @Test
    fun documentValidationFailuresRetainUnprocessableContent() {
        val response = handler.handle(ApplicationDocumentException("APPLICATION_DOCUMENT_NO_WRITABLE_INPUT", "기입할 답변이 없습니다."))
        assertEquals(HttpStatus.UNPROCESSABLE_CONTENT, response.statusCode)
        assertEquals("APPLICATION_DOCUMENT_NO_WRITABLE_INPUT", response.body?.properties?.get("code"))
    }
}
