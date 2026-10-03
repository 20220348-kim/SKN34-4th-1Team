import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Text } from 'react-native'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage } from '../api/client'
import { listReviewSavedPrograms } from '../api/combinationReviews'
import { useAuth } from '../auth/session'
import { ProgramCard, type ProgramSelectionLabels } from './ProgramCard'
import { Button, Notice, Page, colors, styles } from '../ui'

export function ReviewSavedPrograms({ token, keys, disabled, onToggle, onOpen, header, maximum = 2, labels }: {
  token: string; keys: string[]; disabled: boolean; onToggle(program: SupportProgram): void; onOpen(identity: SupportProgramIdentity): void
  header?: ReactNode
  maximum?: number; labels?: ProgramSelectionLabels
}) {
  const { invalidateSession } = useAuth()
  const [programs, setPrograms] = useState<SupportProgram[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setPrograms(null); setError(null)
    void listReviewSavedPrograms(token, controller.signal).then(result => {
      if (!controller.signal.aborted) setPrograms(result)
    }).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setError(errorMessage(cause))
    })
    return () => controller.abort()
  }, [invalidateSession, revision, token])
  return <Page>
    {header}
    {programs === null && !error && <ActivityIndicator color={colors.primary} accessibilityLabel="관심 공고 불러오는 중" />}
    {error && <><Notice error>{error}</Notice><Button label="관심 공고 다시 확인" onPress={() => setRevision(value => value + 1)} /></>}
    {programs?.length === 0 && <Text style={styles.muted}>담은 공고가 없어요. 필터 검색에서 공고를 선택해 주세요.</Text>}
    {programs?.map(program => {
      const selected = keys.includes(`${program.sourceCode}:${program.id}`)
      return <ProgramCard key={`${program.sourceCode}:${program.id}`} program={program} onOpen={onOpen}
        selection={{ selected, labels, disabled: disabled || (!selected && keys.length >= maximum), onToggle: () => onToggle(program) }} />
    })}
  </Page>
}
