package ai.govbiz.core.applicationpreparation.domain

/**
 * 공개 구글 설문의 응답 주소와 문항입니다. 화면은 사용자가 고른 답을 문항의 `entry.{번호}`로 붙여 미리 채운 설문 링크를
 * 만들고, 제출은 사용자가 구글 설문에서 직접 합니다. 답변은 담지 않습니다.
 */
data class ApplicationGoogleForm(
    val responderUrl: String,
    val title: String,
    val questions: List<ApplicationGoogleFormQuestion>,
) {
    init {
        require(RESPONDER_URL.matches(responderUrl)) { "not a Google Forms responder URL" }
        require(title.isNotBlank()) { "blank Google Form title" }
        require(questions.isNotEmpty()) { "Google Form without questions" }
        val entries = questions.mapNotNull { it.entryId }
        require(entries.distinct().size == entries.size) { "duplicate Google Form entry" }
    }

    private companion object {
        val RESPONDER_URL = Regex("https://docs\\.google\\.com/forms/(?:u/[0-9]+/)?d/(?:e/)?[A-Za-z0-9_-]+/viewform")
    }
}

/** UNSUPPORTED는 날짜·파일 업로드·표 형식처럼 링크로 채울 수 없어 구글 설문에서 직접 답하는 문항입니다. */
enum class ApplicationGoogleFormQuestionKind { SHORT_TEXT, LONG_TEXT, SINGLE_CHOICE, MULTI_CHOICE, DROPDOWN, UNSUPPORTED }

data class ApplicationGoogleFormQuestion(
    val entryId: String?,
    val label: String,
    val description: String,
    val required: Boolean,
    val kind: ApplicationGoogleFormQuestionKind,
    /** 미리 채운 링크는 선택지 문구가 정확히 같아야 체크되므로 원문 그대로 둡니다. */
    val options: List<String>,
    val allowsOther: Boolean,
) {
    init {
        require(label.isNotBlank()) { "blank Google Form question label" }
        require((kind == ApplicationGoogleFormQuestionKind.UNSUPPORTED) == (entryId == null)) { "entry must exist exactly for fillable questions" }
        require(entryId == null || Regex("[0-9]{1,20}").matches(entryId)) { "invalid Google Form entry" }
        require((kind in CHOICES) == options.isNotEmpty()) { "options must exist exactly for choice questions" }
        require(!allowsOther || kind in OTHER_CHOICES) { "only radio and checkbox questions take an other answer" }
    }

    private companion object {
        val CHOICES = setOf(ApplicationGoogleFormQuestionKind.SINGLE_CHOICE, ApplicationGoogleFormQuestionKind.MULTI_CHOICE,
            ApplicationGoogleFormQuestionKind.DROPDOWN)
        val OTHER_CHOICES = setOf(ApplicationGoogleFormQuestionKind.SINGLE_CHOICE, ApplicationGoogleFormQuestionKind.MULTI_CHOICE)
    }
}
