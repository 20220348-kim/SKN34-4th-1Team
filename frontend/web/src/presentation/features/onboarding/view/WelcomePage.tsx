import { accountTypeOptions } from '../viewmodel/onboardingOptions'
import { useWelcomeViewModel } from '../viewmodel/useWelcomeViewModel'
import { onboardingStyles as s } from './Onboarding.styles'
import { OnboardingIconGlyph, OnboardingShell } from './OnboardingShell'

/**
 * 최초 로그인 환영 화면(1단계)입니다. 회원 유형(개인/기업) 하나만 묻습니다.
 * 머리글 아래에 제목·안내, 선택 카드(아이콘·라디오 점·"무엇이 열리는지" 줄) 두 장, 안내 한 줄, 버튼 하나입니다.
 * 개인은 [시작하기]로 바로 검색 화면에 가고, 기업은 [다음]으로 2단계(기업 정보)에 갑니다.
 */
export function WelcomePage() {
  const vm = useWelcomeViewModel()

  return (
    <form className="contents" aria-label="회원 유형 선택" onSubmit={(event) => { event.preventDefault(); vm.start() }}>
      <OnboardingShell
        titleId="welcome-title"
        width="wide"
        steps={[{ label: '회원 유형', state: 'on' }, { label: '기업 정보', state: 'idle' }]}
        foot={
          <>
            {vm.error ? <span className={s.error} role="alert">{vm.error}</span> : null}
            <button type="submit" className={s.primary} disabled={vm.isSaving}>{vm.isSaving ? '저장 중…' : vm.buttonLabel}</button>
          </>
        }
      >
        <div className={s.heading}>
          <span className={s.eyebrow}>1 / 2</span>
          <h1 id="welcome-title" className={s.title}>어떤 회원으로 시작할까요?</h1>
          <p className={s.lead}>사업자등록번호가 있으면 기업 회원, 아직 없으면 개인 회원이에요. 나중에 프로필에서 바꿀 수 있어요.</p>
        </div>
        <div className={s.choices} role="radiogroup" aria-labelledby="welcome-title">
          {accountTypeOptions.map((option) => (
            <label key={option.value} className={s.choice}>
              <input type="radio" name="account-type" className="sr-only" value={option.value} checked={vm.type === option.value} onChange={() => vm.chooseType(option.value)} />
              <span className={`${s.dot} ${vm.type === option.value ? s.dotOn : s.dotIdle}`} aria-hidden="true" />
              <span className={s.icon}><OnboardingIconGlyph name={option.icon} /></span>
              <b className={s.choiceTitle}>{option.title}</b>
              <span className={s.choiceDescription}>{option.description}</span>
              <span className={s.gets}><b className={s.getsLead}>{option.note}</b></span>
            </label>
          ))}
        </div>
        <div className={s.hint}>
          <span className={s.hintIcon}><OnboardingIconGlyph name="info" size={15} /></span>
          <span><b className="text-ink">사업자등록번호는 다음 단계에서 조회해요.</b> 지금 없으면 건너뛰고 프로필에서 나중에 등록할 수 있어요. 가입 때 적은 이메일은 다시 묻지 않아요.</span>
        </div>
      </OnboardingShell>
    </form>
  )
}
