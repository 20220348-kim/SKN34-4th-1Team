package ai.govbiz.core.applicationpreparation.domain

/**
 * 공식 첨부 파일명으로 "신청자가 채워 제출하는 문서"인지 판정합니다. AI 양식 추출 전에 위원용·공고문 같은
 * 문서를 걸러 유료 호출과 오인을 줄이기 위한 규칙이며, 판정이 불확실하면 UNKNOWN으로 두어 AI에 맡깁니다.
 */
enum class ApplicationAttachmentRole {
    APPLICANT, NON_APPLICANT, UNKNOWN;

    companion object {
        private val applicantKeywords = listOf(
            "신청서", "신청양식", "지원서", "참가신청", "참여신청", "계획서", "제안서",
            "기업용", "참여기업", "신청기업", "제출서식", "제출양식", "작성양식", "서약서", "동의서", "자기소개서", "이력서",
        )
        private val nonApplicantKeywords = listOf(
            "위원용", "심사위원", "평가위원", "심사표", "평가표", "심사기준", "평가기준", "채점표", "결과보고서", "결과보고",
            "승낙서", "공고문", "공고", "안내문", "안내서", "안내자료", "설명회", "홍보", "포스터", "리플릿", "브로슈어",
            "보도자료", "매뉴얼", "메뉴얼", "faq", "질의응답", "선정결과", "합격자", "발표자료", "예산", "정산",
        )

        /** 파일명(확장자 포함)만 보고 판정합니다. 신청자 키워드가 하나라도 있으면 위원용 키워드가 함께 있어도 APPLICANT입니다. */
        fun classify(fileName: String): ApplicationAttachmentRole {
            val name = normalize(fileName)
            if (applicantKeywords.any { it in name }) return APPLICANT
            if (nonApplicantKeywords.any { it in name }) return NON_APPLICANT
            return UNKNOWN
        }

        private fun normalize(fileName: String): String = fileName
            .substringBeforeLast('.', fileName)
            .lowercase()
            .replace(Regex("[\\s_\\-+()\\[\\]【】「」『』\\.]"), "")
    }
}
