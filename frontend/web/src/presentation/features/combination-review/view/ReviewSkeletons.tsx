import type { ReactNode } from 'react'

import { reviewStyles as s } from './CombinationReview.styles'

/**
 * 중복 지원·수혜 검토 화면들의 스켈레톤입니다. 실제 카드와 같은 틀(여백·모서리·테두리)을 쓰고 안만 막대로 채워,
 * 내용이 채워져도 자리가 밀리지 않게 합니다. 막대는 장식이라 `aria-hidden`이고, "불러오는 중" 문구는 부르는 쪽이 낭독기용으로 둡니다.
 */

/** 글자 한 줄 자리입니다. `box`는 실제 줄 높이, `bar`는 그 안 가운데에 놓이는 막대의 크기입니다. */
function Line({ box, bar }: { box: string; bar: string }) {
  return <span className={`flex items-center ${box}`}><span className={`${s.skeletonBar} ${bar}`} /></span>
}

/** 목록 카드 자리입니다. 배지 줄 · 제목과 한 줄 안내 · 아래 줄(날짜 | 메뉴 · 버튼). */
export function ReviewListSkeleton() {
  return <ul className="grid gap-3" aria-hidden="true">
    {[0, 1, 2].map((index) => <li className={s.listCard} key={index}>
      <span className="flex items-center gap-2"><span className={`${s.skeletonBar} h-[22px] w-16`} /><Line box="h-4" bar="h-3 w-16" /></span>
      <span className="flex flex-col gap-0.5"><Line box="h-6" bar="h-4 w-3/5" /><Line box="h-5" bar="h-3.5 w-2/5" /></span>
      <span className={s.listFooter}>
        <Line box="h-4" bar="h-3 w-28" />
        <span className="flex items-center gap-2"><span className={`${s.skeletonBar} size-8 rounded-full`} /><span className={`${s.skeletonBar} h-8 w-20 rounded-full`} /></span>
      </span>
    </li>)}
  </ul>
}

/** 카드 제목 한 줄과 본문 막대 몇 줄입니다. 단계 화면의 카드들이 같은 틀을 씁니다. */
function CardSkeleton({ titleWidth = 'w-40', children }: { titleWidth?: string; children: ReactNode }) {
  return <div className={`${s.card} flex flex-col gap-3`}>
    <Line box="h-6" bar={`h-4 ${titleWidth}`} />
    {children}
  </div>
}

/** 저장한 검토를 읽는 동안 지금 단계(주소의 `?step=`)의 카드 배치를 그립니다. */
export function ReviewEditorSkeleton({ step }: { step: 'selection' | 'participation' | 'analysis' }) {
  if (step === 'participation') return <div className="space-y-4" aria-hidden="true">
    <Line box="h-6" bar="h-3.5 w-3/5" />
    {[0, 1].map((index) => <CardSkeleton key={index} titleWidth="w-56">
      <Line box="h-5" bar="h-3.5 w-40" />
      <span className={`${s.skeletonBar} h-[42px] w-full rounded-lg`} />
    </CardSkeleton>)}
    <CardSkeleton titleWidth="w-52"><span className={`${s.skeletonBar} h-28 w-full rounded-lg`} /><Line box="h-6" bar="h-3 w-32" /></CardSkeleton>
  </div>
  if (step === 'analysis') return <div className="space-y-4" aria-hidden="true">
    <span className={`${s.skeletonBar} h-[4.5rem] w-full rounded-xl`} />
    <CardSkeleton titleWidth="w-28">{[0, 1].map((index) => <span className={`${s.skeletonBar} h-11 w-full rounded-lg`} key={index} />)}</CardSkeleton>
    <CardSkeleton titleWidth="w-32"><Line box="h-6" bar="h-3.5 w-full" /><Line box="h-6" bar="h-3.5 w-4/5" /></CardSkeleton>
    <CardSkeleton titleWidth="w-24">{[0, 1].map((index) => <span className={`${s.skeletonBar} h-10 w-full rounded-lg`} key={index} />)}</CardSkeleton>
  </div>
  // 1단계: 검토 제목 카드와 비교할 공고 카드(제목 · n/2 · 안내 한 줄 · 사업 칸 2개).
  return <div className="space-y-4" aria-hidden="true">
    <CardSkeleton titleWidth="w-20"><span className={`${s.skeletonBar} h-[42px] w-full rounded-lg`} /><Line box="h-6" bar="h-3.5 w-3/5" /></CardSkeleton>
    <div className={`${s.card} flex flex-col gap-3`}>
      <span className="flex items-center justify-between gap-2"><Line box="h-6" bar="h-4 w-28" /><span className={`${s.skeletonBar} h-7 w-12 rounded-full`} /></span>
      <Line box="h-6" bar="h-3.5 w-3/5" />
      <span className={s.slots}>{[0, 1].map((index) => <span className={s.slot} key={index}>
        <Line box="h-4" bar="h-3 w-10" />
        <span className={`${s.skeletonBar} h-[22px] w-24`} />
        <Line box="h-[1.4rem]" bar="h-4 w-4/5" />
        <Line box="h-5" bar="h-3.5 w-3/5" />
        <span className="flex w-full items-center justify-between gap-2 pt-1"><Line box="h-4" bar="h-3 w-16" /><span className={`${s.skeletonBar} h-8 w-28 rounded-full`} /></span>
      </span>)}</span>
    </div>
  </div>
}

/** 실행 결과 자리입니다. 요약 카드(판단 배지 · 사업 2개 · 요약 문단) · 안내 상자 · 확인할 정보 · 단계별 판단 카드 2장. */
export function ReviewRunResultSkeleton() {
  return <div className="space-y-4" aria-hidden="true">
    <div className={`${s.card} flex flex-col gap-3`}>
      <span className="flex items-center gap-1.5">
        {[0, 1, 2].map((index) => <span className={`${s.skeletonBar} h-[22px] w-14`} key={index} />)}
        <span className="ml-auto"><Line box="h-4" bar="h-3 w-16" /></span>
      </span>
      <span className="flex flex-col gap-1">{[0, 1].map((index) => <span className="flex items-center gap-2" key={index}><span className={`${s.skeletonBar} h-[22px] w-12`} /><Line box="h-5" bar="h-3.5 w-1/2" /></span>)}</span>
      <span className="flex flex-col"><Line box="h-7" bar="h-3.5 w-full" /><Line box="h-7" bar="h-3.5 w-11/12" /><Line box="h-7" bar="h-3.5 w-3/5" /></span>
    </div>
    <span className={`${s.skeletonBar} h-20 w-full rounded-xl`} />
    <div className={`${s.card} flex flex-col gap-2`}>
      <span className="flex items-center justify-between gap-2"><Line box="h-6" bar="h-4 w-24" /><span className={`${s.skeletonBar} h-8 w-24 rounded-full`} /></span>
      <Line box="h-6" bar="h-3.5 w-2/3" />
    </div>
    <Line box="h-6" bar="h-4 w-28" />
    {[0, 1].map((index) => <div className={`${s.card} flex flex-col gap-2`} key={index}>
      <span className="flex items-center gap-2"><Line box="h-4" bar="h-3 w-8" /><Line box="h-6" bar="h-4 w-32" /><span className={`${s.skeletonBar} h-[22px] w-12`} /></span>
      <Line box="h-5" bar="h-3 w-1/2" />
      <span className="flex flex-col"><Line box="h-7" bar="h-3.5 w-full" /><Line box="h-7" bar="h-3.5 w-4/5" /></span>
    </div>)}
  </div>
}
