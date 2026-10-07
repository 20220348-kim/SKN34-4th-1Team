import {
  answerEditorStyles as e,
  applicationPreparationStyles as s,
  documentResultStyles as d,
  loadingStyles as k,
} from './ApplicationPreparation.styles'

/**
 * 신청 문서 작성 화면들의 스켈레톤과 버튼 스피너입니다. 스켈레톤은 실제 카드와 같은 틀(여백·모서리·테두리)을 쓰고 안만 막대로 채워,
 * 내용이 채워져도 자리가 밀리지 않게 합니다. 막대는 장식이라 `aria-hidden`이고, "불러오는 중" 문구는 부르는 쪽이 낭독기용으로 둡니다.
 */

/** 글자 한 줄 자리입니다. `box`는 실제 줄 높이, `bar`는 그 안 가운데에 놓이는 막대의 크기입니다. */
function Line({ box, bar }: { box: string; bar: string }) {
  return <span className={`flex items-center ${box}`}><span className={`${k.bar} ${bar}`} /></span>
}

/** 누른 버튼 안, 문구 앞에 붙이는 스피너입니다. 버튼 글자색을 따릅니다. */
export function ButtonSpinner() {
  return <span className={d.buttonSpinner} aria-hidden="true" />
}

/** 목록(23)의 카드 자리입니다. 배지 줄 · 제목 2줄 · 양식 줄 · 필수 답변 막대 · 아래 줄(날짜 | 메뉴 · 버튼). */
export function ListCardSkeleton() {
  return <>
    <Line box="h-5" bar="h-5 w-14 rounded-full" />
    <span className="flex flex-col gap-1">
      <span className="flex flex-col"><Line box="h-6" bar="h-4 w-11/12" /><Line box="h-6" bar="h-4 w-3/5" /></span>
      <Line box="h-5" bar="h-3.5 w-2/3" />
    </span>
    <span className="flex flex-col gap-1">
      <Line box="h-5" bar="h-3 w-24" />
      <span className={`${k.bar} h-1.5 w-full rounded-full`} />
    </span>
    <span className={s.cardFooter}>
      <span className={`${k.bar} h-3 w-20`} />
      <span className={s.cardActions}>
        <span className={`${k.bar} size-8 rounded-full`} />
        <span className={`${k.bar} h-8 w-[4.75rem] rounded-full`} />
      </span>
    </span>
  </>
}

/** 답변 입력(25)의 배치 그대로입니다. 왼쪽 전체 답변 막대 · 항목 5줄 · 검토 링크, 오른쪽 질문 카드와 입력 도우미 머리. 600px 미만은 왼쪽 대신 진행 줄을 둡니다. */
export function AnswerEditorSkeleton() {
  return <div className={e.layout} aria-hidden="true">
    <div className={e.aside}>
      <div className={e.meterCard}>
        <span className={e.progress}>
          <span className="flex items-center justify-between"><Line box="h-[18px]" bar="h-3 w-24" /><Line box="h-[18px]" bar="h-3 w-8" /></span>
          <span className={`${k.bar} h-1.5 w-full rounded-full`} />
        </span>
        <Line box="h-[17px]" bar="h-3 w-32" />
      </div>
      <div className={e.sectionList}>
        {[0, 1, 2, 3, 4].map((index) => <span className="flex items-center gap-2.5 px-2 py-2" key={index}>
          <span className={`${k.bar} size-6 shrink-0 rounded-full`} />
          <span className="flex min-w-0 flex-1 flex-col">
            <Line box="h-[19px]" bar="h-3.5 w-3/5" />
            <Line box="h-4" bar="h-3 w-1/3" />
          </span>
          <span className={`${k.bar} h-5 w-11 rounded-full`} />
        </span>)}
      </div>
      <span className={`${k.bar} h-10 w-full rounded-full`} />
    </div>
    <div className="flex min-w-0 flex-col gap-3">
      <div className={`${e.stepperM} min-[600px]:hidden`}>
        <span className="flex items-center justify-between gap-3"><Line box="h-5" bar="h-4 w-32" /><Line box="h-5" bar="h-4 w-16" /></span>
        <span className={`${k.bar} h-1.5 w-full rounded-full`} />
        <Line box="h-[1.125rem]" bar="h-3 w-28" />
      </div>
      <div className={e.question}>
        <span className={e.questionHead}><Line box="h-[22px] min-w-0 flex-1" bar="h-3 w-40" /><span className={`${k.bar} h-5 w-10 rounded-full`} /></span>
        <Line box="h-[1.66rem]" bar="h-5 w-3/5" />
        <Line box="h-[1.39rem]" bar="h-3.5 w-4/5" />
        <span className={`${k.bar} h-28 w-full rounded-xl`} />
        <Line box="h-4 justify-end" bar="h-3 w-20" />
        <Line box="h-[19px]" bar="h-3.5 w-40" />
        <span className={`${e.cardFooter} max-[599px]:hidden`}>
          <span className={`${k.bar} h-10 w-[4.75rem] rounded-full`} />
          <span className="min-w-0 flex-1"><Line box="h-[1.17rem]" bar="h-3 w-36" /></span>
          <span className={`${k.bar} h-10 w-[4.75rem] rounded-full`} />
        </span>
      </div>
      <div className={s.guide}>
        <span className="!mt-0 flex flex-col gap-0.5"><Line box="h-6" bar="h-4 w-44" /><Line box="h-6" bar="h-3.5 w-3/5" /></span>
      </div>
    </div>
  </div>
}

/** 초안(26)의 문서 묶음 자리입니다. 묶음 제목 한 줄과 파일 카드 2장(형식 칸 · 파일명 2줄 · [받기] · 기입 막대). */
export function DocumentFilesSkeleton() {
  return <div className={d.group} aria-hidden="true">
    <Line box="h-[22px]" bar="h-4 w-48" />
    {[0, 1].map((index) => <div className={d.file} key={index}>
      <span className={d.fileHead}>
        <span className={`${k.bar} h-9 w-11 shrink-0 rounded-lg`} />
        <span className={d.fileText}><Line box="h-[1.27rem]" bar="h-4 w-3/5" /><Line box="h-[17px]" bar="h-3 w-24" /></span>
        <span className={`${k.bar} h-8 w-12 shrink-0 rounded-full`} />
      </span>
      <span className={d.fill}>
        <span className={`${k.bar} h-1.5 w-full rounded-full`} />
        <Line box="h-[17px]" bar="h-3 w-32" />
      </span>
    </div>)}
  </div>
}

/** 온라인 신청 입력 도우미 본문의 3줄 자리입니다. */
export function GuideSkeleton() {
  return <div className="flex flex-col gap-2 py-1" aria-hidden="true">
    <span className={`${k.bar} h-3.5 w-2/5`} /><span className={`${k.bar} h-3.5 w-4/5`} /><span className={`${k.bar} h-3.5 w-3/5`} />
  </div>
}
