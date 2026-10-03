package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationOnlineFormMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleForm
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRouteType
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import org.springframework.stereotype.Service

/** 구글 설문으로 신청하는 공고의 공개 설문을 읽어 미리 채우기에 쓸 문항을 돌려줍니다. 답변은 받지도 저장하지도 않습니다. */
@Service
class ApplicationGoogleFormService(
    private val supportPrograms: SupportProgramRepository,
    private val onlineFormMcp: ApplicationOnlineFormMcpClient,
) {
    /** 설문 주소는 요청에서 받지 않고 공고의 공식 신청 경로에서만 가져와, 임의 주소를 대신 읽는 통로가 되지 않게 한다. */
    fun read(account: Account, sourceCode: String, sourceProgramId: String): ApplicationGoogleForm {
        require(account.id > 0)
        val route = supportPrograms.findPresentBySourceAndProgramId(sourceCode, sourceProgramId)?.program?.applicationRoute
            ?: throw SupportProgramNotFoundException()
        val url = route.url?.takeIf { route.type == SupportProgramApplicationRouteType.GOOGLE_FORMS }
            ?: throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_UNSUPPORTED")
        return onlineFormMcp.readGoogleForm(url)
    }
}
