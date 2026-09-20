import { useRouter } from 'expo-router'
import { ChatScreen } from '../../src/screens/ChatScreen'
import { useAuth } from '../../src/auth/session'

export default function ChatRoute() {
  const router = useRouter()
  const { session } = useAuth()
  return <ChatScreen key={session?.account.email ?? 'guest'} onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} onLogin={() => router.push('/(tabs)/account')} />
}
