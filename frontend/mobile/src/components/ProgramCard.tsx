import { Pressable, Text, View } from 'react-native'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { Card, styles } from '../ui'

export const statusLabels = { OPEN: '접수 중', UPCOMING: '접수 예정', CLOSED: '마감', UNKNOWN: '상태 미확인' }

export function ProgramCard({ program, onOpen }: { program: SupportProgram; onOpen: (identity: SupportProgramIdentity) => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${program.title}, 상세 보기`}
    onPress={() => onOpen({ sourceCode: program.sourceCode, sourceProgramId: program.id })}>
    <Card>
      <View style={styles.row}><Text style={styles.badge}>{statusLabels[program.status]}</Text><Text style={styles.muted}>{program.sourceName}</Text></View>
      <Text style={styles.heading}>{program.title}</Text>
      <Text style={styles.muted}>{program.organization}</Text>
      <Text style={styles.body} numberOfLines={2}>{program.summary}</Text>
      <Text style={styles.muted}>{program.applicationPeriod}</Text>
      {program.regions.length > 0 && <Text style={styles.muted}>{program.regions.join(' · ')}</Text>}
      {program.matchedReasons.map((reason) => <Text key={reason} style={styles.muted}>• {reason}</Text>)}
      <Text style={[styles.label, { textAlign: 'right' }]}>공고 상세 →</Text>
    </Card>
  </Pressable>
}
