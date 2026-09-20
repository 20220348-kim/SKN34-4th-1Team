package ai.govbiz.core.assistant.service

/**
 * AI Service로 보내기 전에 사용자 문장 속 개인 식별 정보를 가립니다.
 * 의도 분류에는 값이 필요 없고, 모델 요청 본문에 사업자등록번호·전화·이메일·주민등록번호를 남기지 않기 위해서입니다.
 */
object AssistantPiiMasker {
    private val EMAIL = Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
    private val RESIDENT_NUMBER = Regex("(?<![0-9])[0-9]{6}-?[1-4][0-9]{6}(?![0-9])")
    private val BUSINESS_NUMBER = Regex("(?<![0-9])[0-9]{3}-?[0-9]{2}-?[0-9]{5}(?![0-9])")
    private val PHONE_NUMBER = Regex("(?<![0-9])0[0-9]{1,2}[-. ]?[0-9]{3,4}[-. ]?[0-9]{4}(?![0-9])")

    fun mask(text: String): String =
        text
            .replace(EMAIL, "[이메일]")
            .replace(RESIDENT_NUMBER, "[주민등록번호]")
            .replace(BUSINESS_NUMBER, "[사업자등록번호]")
            .replace(PHONE_NUMBER, "[전화번호]")
}
