import { workspaceStateStyles as s } from './WorkspaceStates.styles'

/**
 * 불러오기·처리 실패 안내입니다. 무엇이 왜 안 됐는지와 할 일을 한 문장(`message`)으로 쓰고
 * [다시 시도] 하나를 둡니다. 나타나면 `role="alert"`로 바로 읽어 줍니다. 입력한 내용은 지우지 않으므로 화면 쪽 상태는 그대로 둡니다.
 * 다시 시도하는 동안(`retrying`)에는 버튼을 잠가 같은 요청이 겹치지 않게 합니다.
 */
export function ErrorState({ message, onRetry, retrying = false }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return <div className={s.error} role="alert">
    <p className={s.errorMessage}>{message}</p>
    <button type="button" className={s.errorRetry} disabled={retrying} aria-busy={retrying} onClick={onRetry}>다시 시도</button>
  </div>
}
