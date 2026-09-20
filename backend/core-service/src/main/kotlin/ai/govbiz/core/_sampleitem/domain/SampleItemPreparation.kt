package ai.govbiz.core._sampleitem.domain

/** 입력 검증을 통과한 예제 요청의 준비 결과입니다. */
data class SampleItemPreparation(
    val phase: SampleItemPhase,
    val item: SampleItem,
    val processingStatus: ProcessingStatus,
)
