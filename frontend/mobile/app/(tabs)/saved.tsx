import { useState } from 'react'
import { Tabs, useRouter } from 'expo-router'
import { SavedProgramsScreen } from '../../src/screens/SavedProgramsScreen'

export default function SavedRoute() {
  const router = useRouter()
  const [count, setCount] = useState(0)
  return <><Tabs.Screen options={{ headerTitle: `관심 공고함 ${count}건` }} />
    <SavedProgramsScreen onCountChange={setCount} onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} /></>
}
