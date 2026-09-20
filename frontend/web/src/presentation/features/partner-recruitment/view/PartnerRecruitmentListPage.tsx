import { Link } from 'react-router'

import type { PartnerRecruitmentSummary } from '../../../../domain/entities/PartnerRecruitment'
import {
  workspacePageStyles,
  workspaceTagClassName,
} from '../../../shared/workspace/WorkspacePage.styles'
import { PartnerManagementHeader } from '../../../shared/partner-recruitment/PartnerManagementHeader'
import { FilterChoices } from '../../../shared/workspace/FilterChoices'
import { FilterMultiChoices } from '../../../shared/workspace/FilterMultiChoices'
import {
  companyInitial,
  companySummaryLine,
  programDeadlineLabel,
  recruitmentConditionTags,
  recruitmentDeadlineLabel,
} from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { appPaths } from '../../../shared/routes/appPaths'
import { usePartnerRecruitmentListViewModel } from '../viewmodel/usePartnerRecruitmentListViewModel'
import { partnerRecruitmentStyles } from './PartnerRecruitment.styles'

function RecruitmentCard({ recruitment }: { recruitment: PartnerRecruitmentSummary }) {
  const cardClassName = recruitment.isMine
    ? workspacePageStyles.outlinedCard
    : workspacePageStyles.card

  return (
    <article className={cardClassName} aria-label={recruitment.title}>
      <div className={partnerRecruitmentStyles.cardTop}>
        <span className={workspaceTagClassName(recruitment.isMine ? 'warn' : 'ok')}>
          {recruitment.isMine ? '내가 쓴 모집글' : '기업마당 공고'}
        </span>
        <span
          className={
            recruitment.isMine || recruitment.status === 'CLOSED'
              ? partnerRecruitmentStyles.mineDeadline
              : partnerRecruitmentStyles.cardDeadline
          }
        >
          {recruitment.status === 'CLOSED' ? '모집 마감' : recruitmentDeadlineLabel(recruitment.recruitmentDeadline)}
        </span>
      </div>

      <div className="flex flex-col gap-[0.2rem]">
        <h3 className={partnerRecruitmentStyles.cardTitle}>{recruitment.title}</h3>
        <p className={partnerRecruitmentStyles.cardProgram}>
          {recruitment.program.title} · {recruitment.program.organization} ·{' '}
          {programDeadlineLabel(recruitment.program.applicationEndDate)}
        </p>
      </div>

      <div className={partnerRecruitmentStyles.authorRow}>
        <span
          className={`${partnerRecruitmentStyles.authorAvatar} ${
            recruitment.isMine
              ? partnerRecruitmentStyles.authorAvatarMine
              : partnerRecruitmentStyles.authorAvatarOther
          }`}
          aria-hidden="true"
        >
          {companyInitial(recruitment.company.companyName)}
        </span>
        <span className="min-w-0">
          <span className={partnerRecruitmentStyles.authorName}>{recruitment.company.companyName}</span>
          <span className={partnerRecruitmentStyles.authorSummary}>{companySummaryLine(recruitment.company)}</span>
        </span>
      </div>

      <div className={partnerRecruitmentStyles.tagRow}>
        {recruitmentConditionTags(recruitment).map((tag) => (
          <span className={workspaceTagClassName('muted')} key={tag} title={tag}>
            {tag}
          </span>
        ))}
      </div>

      <div className={partnerRecruitmentStyles.cardFooter}>
        {recruitment.isMine ? (
          <span className={partnerRecruitmentStyles.cardFooterNote}>
            받은 제안 {recruitment.proposalCount}건
          </span>
        ) : (
          <span className={partnerRecruitmentStyles.cardFooterNote}>
            제안 {recruitment.proposalCount}건
          </span>
        )}
        <Link
          className={recruitment.isMine ? workspacePageStyles.secondaryButton : workspacePageStyles.primaryButton}
          to={`${appPaths.partnerDetail}?${new URLSearchParams({ recruitmentId: String(recruitment.id) })}`}
        >
          {recruitment.isMine ? '받은 제안 보기' : '자세히 보기'}
        </Link>
      </div>
    </article>
  )
}

/** 파트너 모집 목록입니다. 모집글은 모두 공식 공고 하나에 묶이며 공고가 마감되면 모집도 종료됩니다. */
export function PartnerRecruitmentListPage() {
  const {
    phase,
    recruitments,
    totalPages,
    retry,
    query,
    draft,
    roleOptions,
    regionOptions,
    sortOptions,
    updateKeyword,
    toggleSeekingRole,
    clearSeekingRoles,
    toggleRegion,
    clearRegions,
    submitSearch,
    selectSort,
    goToPage,
    hasActiveNarrowing,
    clearNarrowing,
    resultSummary,
  } = usePartnerRecruitmentListViewModel()

  return (
    <>
      <PartnerManagementHeader active="recruitments" />

      <div className={workspacePageStyles.content}>
        <div className={workspacePageStyles.column}>
          {/* 검색어·역할·지역은 조회를 눌러야 적용됩니다. 내 글만·정렬은 바로 적용됩니다. */}
          <form
            className={partnerRecruitmentStyles.filterPanel}
            aria-label="모집글 검색과 필터"
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
          >
            <div className={partnerRecruitmentStyles.searchRow}>
            <label className={partnerRecruitmentStyles.search}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <span className="sr-only">모집글 검색</span>
              <input
                className={partnerRecruitmentStyles.searchInput}
                type="search"
                name="keyword"
                placeholder="공고명, 기관, 기업명 검색"
                value={draft.keyword}
                onChange={(event) => updateKeyword(event.target.value)}
              />
            </label>
            <button className={workspacePageStyles.primaryButton} type="submit">조회</button>
            </div>

            <FilterMultiChoices label="찾는 역할" name="partner-role" options={roleOptions} selected={draft.seekingRoles} onToggle={toggleSeekingRole} onClearAll={clearSeekingRoles} />
            <FilterMultiChoices label="지역" name="partner-region" options={regionOptions} selected={draft.regions} onToggle={toggleRegion} onClearAll={clearRegions} />
            <FilterChoices label="정렬" name="partner-sort" options={sortOptions} selected={query.sort} onSelect={selectSort} includeAll={false} />

            <div className={partnerRecruitmentStyles.filterFooter}>
              <span className={partnerRecruitmentStyles.tagRow}>
                {hasActiveNarrowing ? (
                  <button className={workspacePageStyles.quietLink} type="button" onClick={clearNarrowing}>검색·필터 초기화</button>
                ) : null}
              </span>
              <span className={partnerRecruitmentStyles.resultCount} aria-live="polite">{resultSummary}</span>
            </div>
          </form>

          {phase === 'failed' ? (
            <section className={workspacePageStyles.card} aria-label="모집글 불러오기 실패">
              <p className={workspacePageStyles.emptyNote}>모집글을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
              <button className={workspacePageStyles.quietLink} type="button" onClick={retry}>다시 시도</button>
            </section>
          ) : phase === 'loading' && recruitments.length === 0 ? (
            <section className={workspacePageStyles.card} aria-label="모집글 불러오는 중">
              <p className={workspacePageStyles.emptyNote}>모집글을 불러오는 중입니다.</p>
            </section>
          ) : recruitments.length === 0 ? (
            <section className={workspacePageStyles.card} aria-label="검색 결과 없음">
              <p className={workspacePageStyles.emptyNote}>
                {hasActiveNarrowing ? '조건에 맞는 모집글이 없습니다. 검색어나 필터를 바꾸거나 초기화해 보세요.' : '아직 모집 중인 글이 없습니다. 첫 모집글을 올려 보세요.'}
              </p>
            </section>
          ) : (
            <>
              <div className={partnerRecruitmentStyles.cardGrid}>
                {recruitments.map((recruitment) => (
                  <RecruitmentCard key={recruitment.id} recruitment={recruitment} />
                ))}
              </div>
              {totalPages > 1 ? (
                <nav className={partnerRecruitmentStyles.pagination} aria-label="모집글 페이지">
                  <button className={workspacePageStyles.secondaryButton} type="button" disabled={query.page <= 1} onClick={() => goToPage(query.page - 1)}>
                    이전
                  </button>
                  <span className={partnerRecruitmentStyles.resultCount}>{query.page} / {totalPages}</span>
                  <button className={workspacePageStyles.secondaryButton} type="button" disabled={query.page >= totalPages} onClick={() => goToPage(query.page + 1)}>
                    다음
                  </button>
                </nav>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  )
}
