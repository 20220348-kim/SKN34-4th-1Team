import Constants from 'expo-constants'
import { useEffect, useRef, useState } from 'react'
import { Linking, Text } from 'react-native'
import { serviceContact, serviceInformation, type ServiceInformationSection } from '../content/serviceInformation'
import { PartnerSheet } from './PartnerSheet'
import { Button, Notice, styles } from '../ui'

export function ServiceInformationSheet({ section, onClose }: { section: ServiceInformationSection | null; onClose(): void }) {
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  useEffect(() => {
    revision.current += 1; setError(null)
    return () => { revision.current += 1 }
  }, [section])
  const content = section ? serviceInformation[section] : null
  const version = Constants.nativeAppVersion ?? Constants.expoConfig?.version
  async function openContact() {
    const requestRevision = revision.current
    setError(null)
    const url = serviceContact.url ?? (serviceContact.email ? `mailto:${encodeURIComponent(serviceContact.email)}` : null)
    if (!url) { setError('문의처가 아직 정해지지 않았어요.'); return }
    try { await Linking.openURL(url) } catch {
      if (revision.current === requestRevision) setError('문의처를 열지 못했어요. 다시 시도해 주세요.')
    }
  }
  return <PartnerSheet visible={section !== null} title={content?.title ?? '서비스 안내'} onClose={onClose}
    actions={<Button label="닫기" variant="secondary" style={{ flex: 1 }} onPress={onClose} />}>
    {content && <>
      {section !== 'support' && content.preparing && <Notice>문서 초안 · 운영 문서 확정 전</Notice>}
      {content.sections.filter(item => !(section === 'support' && (serviceContact.email || serviceContact.url) && 'onlyWhenContactMissing' in item))
        .map(item => <Text key={item.title} style={styles.body}><Text style={styles.heading}>{item.title}{'\n'}</Text>{item.body}</Text>)}
      {section === 'support' && <>
        <Text style={styles.muted}>앱 버전 · {version ?? '버전 정보를 확인할 수 없어요'}</Text>
        {(serviceContact.email || serviceContact.url) && <Button label="문의처 열기" variant="secondary" onPress={() => void openContact()} />}
      </>}
      {error && <Notice error>{error}</Notice>}
    </>}
  </PartnerSheet>
}
