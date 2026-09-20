import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import type { AccountDeletionPreview } from '../../../../domain/entities/AccountDeletionPreview'
import type {
  ChangePasswordUseCase,
  DeleteAccountUseCase,
  GetAccountDeletionPreviewUseCase,
} from '../../../../domain/usecases/AccountProfileUseCases'
import { isValidSignUpPassword, signUpPasswordLength } from '../../../../domain/usecases/SignUpUseCase'
import { selectCurrentAccount, signedOut } from '../../../shared/auth/state/authSlice'
import { publicPaths } from '../../../shared/routes/appPaths'

export const accountSecurityMessages = {
  newPasswordLength: `${signUpPasswordLength.min}자 이상 ${signUpPasswordLength.max}자 이하`,
  newPasswordInvalid: `새 비밀번호는 ${signUpPasswordLength.min}자 이상 ${signUpPasswordLength.max}자 이하여야 합니다.`,
  confirmationMismatch: '새 비밀번호와 다릅니다.',
  confirmationMatch: '새 비밀번호와 일치합니다.',
  currentPasswordMismatch: '현재 비밀번호가 맞지 않습니다.',
  rateLimited: (retryAfterSeconds: number | null) =>
    retryAfterSeconds === null ? '시도가 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.' : `시도가 많아 잠시 막혔습니다. ${retryAfterSeconds}초 뒤에 다시 시도해 주세요.`,
  requestFailed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  passwordChanged: '비밀번호를 변경했습니다. 일부 기기에서는 다시 로그인해야 할 수 있습니다.',
  deletePasswordRequired: '확인을 위해 현재 비밀번호를 입력해 주세요.',
  lastAdmin: '마지막 관리자 계정은 삭제할 수 없습니다. 다른 관리자를 먼저 지정해 주세요.',
} as const

type PasswordField = 'newPassword' | 'confirmation'
type PasswordFormErrors = Partial<Record<PasswordField | 'form', string>>

type DeletionPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: AccountDeletionPreview }
  | { status: 'failed' }

type SecurityUseCases = {
  changePassword: Pick<ChangePasswordUseCase, 'execute'>
  getDeletionPreview: Pick<GetAccountDeletionPreviewUseCase, 'execute'>
  deleteAccount: Pick<DeleteAccountUseCase, 'execute'>
}

/**
 * 프로필 계정 카드의 비밀번호 변경 모달과 계정 삭제 모달 ViewModel입니다. 두 모달의 열림·입력·확인·결과 안내를 소유하고,
 * 삭제에 성공하면 Store를 비운 뒤 랜딩으로 보냅니다. 기업 정보 폼과는 다른 관심사라 ViewModel을 나눕니다.
 */
export function useAccountSecurityViewModel(useCases: Partial<SecurityUseCases> = {}) {
  const resolved: SecurityUseCases = {
    changePassword: useCases.changePassword ?? appContainer.resolve('changePasswordUseCase'),
    getDeletionPreview: useCases.getDeletionPreview ?? appContainer.resolve('getAccountDeletionPreviewUseCase'),
    deleteAccount: useCases.deleteAccount ?? appContainer.resolve('deleteAccountUseCase'),
  }
  const dispatchToStore = useAppDispatch()
  // 소셜 로그인으로만 가입해 비밀번호가 없는 계정은 삭제할 때 비밀번호를 묻지 않습니다.
  const requiresDeletePassword = useAppSelector(selectCurrentAccount)?.hasPassword ?? true
  const navigate = useNavigate()
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false)
  const [passwordForm, setPasswordForm] = useState({ newPassword: '', confirmation: '' })
  const [passwordErrors, setPasswordErrors] = useState<PasswordFormErrors>({})
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [deletionPreview, setDeletionPreview] = useState<DeletionPreviewState>({ status: 'loading' })
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    if (!isDeleteModalOpen) return
    const controller = new AbortController()
    setDeletionPreview({ status: 'loading' })
    void Promise.resolve()
      .then(() => resolved.getDeletionPreview.execute(controller.signal))
      .then((preview) => { if (!controller.signal.aborted) setDeletionPreview({ status: 'ready', preview }) })
      .catch(() => { if (!controller.signal.aborted) setDeletionPreview({ status: 'failed' }) })
    return () => controller.abort()
    // 모달을 열 때 한 번만 읽습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDeleteModalOpen])

  function openPasswordModal() {
    setPasswordForm({ newPassword: '', confirmation: '' })
    setPasswordErrors({})
    setPasswordNotice(null)
    setIsPasswordModalOpen(true)
  }

  function closePasswordModal() {
    if (isChangingPassword) return
    setIsPasswordModalOpen(false)
  }

  function updatePasswordField(field: PasswordField, value: string) {
    setPasswordForm((current) => ({ ...current, [field]: value }))
    setPasswordErrors((current) => {
      const { [field]: _removed, form: _form, ...rest } = current
      return rest
    })
  }

  // 입력하는 동안 규칙 충족과 확인 일치를 바로 보여 주고, 둘 다 맞을 때만 보냅니다.
  const newPasswordMeetsRule = isValidSignUpPassword(passwordForm.newPassword)
  const confirmationState: 'empty' | 'match' | 'mismatch' =
    passwordForm.confirmation === '' ? 'empty' : passwordForm.confirmation === passwordForm.newPassword ? 'match' : 'mismatch'
  const canSubmitPassword =
    newPasswordMeetsRule &&
    passwordForm.newPassword === passwordForm.confirmation &&
    !isChangingPassword

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isChangingPassword) return
    const errors: PasswordFormErrors = {}
    if (!newPasswordMeetsRule) errors.newPassword = accountSecurityMessages.newPasswordInvalid
    if (passwordForm.confirmation !== passwordForm.newPassword) errors.confirmation = accountSecurityMessages.confirmationMismatch
    if (Object.keys(errors).length > 0) {
      setPasswordErrors(errors)
      return
    }

    setIsChangingPassword(true)
    try {
      const result = await resolved.changePassword.execute(passwordForm.newPassword)
      if (!isMounted.current) return
      if (result.outcome === 'rate-limited') {
        setPasswordErrors({ form: accountSecurityMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      setIsPasswordModalOpen(false)
      setPasswordNotice(accountSecurityMessages.passwordChanged)
    } catch {
      if (isMounted.current) setPasswordErrors({ form: accountSecurityMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsChangingPassword(false)
    }
  }

  function openDeleteModal() {
    setDeletePassword('')
    setDeleteError(null)
    setIsDeleteModalOpen(true)
  }

  function closeDeleteModal() {
    if (isDeleting) return
    setIsDeleteModalOpen(false)
  }

  async function submitDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isDeleting) return
    if (requiresDeletePassword && deletePassword === '') {
      setDeleteError(accountSecurityMessages.deletePasswordRequired)
      return
    }
    setIsDeleting(true)
    setDeleteError(null)
    try {
      const result = await resolved.deleteAccount.execute(requiresDeletePassword ? deletePassword : null)
      if (!isMounted.current) return
      if (result.outcome === 'current-password-mismatch') {
        setDeleteError(accountSecurityMessages.currentPasswordMismatch)
        return
      }
      if (result.outcome === 'rate-limited') {
        setDeleteError(accountSecurityMessages.rateLimited(result.retryAfterSeconds))
        return
      }
      if (result.outcome === 'last-admin') {
        setDeleteError(accountSecurityMessages.lastAdmin)
        return
      }
      setIsDeleteModalOpen(false)
      dispatchToStore(signedOut())
      // RequireAuth가 로그인 화면으로 먼저 보내는 것을 피하려고 Store 갱신이 반영된 뒤 랜딩으로 이동합니다.
      window.setTimeout(() => navigate(publicPaths.landing, { replace: true }), 0)
    } catch {
      if (isMounted.current) setDeleteError(accountSecurityMessages.requestFailed)
    } finally {
      if (isMounted.current) setIsDeleting(false)
    }
  }

  return {
    password: {
      isOpen: isPasswordModalOpen,
      open: openPasswordModal,
      close: closePasswordModal,
      form: passwordForm,
      update: updatePasswordField,
      errors: passwordErrors,
      /** 새 비밀번호 칸 아래 규칙 한 줄입니다. 충족하면 초록으로 바뀝니다. */
      lengthHint: accountSecurityMessages.newPasswordLength,
      newPasswordMeetsRule,
      confirmationState,
      confirmationMatchHint: accountSecurityMessages.confirmationMatch,
      confirmationMismatchHint: accountSecurityMessages.confirmationMismatch,
      canSubmit: canSubmitPassword,
      isSubmitting: isChangingPassword,
      submit: submitPasswordChange,
      notice: passwordNotice,
      dismissNotice: () => setPasswordNotice(null),
    },
    deletion: {
      isOpen: isDeleteModalOpen,
      open: openDeleteModal,
      close: closeDeleteModal,
      preview: deletionPreview,
      /** 거짓이면 비밀번호 칸을 그리지 않고 세션만으로 삭제합니다. */
      requiresPassword: requiresDeletePassword,
      password: deletePassword,
      updatePassword: (value: string) => { setDeletePassword(value); setDeleteError(null) },
      error: deleteError,
      canSubmit: (!requiresDeletePassword || deletePassword !== '') && !isDeleting,
      isSubmitting: isDeleting,
      submit: submitDeletion,
    },
  }
}
