package ai.govbiz.core.account.helper

/** 로그인·가입·저장이 같은 표기를 쓰도록 이메일을 앞뒤 공백 제거·소문자로 정규화합니다. */
fun normalizeEmail(email: String): String = email.trim().lowercase()
