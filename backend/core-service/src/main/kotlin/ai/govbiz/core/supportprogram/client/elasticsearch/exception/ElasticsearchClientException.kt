package ai.govbiz.core.supportprogram.client.elasticsearch.exception

/** 원본 응답·주소·인증정보를 공개 오류로 노출하지 않는 키워드 색인 장애입니다. */
class ElasticsearchClientException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
