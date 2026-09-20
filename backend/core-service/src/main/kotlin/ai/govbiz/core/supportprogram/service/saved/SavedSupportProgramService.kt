package ai.govbiz.core.supportprogram.service.saved

import ai.govbiz.core.supportprogram.domain.SavedSupportProgram
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import org.springframework.stereotype.Service

/**
 * 관심 공고함입니다. 회원이 공고를 담고 빼고 목록을 읽습니다. 담기는 같은 공고를 다시 담아도 한 번만 남고,
 * 빼기는 담기지 않은 공고를 빼도 오류가 아닙니다. 노출되지 않는 공고는 담을 수 없습니다.
 */
@Service
class SavedSupportProgramService(
    private val savedSupportProgramRepository: SavedSupportProgramRepository,
    private val supportProgramRepository: SupportProgramRepository,
) {

    fun list(accountId: Long): List<SavedSupportProgram> =
        savedSupportProgramRepository.findByAccountId(accountId)

    fun isSaved(accountId: Long, sourceCode: String, sourceProgramId: String): Boolean =
        savedSupportProgramRepository.findByIdentity(accountId, sourceCode, sourceProgramId) != null

    /** 현재 노출 중인 공고만 담고, 담긴 결과를 현재 공고 내용과 함께 돌려줍니다. 없거나 숨겨진 공고는 404입니다. */
    fun save(accountId: Long, sourceCode: String, sourceProgramId: String): SavedSupportProgram {
        supportProgramRepository.findPresentBySourceAndProgramId(sourceCode, sourceProgramId)
            ?: throw SupportProgramNotFoundException()
        savedSupportProgramRepository.saveIfPresent(accountId, sourceCode, sourceProgramId)
        return savedSupportProgramRepository.findByIdentity(accountId, sourceCode, sourceProgramId)
            ?: throw SupportProgramNotFoundException()
    }

    fun remove(accountId: Long, sourceCode: String, sourceProgramId: String) {
        savedSupportProgramRepository.delete(accountId, sourceCode, sourceProgramId)
    }
}
