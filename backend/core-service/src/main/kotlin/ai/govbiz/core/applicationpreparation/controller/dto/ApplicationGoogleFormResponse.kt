package ai.govbiz.core.applicationpreparation.controller.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleForm

/** 미리 채운 구글 설문 링크를 만드는 데 필요한 응답 주소와 문항입니다. `entryId`가 null인 문항은 구글 설문에서 직접 답합니다. */
data class ApplicationGoogleFormResponse(
    val responderUrl: String,
    val title: String,
    val questions: List<ApplicationGoogleFormQuestionResponse>,
) {
    companion object {
        fun from(form: ApplicationGoogleForm) = ApplicationGoogleFormResponse(form.responderUrl, form.title, form.questions.map {
            ApplicationGoogleFormQuestionResponse(it.entryId, it.label, it.description, it.required, it.kind.name, it.options, it.allowsOther)
        })
    }
}

data class ApplicationGoogleFormQuestionResponse(
    val entryId: String?, val label: String, val description: String, val required: Boolean,
    val kind: String, val options: List<String>, val allowsOther: Boolean,
)
