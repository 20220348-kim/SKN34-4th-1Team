package ai.govbiz.core.supportprogram.service.evidence.exception

/** 공식 원문을 안전하게 준비할 수 없어 근거 답변을 수행할 수 없는 경우입니다. */
class SupportProgramEvidenceUnavailableException(cause: Throwable) : RuntimeException(cause)
