import { workspacePageStyles } from './WorkspacePage.styles'

/**
 * 작업 화면들이 함께 쓰는 켬·끔 스위치입니다. 설명 문구는 부르는 쪽이 그리고,
 * 여기서는 상태와 접근성 이름만 맡습니다.
 */
export function WorkspaceToggle({
  label,
  isOn,
  onToggle,
  disabled = false,
}: {
  label: string
  isOn: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <button
      className={`${workspacePageStyles.toggle} ${
        isOn ? workspacePageStyles.toggleOn : workspacePageStyles.toggleOff
      }`}
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
    >
      <span
        className={`${workspacePageStyles.toggleKnob} ${
          isOn ? workspacePageStyles.toggleKnobOn : workspacePageStyles.toggleKnobOff
        }`}
        aria-hidden="true"
      />
    </button>
  )
}
