// 관리자 계정 화면이 함께 쓰는 표시 형식입니다. 서버 시각은 서울 기준 ISO 로컬 시각 문자열(초 아래 자리는 있을 때만)이라
// 앞부분만 잘라서 씁니다.

/** `2026-09-10` */
export function formatAdminDate(dateTime: string): string {
  return dateTime.slice(0, 10)
}

/** `2026-09-10 14:05` */
export function formatAdminDateTime(dateTime: string): string {
  return dateTime.slice(0, 16).replace('T', ' ')
}

/** `1248100998` → `124-81-00998` */
export function formatBusinessNumber(businessNumber: string): string {
  return /^\d{10}$/.test(businessNumber)
    ? `${businessNumber.slice(0, 3)}-${businessNumber.slice(3, 5)}-${businessNumber.slice(5)}`
    : businessNumber
}
