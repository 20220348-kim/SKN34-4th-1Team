import { useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { ProgramScreen } from '../src/screens/ProgramScreen'
import { useAuth } from '../src/auth/session'
import { Notice, Page } from '../src/ui'
import { useLoginFlow } from '../src/auth/loginFlow'

export default function ProgramRoute() {
  const { sourceCode, sourceProgramId } = useLocalSearchParams<{ sourceCode: string; sourceProgramId: string }>()
  const requestLogin = useLoginFlow()
  const { session } = useAuth()
  const [resume, setResume] = useState<{ action: 'save' | 'question'; token: string; sourceCode: string; sourceProgramId: string }>()
  if (typeof sourceCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(sourceCode)
    || typeof sourceProgramId !== 'string' || !sourceProgramId || sourceProgramId.length > 500) {
    return <Page><Notice error>공고 링크가 올바르지 않습니다.</Notice></Page>
  }
  return <ProgramScreen key={`${session?.account.email ?? 'guest'}:${sourceCode}:${sourceProgramId}`} identity={{ sourceCode, sourceProgramId }}
    resumeAction={resume?.sourceCode === sourceCode && resume.sourceProgramId === sourceProgramId ? resume : undefined}
    onResumed={() => setResume(undefined)} onLogin={(action) => requestLogin({
      message: action === 'save' ? '관심 공고를 저장하면 웹과 앱에서 이어서 볼 수 있어요.' : '로그인하면 이 공고의 원문에 질문할 수 있어요.',
      onAuthenticated: (next) => { if (action) setResume({ action, token: next.accessToken, sourceCode, sourceProgramId }) },
    })} />
}
