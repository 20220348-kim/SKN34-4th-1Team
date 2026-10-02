import { useLoginFlow } from '../../../src/auth/loginFlow'
import { CompanyScreen } from '../../../src/screens/CompanyScreen'

export default function CompanyRoute() {
  const requestLogin = useLoginFlow()
  return <CompanyScreen onLogin={() => requestLogin()} />
}
