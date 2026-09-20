import { useRouter } from 'expo-router'
import { SavedProgramsScreen } from '../../src/screens/SavedProgramsScreen'

export default function SavedRoute() {
  const router = useRouter()
  return <SavedProgramsScreen onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} />
}
