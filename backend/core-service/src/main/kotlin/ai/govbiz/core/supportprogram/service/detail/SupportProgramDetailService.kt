package ai.govbiz.core.supportprogram.service.detail

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import org.springframework.stereotype.Service

/** 제공처 원본 식별자로 현재 노출 중인 지원사업 상세를 조회합니다. */
@Service
class SupportProgramDetailService(
    private val supportProgramRepository: SupportProgramRepository,
) {
    fun get(sourceCode: String, sourceProgramId: String): SupportProgram =
        supportProgramRepository
            .findPresentBySourceAndProgramId(sourceCode, sourceProgramId)
            ?.program
            ?: throw SupportProgramNotFoundException()
}
