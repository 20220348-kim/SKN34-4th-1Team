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

        /** 서식의 구조 신호: 별지·서식 번호, 서명·날인 칸, 빈 날짜 줄(`년  월  일`, `2026.  .  .`), 영문 서식의 서명·신청 칸입니다. */
        private val structureSignals = listOf(
            Regex("\\[\\s*서\\s*식|<\\s*서\\s*식|서\\s*식\\s*(제\\s*)?\\d|별\\s*지\\s*(제\\s*)?\\d|별\\s*첨\\s*\\d"),
            // "(서명 또는 인)"은 서명 칸이지만 "서명 또는 인감(이미지)을 제출" 같은 안내 문장은 아닙니다.
            Regex("\\(\\s*인\\s*\\)|\\(\\s*서\\s*명\\s*\\)|\\(\\s*직\\s*인\\s*\\)|서\\s*명\\s*또는\\s*(?:날\\s*)?인(?![가-힣])"),
            Regex("년\\s{2,}월\\s{2,}일|(?:19|20)\\d{0,2}\\s*\\.\\s{2,}\\.\\s{2,}\\.?"),
            Regex("(?i)application\\s+form|\\bsignature\\b|\\(\\s*seal\\s*\\)|name\\s+of\\s+(the\\s+)?applicant"),
        )
        /** 서식 표의 라벨 칸입니다. 표 칸은 한 줄씩 추출되므로 라벨만 있는 줄이 여럿이면 기입할 표로 봅니다. */
        private val formTableLabels = setOf(
            "업체명", "기업명", "회사명", "상호", "대표자", "대표자명", "대표자성명", "성명", "주소", "소재지", "사업자등록번호",
            "법인등록번호", "연락처", "전화", "전화번호", "핸드폰", "휴대폰", "휴대전화", "이메일", "e-mail", "email", "설립일",
            "설립일자", "설립연월일", "담당자", "직위", "업종", "매출액", "종업원수", "홈페이지", "팩스", "생년월일",
        )
        /** 문서 이름 신호: 신청서·계획서·동의서 같은 서식명입니다. 공고문 본문에서는 "신청서를 제출" 같은 언급으로도 나옵니다. */
        private val titleSignals = listOf(
            Regex("신\\s*청\\s*서|지\\s*원\\s*서|계\\s*획\\s*서|제\\s*안\\s*서|참\\s*가\\s*신\\s*청"),
            Regex("동\\s*의\\s*서|서\\s*약\\s*서|확\\s*약\\s*서"),
        )
        /**
         * 파일명이 서식을 가리키는 표현입니다. "(양식)" 같은 표기, 조사서·명세서, 신청내역, 영문 서식명을 포함합니다.
         * "확인서비스"·"양식장"처럼 낱말 일부만 같은 이름과 "신청안내"·"사업신청방법" 같은 안내문은 제외합니다.
         */
        private val formNameSignals = listOf(
            Regex("양식(?!장|업)"), Regex("서식"), Regex("(?:조사서|명세서|확인서)(?![가-힣])"), Regex("신청내역"),
            Regex("application"), Regex("template"),
        )
        private val checkMark = "(?:[□☐■]|\\[\\s*]|［\\s*］|\\(\\s*\\))"
        private val consentCheck = Regex("동\\s*의\\s*(?:함|합니다|하지\\s*않음?|여부)?\\s*[:：]?\\s*$checkMark|$checkMark\\s*(?:미\\s*)?동\\s*의")

        /**
         * 공고문처럼 보이는 첨부라도 본문에 서식 신호가 있으면 AI 양식 분석을 보냅니다. 신호가 하나도 없으면 작성할 서식이 없는
         * 안내 문서로 보고 유료 호출을 하지 않습니다. [structureOnly]이면 서식명 언급은 세지 않습니다.
         */
        fun hasFormSignal(text: String, structureOnly: Boolean = false): Boolean =
            structureSignals.any { it.containsMatchIn(text) } || hasFormTable(text) ||
                !structureOnly && titleSignals.any { it.containsMatchIn(text) }

        /** 기업명·대표자·사업자등록번호 같은 라벨만 있는 줄이 서로 다르게 5개 이상이면 기입할 표가 있는 문서입니다. */
        private fun hasFormTable(text: String): Boolean =
            text.lineSequence().map { it.replace(Regex("\\s+"), "").lowercase() }.filter { it in formTableLabels }.distinct().take(5).count() >= 5

        /** 파일명만으로 서식임을 알 수 있는지입니다. 신청자 키워드보다 넓어서 역할 판정이 아닌 분석 대상 판정에만 씁니다. */
        fun hasFormName(fileName: String): Boolean = normalize(fileName).let { name -> formNameSignals.any { it.containsMatchIn(name) } }

        /** 신청자가 원본에서 직접 체크해야 하는 인쇄된 동의 항목("동의함 □", "[ ] 동의")이 있는지입니다. 이런 항목은 문항으로 만들지 않습니다. */
        fun hasConsentCheck(text: String): Boolean = consentCheck.containsMatchIn(text)

        private fun normalize(fileName: String): String = fileName
            .substringBeforeLast('.', fileName)
            .lowercase()
            .replace(Regex("[\\s_\\-+()\\[\\]【】「」『』\\.]"), "")
    }
}
