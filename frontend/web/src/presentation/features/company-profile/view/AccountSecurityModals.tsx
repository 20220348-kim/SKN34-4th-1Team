import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { workspaceModalStyles } from '../../../shared/workspace/WorkspaceModal.styles'
import type { useAccountSecurityViewModel } from '../viewmodel/useAccountSecurityViewModel'

type SecurityViewModel = ReturnType<typeof useAccountSecurityViewModel>

/**
 * 비밀번호 변경 모달입니다. 로그인한 세션이 본인 확인이라 현재 비밀번호는 묻지 않습니다.
 * 새 비밀번호 규칙과 확인 일치는 입력하는 동안 바로 보여 주고, 둘 다 맞을 때만 변경 버튼이 활성입니다.
 */
export function ChangePasswordModal({ vm }: { vm: SecurityViewModel['password'] }) {
  const errorFor = (field: keyof typeof vm.form) =>
    vm.errors[field] ? <p id={`password-${field}-error`} className={workspaceModalStyles.error} role="alert">{vm.errors[field]}</p> : null

  return (
    <WorkspaceModal
      isOpen={vm.isOpen}
      title="비밀번호 변경"
      description="일부 기기의 경우 계정에서 로그아웃될 수 있습니다."
      onClose={vm.close}
    >
      <form className={workspaceModalStyles.form} aria-label="비밀번호 변경" onSubmit={vm.submit} noValidate>
        <div className={workspaceModalStyles.field}>
          <label className={workspaceModalStyles.label} htmlFor="password-newPassword">새 비밀번호</label>
          <input
            className={workspaceModalStyles.input}
            id="password-newPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={72}
            aria-invalid={vm.errors.newPassword !== undefined}
            aria-describedby={vm.errors.newPassword ? 'password-newPassword-error' : 'password-newPassword-hint'}
            value={vm.form.newPassword}
            onChange={(event) => vm.update('newPassword', event.target.value)}
          />
          {errorFor('newPassword') ?? (
            <span
              id="password-newPassword-hint"
              className={vm.newPasswordMeetsRule ? workspaceModalStyles.hintOk : workspaceModalStyles.hint}
              data-state={vm.newPasswordMeetsRule ? 'ok' : 'pending'}
            >
              {vm.newPasswordMeetsRule ? '✓ ' : ''}{vm.lengthHint}
            </span>
          )}
        </div>

        <div className={workspaceModalStyles.field}>
          <label className={workspaceModalStyles.label} htmlFor="password-confirmation">새 비밀번호 확인</label>
          <input
            className={workspaceModalStyles.input}
            id="password-confirmation"
            type="password"
            autoComplete="new-password"
            aria-invalid={vm.errors.confirmation !== undefined || vm.confirmationState === 'mismatch'}
            aria-describedby={vm.errors.confirmation ? 'password-confirmation-error' : vm.confirmationState === 'empty' ? undefined : 'password-confirmation-hint'}
            value={vm.form.confirmation}
            onChange={(event) => vm.update('confirmation', event.target.value)}
          />
          {errorFor('confirmation') ?? (vm.confirmationState === 'empty' ? null : (
            <span
              id="password-confirmation-hint"
              className={vm.confirmationState === 'match' ? workspaceModalStyles.hintOk : workspaceModalStyles.hintBad}
              data-state={vm.confirmationState}
            >
              {vm.confirmationState === 'match' ? `✓ ${vm.confirmationMatchHint}` : `✕ ${vm.confirmationMismatchHint}`}
            </span>
          ))}
        </div>

        {vm.errors.form ? <p className={workspaceModalStyles.error} role="alert">{vm.errors.form}</p> : null}
        <div className={workspaceModalStyles.actions}>
          <button className={workspaceModalStyles.ghostButton} type="button" onClick={vm.close}>취소</button>
          <button className={workspacePageStyles.primaryButton} type="submit" disabled={!vm.canSubmit}>
            {vm.isSubmitting ? '변경 중…' : '변경'}
          </button>
        </div>
      </form>
    </WorkspaceModal>
  )
}

/** 계정 삭제 모달입니다. 지워지는 것을 먼저 읽게 하고 비밀번호로 한 번 더 확인합니다. */
export function DeleteAccountModal({ vm, email }: { vm: SecurityViewModel['deletion']; email: string }) {
  // "삭제되는 것" 목록은 문구를 정한 뒤 다시 켭니다. 미리 보기 조회(`vm.preview`)는 ViewModel에 남아 있어 아래 주석만 풀면 됩니다.
  // const preview = vm.preview.status === 'ready' ? vm.preview.preview : null
  // const consequences = preview === null
  //   ? ['기업 기본정보와 협업·파트너 설정', '내가 올린 모집글은 마감되어 받은 제안은 만료로 보임', '내가 보낸 대기 중 제안은 철회 처리', '로그인 세션과 저장된 힌트']
  //   : [
  //     preview.hasCompany ? '기업 기본정보와 협업·파트너 설정' : null,
  //     preview.openRecruitmentCount > 0
  //       ? `내가 올린 모집글 ${preview.openRecruitmentCount}건 (상대에게는 마감으로 보이고 받은 제안 ${preview.receivedPendingProposalCount}건은 만료)`
  //       : null,
  //     preview.sentPendingProposalCount > 0 ? `내가 보낸 대기 중 제안 ${preview.sentPendingProposalCount}건은 철회 처리` : null,
  //     '로그인 세션과 저장된 힌트',
  //   ].filter((item): item is string => item !== null)

  return (
    <WorkspaceModal
      isOpen={vm.isOpen}
      title="계정을 삭제할까요?"
      description={`${email} 계정과 연결된 정보 및 저장된 대화 기록이 함께 지워집니다.`}
      tone="danger"
      onClose={vm.close}
    >
      <form className={workspaceModalStyles.form} aria-label="계정 삭제" onSubmit={vm.submit} noValidate>
        {/* 삭제되는 것 목록 (문구 확정 전까지 숨김)
        <div className={workspaceModalStyles.consequences} role="status" aria-label="삭제되는 것">
          <strong>삭제되는 것</strong>
          <ul className={workspaceModalStyles.consequenceList}>{consequences.map((item) => <li key={item}>{item}</li>)}</ul>
          {vm.preview.status === 'loading' ? <p className="m-0 mt-1 text-sample-muted">건수를 확인하는 중…</p> : null}
          {vm.preview.status === 'failed' ? <p className="m-0 mt-1 text-sample-muted">건수는 지금 확인하지 못했습니다.</p> : null}
        </div>
        */}

        {/* 소셜 로그인으로만 가입한 계정은 비밀번호가 없어 확인 칸 없이 삭제합니다. */}
        {vm.requiresPassword ? (
          <div className={workspaceModalStyles.field}>
            <label className={workspaceModalStyles.label} htmlFor="delete-password">확인을 위해 비밀번호를 입력하세요</label>
            <input
              className={workspaceModalStyles.input}
              id="delete-password"
              type="password"
              autoComplete="current-password"
              placeholder="현재 비밀번호"
              aria-invalid={vm.error !== null}
              aria-describedby={vm.error ? 'delete-password-error' : undefined}
              value={vm.password}
              onChange={(event) => vm.updatePassword(event.target.value)}
            />
            {vm.error ? <p id="delete-password-error" className={workspaceModalStyles.error} role="alert">{vm.error}</p> : null}
          </div>
        ) : vm.error ? (
          <p className={workspaceModalStyles.error} role="alert">{vm.error}</p>
        ) : null}

        <div className={workspaceModalStyles.actions}>
          <button className={workspaceModalStyles.ghostButton} type="button" onClick={vm.close}>취소</button>
          <button className={workspacePageStyles.dangerButton} type="submit" disabled={!vm.canSubmit}>
            {vm.isSubmitting ? '삭제 중…' : '계정 삭제'}
          </button>
        </div>
      </form>
    </WorkspaceModal>
  )
}
