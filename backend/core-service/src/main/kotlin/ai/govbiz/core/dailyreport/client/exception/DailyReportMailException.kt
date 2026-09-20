package ai.govbiz.core.dailyreport.client.exception

/** SMTP의 접속 정보·서버 응답·수신 주소를 공개 오류에 포함하지 않습니다. */
class DailyReportMailException(cause: Throwable? = null) : RuntimeException("리포트 이메일 발송을 확인할 수 없습니다.", cause)
