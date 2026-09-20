import { useEffect, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { SupportProgramCatalog, SupportProgramCatalogFilters } from '../../../../domain/entities/SupportProgramCatalog'
import type { BrowseSupportProgramsUseCase } from '../../../../domain/usecases/BrowseSupportProgramsUseCase'
import {
  defaultCatalogApplicantTypes, defaultCatalogCategories, defaultCatalogFounderAges,
  defaultCatalogRegions, defaultCatalogStartupStages, mergeCatalogFilterOptions,
} from './catalogFilterOptions'

type CatalogState = { key: string; phase: 'loading' | 'ready' | 'failed'; data: SupportProgramCatalog | null }

export function useSupportProgramCatalogViewModel(filters: SupportProgramCatalogFilters,
  useCase: Pick<BrowseSupportProgramsUseCase, 'execute'> = appContainer.resolve('browseSupportProgramsUseCase')) {
  const key = JSON.stringify(filters)
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<CatalogState>({ key, phase: 'loading', data: null })
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    setState((previous) => ({ key, phase: 'loading', data: previous.data }))
    const timer = setTimeout(() => {
      if (!current) return
      controller.abort()
      setState((previous) => ({ ...previous, key, phase: 'failed' }))
    }, 10_000)
    void Promise.resolve().then(() => useCase.execute(JSON.parse(key) as SupportProgramCatalogFilters, controller.signal))
      .then((data) => { if (current && !controller.signal.aborted) setState({ key, phase: 'ready', data }) })
      .catch(() => { if (current && !controller.signal.aborted) setState((previous) => ({ ...previous, key, phase: 'failed' })) })
      .finally(() => clearTimeout(timer))
    return () => { current = false; clearTimeout(timer); controller.abort() }
  }, [key, version, useCase])
  const phase = state.key === key ? state.phase : 'loading'
  return { phase, data: phase === 'ready' ? state.data : null,
    regions: mergeCatalogFilterOptions(defaultCatalogRegions, state.data?.regions),
    categories: mergeCatalogFilterOptions(defaultCatalogCategories, state.data?.categories),
    startupStages: mergeCatalogFilterOptions(defaultCatalogStartupStages, state.data?.startupStages),
    applicantTypes: mergeCatalogFilterOptions(defaultCatalogApplicantTypes, state.data?.applicantTypes),
    founderAges: mergeCatalogFilterOptions(defaultCatalogFounderAges, state.data?.founderAges),
    retry: () => setVersion((value) => value + 1) }
}
