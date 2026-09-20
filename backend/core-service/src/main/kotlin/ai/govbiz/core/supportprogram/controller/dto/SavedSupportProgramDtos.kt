package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.controller.validation.CodePointMax
import ai.govbiz.core.supportprogram.domain.SavedSupportProgram
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

/** 관심 공고함에 담을 공고입니다. 상세 조회와 같은 제공처 코드·원본 ID 규칙을 씁니다. */
data class SaveSupportProgramRequest(
    @field:NotBlank
    @field:Size(max = 64)
    @field:Pattern(regexp = "[A-Z][A-Z0-9_]{0,63}")
    val sourceCode: String,
    @field:NotBlank
    @field:CodePointMax(max = 255)
    @field:Pattern(regexp = "(?Us)^(?!\\s)(?!.*\\s$)(?!.*\\p{C}).+$")
    val sourceProgramId: String,
)

/** 담은 공고 하나입니다. [savedAt]은 서울 기준 ISO 로컬 시각이고 [program]은 조회 시점의 현재 공고입니다. */
data class SavedSupportProgramResponse(
    val savedAt: String,
    val program: SupportProgramResponse,
) {
    companion object {
        fun from(saved: SavedSupportProgram): SavedSupportProgramResponse =
            SavedSupportProgramResponse(
                savedAt = saved.savedAt.toString(),
                program = SupportProgramResponse.from(saved.program),
            )
    }
}

/** 최근에 담은 순서의 관심 공고 목록입니다. */
data class SavedSupportProgramListResponse(
    val programs: List<SavedSupportProgramResponse>,
)

/** 공고 상세 화면이 담기 버튼의 상태를 그릴 때 씁니다. */
data class SavedSupportProgramStatusResponse(
    val saved: Boolean,
)
