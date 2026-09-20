package ai.govbiz.core.account.client.bizno.dto

/**
 * Bizno가 국세청 등록 사업자로 확인한 기업 한 건입니다.
 *
 * `businessNumber`는 하이픈을 제거한 숫자 10자리, `businessStatusCode`는 국세청 사업자 상태 코드
 * (`01` 계속사업자, `02` 휴업자, `03` 폐업자)이며 `businessStatus`는 그 원문입니다. 법인번호·과세유형은 쓰지 않습니다.
 */
data class BiznoBusiness(
    val businessNumber: String,
    val companyName: String,
    val businessStatus: String,
    val businessStatusCode: String,
) {
    /** 계속사업자만 기업 등록을 허용합니다. */
    val isActive: Boolean
        get() = businessStatusCode == ACTIVE_STATUS_CODE

    companion object {
        const val ACTIVE_STATUS_CODE = "01"
    }
}
