package ai.govbiz.core.supportprogram.client.catalog.exception

/** 원격 응답 본문·헤더·비밀값을 예외나 로그에 복사하지 않습니다. */
class CatalogServiceCallException(val failure: Failure) : RuntimeException("Catalog snapshot request failed: $failure") {
    enum class Failure { AUTHENTICATION, UNAVAILABLE, INVALID_RESPONSE }
}
