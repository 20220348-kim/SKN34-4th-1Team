package ai.govbiz.core.supportprogram.service.catalog.exception

/** 제공처와 전용 필터를 함께 적용할 수 없는 요청입니다. 원본 입력은 보관하지 않습니다. */
class SupportProgramCatalogFilterException : RuntimeException("Invalid support program source filter combination")
