package ai.govbiz.core.assistant.service

import ai.govbiz.core.assistant.domain.AssistantAccountTopic
import ai.govbiz.core.assistant.domain.AssistantIntent
import java.time.LocalDate

/** Core가 직접 만드는 도우미 답 문구입니다. 상태 숫자는 Core 자료에서 오고, 모델 문장은 섞지 않습니다. */
object AssistantAnswerTexts {
    const val OPEN_SEARCH = "검색 화면 열기"
    const val OPEN_SEARCH_FOR_QUERY = "검색 화면에서 찾기"
    const val OPEN_SAVED = "관심 공고함 열기"
    const val OPEN_PROPOSALS = "제안함 열기"
    const val OPEN_PROFILE = "프로필 열기"
    const val OPEN_PARTNERS = "파트너 모집 열기"

    const val PROGRAM_QUESTION_ON_DETAIL =
        "공고 원문에서 확인해야 하는 내용입니다. 이 공고의 원문 질문에서 물어보면 공식 문서를 근거로 답합니다."
    const val PROGRAM_QUESTION_NO_PROGRAM =
        "공고마다 다른 내용이라 공고를 먼저 골라야 합니다. 검색해서 공고를 연 뒤 상세 화면의 원문 질문에서 물어봐 주세요."

    const val SAVED_NONE = "아직 담아 둔 관심 공고가 없습니다. 검색 결과에서 공고를 담아 두면 마감이 가까운 순서로 알려 드립니다."
    const val PROPOSALS_NEED_COMPANY =
        "받은 제안은 기업을 등록한 뒤 모집글을 올리면 들어옵니다. 프로필에서 사업자등록번호로 기업을 등록해 주세요."
    const val PROPOSALS_NONE = "지금 응답을 기다리는 받은 제안이 없습니다. 수락·거절은 제안함에서 합니다."
    const val COMPANY_NONE = "아직 등록한 기업이 없습니다. 프로필에서 사업자등록번호를 넣으면 국세청 조회로 확인해 등록합니다."

    data class Deadline(val title: String, val date: LocalDate, val daysLeft: Int)

    fun search(query: String): String = "'$query' 조건으로 지원사업을 찾아볼까요? 검색 화면에서 조건을 확인한 뒤 검색합니다."

    fun loginRequired(topic: AssistantAccountTopic): String = when (topic) {
        AssistantAccountTopic.SAVED_PROGRAMS -> "관심 공고함은 로그인한 뒤 볼 수 있습니다. 로그인하면 담아 둔 공고의 마감을 바로 알려 드립니다."
        AssistantAccountTopic.RECEIVED_PROPOSALS -> "받은 제안함은 로그인한 뒤 볼 수 있습니다. 로그인하면 응답을 기다리는 제안 수를 바로 알려 드립니다."
        AssistantAccountTopic.COMPANY_PROFILE -> "기업 정보는 로그인한 뒤 프로필에서 볼 수 있습니다."
    }

    /** 도구 의도(모집글 매칭·관심 공고 묶음 질문)의 비로그인 안내입니다. 도구는 로그인 회원의 자료만 읽습니다. */
    fun loginRequired(intent: AssistantIntent): String = when (intent) {
        AssistantIntent.PARTNER_MATCH -> "맞는 파트너 모집글은 로그인한 뒤 기업 프로필을 기준으로 찾아 드립니다. 로그인하고 다시 물어봐 주세요."
        AssistantIntent.SAVED_PROGRAMS_QUESTION -> "관심 공고 내용은 로그인한 뒤 관심 공고함에 담아 둔 공고를 기준으로 답해 드립니다."
        else -> loginRequired(AssistantAccountTopic.SAVED_PROGRAMS)
    }

    /** 에이전트가 답을 만들지 못했을 때입니다. 화면을 열어 직접 볼 수 있게 안내합니다. */
    fun agentNoAnswer(intent: AssistantIntent): String = when (intent) {
        AssistantIntent.PARTNER_MATCH -> "지금은 맞는 모집글을 고르지 못했습니다. 파트너 모집 화면에서 지역·역할로 직접 찾아보실 수 있습니다."
        else -> "지금은 관심 공고 내용을 정리하지 못했습니다. 관심 공고함에서 각 공고의 상세를 확인해 주세요."
    }

    fun savedAllClosed(total: Int): String = "관심 공고 ${total}건은 모두 접수가 끝났습니다. 검색에서 새 공고를 담아 두세요."

    fun savedSummary(total: Int, soon: Int, nearest: Deadline?): String {
        val head = "관심 공고 ${total}건 중 7일 안에 마감인 공고가 ${soon}건입니다."
        if (nearest == null) return "$head 담아 둔 공고는 모두 마감일이 정해지지 않았습니다."
        val when_ = if (nearest.daysLeft == 0) "오늘 마감" else "${monthDay(nearest.date)} 마감, D-${nearest.daysLeft}"
        return "$head 가장 가까운 마감은 '${nearest.title}'($when_)입니다."
    }

    fun proposalsSummary(pending: Int, earliestExpiresOn: LocalDate?): String {
        val head = "응답을 기다리는 받은 제안이 ${pending}건입니다."
        val deadline = if (earliestExpiresOn == null) "" else " 가장 빠른 응답 기한은 ${monthDay(earliestExpiresOn)}입니다."
        return "$head$deadline 수락·거절은 제안함에서 합니다."
    }

    fun companyRegistered(companyName: String): String =
        "'$companyName'이(가) 등록되어 있습니다. 기업 정보 수정과 파트너 프로필은 프로필 화면에서 합니다."

    private fun monthDay(date: LocalDate): String = "${date.monthValue}월 ${date.dayOfMonth}일"
}
