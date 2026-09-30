import Svg, { Circle, Path, Rect } from 'react-native-svg'
import type { ColorValue } from 'react-native'

export type AppIconName = 'search' | 'bookmark' | 'collaboration' | 'report' | 'account' | 'pencil' | 'send' | 'calendar' | 'message' | 'document' | 'shield'

/** Paths from the approved mobile design; do not substitute emoji or a heart for the bookmark. */
export function AppIcon({ name, color, size = 24, selected = false }: {
  name: AppIconName; color: ColorValue; size?: number; selected?: boolean
}) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} fill="none"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" accessible={false}>
    {name === 'search' && <><Circle cx={11} cy={11} r={6.5} /><Path d="m16 16 4.5 4.5" /></>}
    {name === 'bookmark' && <Path d="M6 4h12v16l-6-4-6 4z" fill={selected ? color : 'none'} />}
    {name === 'collaboration' && <><Circle cx={9} cy={8} r={3.5} fill={selected ? color : 'none'} />
      <Path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></>}
    {name === 'report' && <><Rect x={4} y={3} width={16} height={18} rx={2.5} />
      <Path d="M8.5 16.5v-3M12 16.5v-7M15.5 16.5v-5" strokeWidth={selected ? 2.5 : 1.75} /></>}
    {name === 'account' && <><Circle cx={12} cy={8} r={4} fill={selected ? color : 'none'} /><Path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>}
    {name === 'pencil' && <><Path d="M4 20h4L19 9l-4-4L4 16z" /><Path d="m13.5 6.5 4 4" /></>}
    {name === 'send' && <Path d="m21 3-7 18-4-7-7-4zM10 14 21 3" />}
    {name === 'calendar' && <><Rect x={3} y={5} width={18} height={16} rx={2} />
      <Path d="M7 3v4M17 3v4M3 10h18" /></>}
    {name === 'message' && <Path d="M4 5h16v12H9l-5 4z" />}
    {name === 'document' && <Path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" />}
    {name === 'shield' && <Path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6z" />}
  </Svg>
}
