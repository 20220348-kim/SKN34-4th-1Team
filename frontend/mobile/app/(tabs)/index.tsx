import { useRouter } from 'expo-router'
import { CatalogScreen } from '../../src/screens/CatalogScreen'

export default function CatalogRoute() {
  const router = useRouter()
  return <CatalogScreen onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} />
}
