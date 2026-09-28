import { useState } from 'react'

import type { LoginPrompt } from './LoginPromptDialog'

/** 화면 하나에 로그인 안내 다이얼로그 상태를 둡니다. 어떤 기능을 눌렀는지에 따라 문장과 돌아올 곳만 바꿔 엽니다. */
export function useLoginPrompt() {
  const [prompt, setPrompt] = useState<LoginPrompt | null>(null)
  return {
    prompt,
    open: (next: LoginPrompt) => setPrompt(next),
    close: () => setPrompt(null),
  }
}
