package ai.govbiz.core.applicationpreparation.domain

import java.time.LocalDateTime

enum class ApplicationDocumentGenerationJobStatus { QUEUED, RUNNING, SUCCEEDED, FAILED, UNKNOWN }

/** 실행 중인 작업이 지금 어느 단계인지. 화면의 진행 카드에 그대로 보여 준다. */
enum class ApplicationDocumentGenerationStage { PREPARING, MAPPING, WRITING, SAVING }

data class ApplicationDocumentGenerationJob(
    val id: Long,
    val ownerAccountId: Long,
    val preparationId: Long,
    val requestKey: String,
    val expectedRevision: Long,
    val status: ApplicationDocumentGenerationJobStatus,
    val stage: ApplicationDocumentGenerationStage?,
    /** SUCCEEDED일 때 저장된 파일 ID. 파일 내용은 기존 문서 목록·다운로드 API로 읽는다. */
    val fileIds: List<Long>,
    val failureCode: String?,
    val failureMessage: String?,
    val createdAt: LocalDateTime,
    val finishedAt: LocalDateTime?,
    /** 끝난 결과를 사용자가 확인한 시각. 끝났는데 null이면 아직 확인하지 않은 결과다. */
    val seenAt: LocalDateTime? = null,
)
