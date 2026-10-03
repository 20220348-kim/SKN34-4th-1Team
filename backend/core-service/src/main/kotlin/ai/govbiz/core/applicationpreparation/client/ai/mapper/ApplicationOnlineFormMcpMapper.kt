package ai.govbiz.core.applicationpreparation.client.ai.mapper

import ai.govbiz.core.applicationpreparation.client.ai.dto.AiOnlineFormInspectionPayload
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleForm
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleFormQuestion
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleFormQuestionKind
import ai.govbiz.core.applicationpreparation.domain.ApplicationOnlineFormSource
import ai.govbiz.core.applicationpreparation.domain.ApplicationOnlineFormSourceControl
import ai.govbiz.core.applicationpreparation.domain.ApplicationOnlineFormSourceKind
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.springframework.stereotype.Component

@Component
class ApplicationOnlineFormMcpMapper {
    /** Client가 계약을 검증한 payload만 받는다. */
    fun toSource(payload: AiOnlineFormInspectionPayload): ApplicationOnlineFormSource {
        val digest = MessageDigest.getInstance("SHA-256").digest(payload.finalUrl.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return ApplicationOnlineFormSource(1, "gpub-form-v1:${digest.take(24)}", payload.formTitle,
            payload.questions.map {
                ApplicationOnlineFormSourceControl(it.controlId, it.label, it.required,
                    ApplicationOnlineFormSourceKind.valueOf(it.kind), it.options)
            })
    }

    /** 미리 채우기에는 지원하지 않는 문항도 남겨 사용자가 구글 설문에서 직접 답할 문항을 알게 한다. */
    fun toGoogleForm(payload: AiOnlineFormInspectionPayload): ApplicationGoogleForm =
        ApplicationGoogleForm(payload.finalUrl, payload.formTitle, payload.questions.map {
            ApplicationGoogleFormQuestion(
                entryId = it.entryId, label = it.label, description = it.description, required = it.required,
                kind = if (it.supported) ApplicationGoogleFormQuestionKind.valueOf(it.kind) else ApplicationGoogleFormQuestionKind.UNSUPPORTED,
                options = it.options, allowsOther = it.allowsOther,
            )
        })
}
