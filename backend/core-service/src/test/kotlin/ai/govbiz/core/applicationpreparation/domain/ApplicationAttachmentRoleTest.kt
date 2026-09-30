package ai.govbiz.core.applicationpreparation.domain

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource

class ApplicationAttachmentRoleTest {
    @ParameterizedTest
    @CsvSource(
        "(서식1)+2026년+스마트공장+사전사후+컨설팅사업+신청서(기업용).hwp, APPLICANT",
        "(서식2)+2026년+스마트공장+사전사후+컨설팅사업+결과보고서(위원용).hwp, NON_APPLICANT",
        "(서식3)+승낙서(위원용).hwp, NON_APPLICANT",
        "(붙임)+2026년+스마트공장+사전사후+컨설팅사업+공고문_.pdf, NON_APPLICANT",
        "2026년 제4회 화성특례시 중소기업대상 제출서식 및 평가표.hwpx, APPLICANT",
        "혁신바우처 사업계획서.hwpx, APPLICANT",
        "붙임2. 심사 평가표.hwpx, NON_APPLICANT",
        "붙임1.hwpx, UNKNOWN",
        "2026 수출바우처 참여기업 모집 안내.pdf, APPLICANT",
    )
    fun classifiesByFileName(fileName: String, expected: ApplicationAttachmentRole) {
        assertEquals(expected, ApplicationAttachmentRole.classify(fileName))
    }
}
