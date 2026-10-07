package ai.govbiz.core.applicationpreparation.service.exception

class ApplicationDocumentDownloadLinkException : RuntimeException("다운로드 링크가 만료되었거나 유효하지 않습니다. 앱에서 초안 다운로드를 다시 눌러 주세요.")
