export type SampleCategory = 'BASIC' | 'EXTENDED'

/** API와 UI 사이에서 사용하는 최소 예제 도메인입니다. */
export type SampleItem = {
  name: string
  category: SampleCategory | null
  note: string | null
}
