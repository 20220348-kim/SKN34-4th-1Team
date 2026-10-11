import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AssistantAnswer } from '@govbiz/shared/domain/entities/AssistantAnswer'
import type { Href } from 'expo-router'
import { AppIcon } from '../components/AppIcon'
import { assistantHelpEntries, assistantHelpTopics, assistantPageHelp, type AssistantHelpTopic } from '../content/assistantHelp'
import { Button, Notice, colors, styles } from '../ui'
import type { AssistantOrigin } from '../assistant/assistantNavigation'

export type AssistantAction = { label: string; href: Href; searchQuery?: string; programQuestion?: string }
export type MobileAssistantMessage = { id: string; role: 'USER' | 'ASSISTANT'; text: string; answer?: AssistantAnswer;
  helpId?: string; origin: AssistantOrigin; question?: string; failed?: boolean }

export function AssistantScreen({ origin, messages, draft, onDraft, onSend, onClose, onStop, onReset, onHelp, busy, error, retryRemaining, aiEnabled, showHelp, actionsFor, onNavigate }: {
  origin: AssistantOrigin
  messages: MobileAssistantMessage[]; draft: string; onDraft(value: string): void; onSend(): void; onClose(): void; onStop(): void; onReset(): void
  onHelp(id: string): void; busy: boolean; error: string | null; retryRemaining: number; aiEnabled: boolean; showHelp: boolean
  actionsFor(message: MobileAssistantMessage): { actions: AssistantAction[]; invalid: boolean }; onNavigate(action: AssistantAction, message: MobileAssistantMessage): void
}) {
  const insets = useSafeAreaInsets()
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible())
  const [topic, setTopic] = useState<AssistantHelpTopic | null>(null)
  const [otherTopics, setOtherTopics] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [unread, setUnread] = useState(false)
  const scroll = useRef<ScrollView>(null), nearBottom = useRef(true), pendingScroll = useRef(false)
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true))
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  useEffect(() => { pendingScroll.current = nearBottom.current; if (!nearBottom.current) setUnread(true) }, [messages.length, busy])
  const source = assistantHelpEntries.find(entry => entry.id === sourceId)
  const pageHelp = assistantPageHelp(origin.path, origin.program !== null)
  const otherQuestions = topic ? assistantHelpEntries.filter(entry => entry.topic === topic && !pageHelp.questions.some(question => question.id === entry.id)) : []
  useEffect(() => { setTopic(null); setOtherTopics(false) }, [origin.path])
  function chooseHelp(id: string) { nearBottom.current = true; pendingScroll.current = true; onHelp(id) }
  return <KeyboardAvoidingView testID="assistant-keyboard-container" accessibilityViewIsModal style={[local.page, { paddingTop: insets.top }]}
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <View style={local.header}><View style={local.mark}><Text style={local.markText}>G</Text></View><Text style={local.title}>GovBiz 도우미</Text>
      <Button label="새 대화" variant="ghost" size="small" disabled={busy} onPress={() => { onReset(); setTopic(null); setOtherTopics(false); setSourceId(null); setUnread(false) }} />
      <Button label={busy ? '중지·닫기' : '닫기'} accessibilityLabel="도우미 닫기" variant="ghost" size="small" onPress={onClose} />
    </View>
    {showHelp && <View style={local.pageHelp}>
      <Text style={local.pageLabel}>{origin.pageLabel ?? pageHelp.label}에서 열었어요</Text>
      <View style={local.quickQuestions}>{pageHelp.questions.map(entry => <Button key={entry.id} label={entry.question}
        variant="secondary" size="small" style={local.quickQuestion} disabled={busy} onPress={() => chooseHelp(entry.id)} />)}</View>
      <Pressable accessibilityRole="button" accessibilityLabel="다른 주제 보기" accessibilityState={{ expanded: otherTopics, disabled: busy }}
        disabled={busy} onPress={() => { pendingScroll.current = true; setOtherTopics(value => !value) }} style={local.otherTopics}>
        <Text style={local.otherLabel}>{otherTopics ? '다른 주제 접기' : '다른 주제 보기'}</Text>
      </Pressable>
    </View>}
    <ScrollView ref={scroll} style={local.scroll} contentContainerStyle={local.content} keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag" onScroll={({ nativeEvent: e }) => { nearBottom.current = e.layoutMeasurement.height + e.contentOffset.y >= e.contentSize.height - 80 }} scrollEventThrottle={100}
      onContentSizeChange={() => { if (pendingScroll.current) { scroll.current?.scrollToEnd({ animated: true }); pendingScroll.current = false; setUnread(false) } }}>
      {messages.length === 0 && <><Text accessibilityRole="header" style={local.greeting}>무엇을 도와드릴까요?</Text><Text style={styles.body}>{aiEnabled
        ? '위 질문을 선택하거나 궁금한 내용을 직접 입력해 주세요.' : '위 질문을 선택해 주세요. 다른 주제의 질문도 확인할 수 있어요.'}</Text></>}
      {messages.map(message => {
        const destinations = message.role === 'ASSISTANT' ? actionsFor(message) : { actions: [], invalid: false }
        return <View key={message.id} style={message.role === 'USER' ? local.user : local.answer}>
          {message.role === 'ASSISTANT' && <Text style={local.botName}>GovBiz 도우미</Text>}
          <Text selectable style={styles.body}>{message.text}</Text>
          {message.answer?.intent === 'ACCOUNT_STATE' && <Text style={styles.muted}>내 계정 상태 · 응답 시점 기준</Text>}
          {message.answer?.cards.map(card => <View key={`${message.id}:${card.kind}:${card.id}`} style={local.card}>
            <Text style={styles.heading}>{card.title}</Text>{card.subtitle && <Text style={styles.muted}>{card.subtitle}</Text>}
            <Text style={styles.body}>{card.reason}</Text>{card.quote && <Text selectable style={styles.muted}>원문 근거 · {card.quote}</Text>}
          </View>)}
          {[...(message.helpId ? [message.helpId] : []), ...(message.answer?.citations ?? [])].map(id => {
            const entry = assistantHelpEntries.find(item => item.id === id)
            return entry ? <Button key={id} label={`도움말 근거 · ${entry.title}`} variant="ghost" size="small" onPress={() => setSourceId(id)} /> : null
          })}
          {destinations.invalid && <Notice error>이 답변의 이동 경로를 확인하지 못했어요. 메뉴에서 해당 기능을 열어 주세요.</Notice>}
          {destinations.actions.map((action, index) => <Button key={`${message.id}:${index}`} label={action.label} variant="secondary" disabled={busy} onPress={() => onNavigate(action, message)} />)}
        </View>
      })}
      {busy && <View accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator color={colors.primary} /><Text style={styles.body}>답변을 확인하는 중이에요.</Text></View>}
      {error && <Notice error>{error}</Notice>}
      {retryRemaining > 0 && <Text accessibilityLiveRegion="polite" style={styles.muted}>{retryRemaining}초 뒤 다시 질문할 수 있어요.</Text>}
      {source && <View style={local.card}><Text style={styles.heading}>{source.title}</Text><Text style={styles.body}>{source.summary}</Text>
        {source.body.map((text, index) => <Text key={index} selectable style={styles.body}>{text}</Text>)}{source.limitation && <Notice>{source.limitation}</Notice>}
        <Button label="근거 닫기" size="small" variant="ghost" onPress={() => setSourceId(null)} /></View>}
      {showHelp && otherTopics && <>
        <View style={local.topics}>{assistantHelpTopics.map(value => <Button key={value} label={value} size="small" variant={topic === value ? 'primary' : 'secondary'}
          disabled={busy} onPress={() => setTopic(value)} />)}</View>
        {otherQuestions.map(entry => <Button key={entry.id} label={entry.question} variant="secondary" disabled={busy} onPress={() => chooseHelp(entry.id)} />)}
        {topic && otherQuestions.length === 0 && <Text style={styles.muted}>이 주제의 주요 질문은 위에 표시되어 있어요.</Text>}
      </>}
    </ScrollView>
    {unread && <Button label="새 답변 보기" variant="ghost" size="small" onPress={() => { scroll.current?.scrollToEnd({ animated: true }); nearBottom.current = true; setUnread(false) }} />}
    {aiEnabled && <View style={local.dock}><View style={local.composer}>
      <TextInput accessibilityLabel="도우미 질문" placeholder="궁금한 점을 입력해 주세요" placeholderTextColor={colors.placeholder} value={draft}
        onChangeText={onDraft} multiline maxLength={500} editable={!busy} style={local.input} />
      <Pressable accessibilityRole="button" accessibilityLabel={busy ? '도우미 요청 중지' : '도우미 질문 보내기'}
        accessibilityState={{ disabled: !busy && (!draft.trim() || retryRemaining > 0), busy }} disabled={!busy && (!draft.trim() || retryRemaining > 0)}
        onPress={busy ? onStop : onSend} style={local.send}>{busy ? <View style={local.stop} /> : <AppIcon name="arrowUp" color={colors.surface} size={23} />}</Pressable>
    </View><Text style={local.disclaimer}>AI 답변은 참고용입니다. 최종 신청 조건은 원문에서 확인하세요.</Text></View>}
    <View testID="assistant-bottom-safe-area" style={{ height: keyboardVisible ? 0 : insets.bottom + 4 }} />
  </KeyboardAvoidingView>
}
const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface }, header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 62, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  mark: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.soft }, markText: { color: colors.primary, fontWeight: '700' },
  pageHelp: { paddingHorizontal: 16, paddingTop: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 8 },
  pageLabel: { color: colors.primary, fontSize: 13, fontWeight: '600' }, quickQuestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quickQuestion: { minHeight: 48, flexGrow: 1, flexShrink: 1, maxWidth: '100%' }, otherTopics: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 8 },
  otherLabel: { color: colors.primary, fontSize: 14 },
  title: { flex: 1, color: colors.text, fontWeight: '700', fontSize: 16 }, scroll: { flex: 1 }, content: { paddingHorizontal: 20, paddingTop: 20, gap: 16 }, greeting: { fontSize: 24, fontWeight: '700', color: colors.text },
  user: { alignSelf: 'flex-end', maxWidth: '90%', padding: 14, borderRadius: 18, backgroundColor: colors.soft }, answer: { gap: 12 }, botName: { color: colors.primary, fontWeight: '600' },
  card: { padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, gap: 10 }, topics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dock: { paddingHorizontal: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }, composer: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: 18 },
  input: { flex: 1, color: colors.text, fontSize: 16, minHeight: 48, maxHeight: 130, padding: 8 }, send: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  disclaimer: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 8 },
  stop: { width: 13, height: 13, borderRadius: 2, backgroundColor: colors.surface },
})
