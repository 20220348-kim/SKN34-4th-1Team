import { Stack, useRouter } from 'expo-router'
import { Pressable } from 'react-native'
import { catalogSourceCodes } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { AppIcon } from './AppIcon'
import { colors } from '../ui'

/** 공고 상세에서 시작한 준비 화면의 복귀 대상만 허용합니다. 외부 URL을 받지 않습니다. */
export function programReturnParams(params: { from?: unknown; sourceCode?: unknown; sourceProgramId?: unknown }): Record<string, string> {
  if (params.from !== 'program' || typeof params.sourceCode !== 'string'
    || !catalogSourceCodes.some(code => code !== '' && code === params.sourceCode)
    || typeof params.sourceProgramId !== 'string' || !params.sourceProgramId || params.sourceProgramId.length > 500 || /\p{C}/u.test(params.sourceProgramId)) return {}
  return { from: 'program', sourceCode: params.sourceCode, sourceProgramId: params.sourceProgramId }
}

export function ProgramReturnHeader({ params }: { params: { from?: unknown; sourceCode?: unknown; sourceProgramId?: unknown } }) {
  const router = useRouter()
  const target = programReturnParams(params)
  return <Stack.Screen options={{ headerLeft: target.from ? () => <Pressable accessibilityRole="button"
    accessibilityLabel="공고 상세로 돌아가기" onPress={() => router.dismissTo({ pathname: '/program', params: {
      sourceCode: target.sourceCode, sourceProgramId: target.sourceProgramId,
    } })} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><AppIcon name="back" color={colors.text} size={23} /></Pressable> : undefined }} />
}
