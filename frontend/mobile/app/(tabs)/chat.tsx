import { Redirect } from 'expo-router'

export default function ChatRoute() {
  return <Redirect href={{ pathname: '/(tabs)', params: { mode: 'ai' } }} />
}
