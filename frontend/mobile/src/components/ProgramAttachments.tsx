import { useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text } from 'react-native'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import type { SupportProgramAttachmentDto } from '@govbiz/shared/data/models/SupportProgramAttachmentDto'
import type { programClient } from '../api/client'
import { AppIcon } from './AppIcon'
import { Card, StatusBadge, colors, styles } from '../ui'

/**
 * 공고 원문이 직접 연결한 첨부 목록입니다(이미지 제외). 파일은 Core가 원본에서 받아 한글 이름 그대로 내려 주는 주소를
 * 기기 브라우저로 열어 받습니다. 첨부가 없으면 카드를 그리지 않고, 원문을 읽지 못하면 원문에서 확인하도록 안내합니다.
 */
export function ProgramAttachments({ client, identity }: {
  client: ReturnType<typeof programClient>; identity: SupportProgramIdentity
}) {
  const [items, setItems] = useState<SupportProgramAttachmentDto[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [openError, setOpenError] = useState(false)
  const { sourceCode, sourceProgramId } = identity

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setItems(null); setFailed(false); setOpenError(false)
    client.getAttachments({ sourceCode, sourceProgramId }, controller.signal)
      .then((value) => { if (active) setItems(value) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false; controller.abort() }
  }, [client, sourceCode, sourceProgramId])

  async function open(index: number) {
    setOpenError(false)
    try { await Linking.openURL(client.attachmentDownloadUrl({ sourceCode, sourceProgramId }, index)) } catch { setOpenError(true) }
  }

  if (items && items.length === 0) return null
  return <Card>
    <Text style={styles.heading}>첨부파일</Text>
    {failed ? <Text style={styles.muted}>첨부파일을 불러오지 못했어요. 공식 공고 원문에서 확인해 주세요.</Text>
      : !items ? <ActivityIndicator color={colors.primary} accessibilityLabel="첨부파일을 불러오는 중" />
        : items.map((item) => <Pressable key={item.index} accessibilityRole="link" accessibilityLabel={`${item.fileName} 받기`}
          onPress={() => void open(item.index)} style={local.item}>
          <AppIcon name="document" color={colors.muted} size={20} />
          <Text style={[styles.body, local.name]}>{item.fileName}</Text>
          {item.extension ? <StatusBadge label={item.extension.toUpperCase()} /> : null}
          <Text style={local.download}>받기</Text>
        </Pressable>)}
    {openError && <Text style={styles.muted}>파일을 열지 못했어요. 다시 시도해 주세요.</Text>}
  </Card>
}

const local = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 6 },
  name: { flex: 1 },
  download: { color: colors.primary, fontSize: 14, fontWeight: '600' },
})
