import { useState } from 'react'
import { Tabs, useRouter } from 'expo-router'
import { SavedProgramsScreen } from '../../src/screens/SavedProgramsScreen'
import { useAuth } from '../../src/auth/session'
import { useLoginFlow } from '../../src/auth/loginFlow'

export default function SavedRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { status } = useAuth()
  const [count, setCount] = useState(0)
  return <><Tabs.Screen options={{ headerTitle: status === 'signedIn' ? `관심 공고함 ${count}건` : '관심 공고함' }} />
    <SavedProgramsScreen onCountChange={setCount} onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })}
      onLogin={(mode) => requestLogin({ mode, direct: true })} /></>
}
