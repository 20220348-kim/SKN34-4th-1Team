import { Text, View } from 'react-native'
import { AppIcon, type AppIconName } from './AppIcon'
import { Button, Card, colors, styles } from '../ui'

export function GuestFeatureNotice({ title, description, icon, onLogin }: {
  title: string; description: string; icon: AppIconName; onLogin(mode?: 'login' | 'signup'): void
}) {
  return <Card><View style={{ alignSelf: 'center', padding: 18, backgroundColor: colors.soft, borderRadius: 24 }}>
    <AppIcon name={icon} size={32} color={colors.primary} /></View>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{description}</Text>
    <Button label="로그인하기" onPress={() => onLogin('login')} />
    <Button label="회원가입" variant="secondary" onPress={() => onLogin('signup')} />
  </Card>
}
