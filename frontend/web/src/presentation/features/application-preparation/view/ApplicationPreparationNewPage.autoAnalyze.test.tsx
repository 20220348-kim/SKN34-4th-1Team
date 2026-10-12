// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { supportProgramDetails, supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { ApplicationForm, ApplicationFormAvailability, ApplicationFormDiscoveryJob } from '../../../../domain/entities/ApplicationPreparation'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { ApplicationPreparationNewPage } from './ApplicationPreparationNewPage'

vi.mock('../../../shared/plan-usage/usePlanUsage', () => {
  const usage = { usage: null, reload: vi.fn() }
  return { usePlanUsage: () => usage }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const account = { email: 'admin@govbiz.local', role: 'ADMIN' as const, tier: 'ADMIN' as const,
  emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const program = { sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id }
const form: ApplicationForm = {
  ...program, programTitle: supportPrograms[0].title, formVersionId: 'stored-form-v1', formTitle: '사업계획서',
  sourceUrl: supportPrograms[0].sourceUrl, attachmentFileName: '사업계획서.hwpx', attachmentSha256: 'a'.repeat(64),
  verificationStatus: 'SOURCE_DOCUMENT_EXTRACTED', institutionReviewed: false, supportedServiceFields: ['GENERAL'], sections: [],
}

function availability(items: ApplicationForm[]): ApplicationFormAvailability {
  return { state: { ...program, status: items.length ? 'AVAILABLE' : 'PENDING', reasonCode: items.length ? 'FORM_FOUND' : 'NOT_ANALYZED',
    nextRetryAt: null, attemptCount: 0, warnings: [] }, forms: { items } }
}

const queued: ApplicationFormDiscoveryJob = { id: 17, ...program, programTitle: supportPrograms[0].title, programSourceUrl: form.sourceUrl,
  status: 'QUEUED', createdAt: new Date().toISOString(), failureCode: null, result: null }

function Location() { const location = useLocation(); return <output data-testid="location">{location.search}</output> }

async function open(items: ApplicationForm[], analyze: boolean) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0]!)
  vi.spyOn(useCase, 'availability').mockResolvedValue(availability(items))
  vi.spyOn(useCase, 'discoveryJobs').mockResolvedValue([])
  vi.spyOn(useCase, 'discoveryJob').mockResolvedValue(queued)
  vi.spyOn(useCase, 'markDiscoveryJobsSeen').mockResolvedValue(undefined)
  const discover = vi.spyOn(useCase, 'discover').mockResolvedValue(queued)
  const store = createAppStore()
  store.dispatch(signedIn(account))
  const search = new URLSearchParams({ ...program, ...(analyze ? { analyze: '1' } : {}) })
  await act(async () => {
    render(<Provider store={store}><MemoryRouter initialEntries={[`/app/application-preparations/new?${search}`]}><Location /><Routes>
      <Route path="/app/application-preparations/new" element={<ApplicationPreparationNewPage />} />
    </Routes></MemoryRouter></Provider>)
  })
  return discover
}

it('starts input analysis once when opened from the Gov 신청서 쓰기 chip for a program without a stored form', async () => {
  const discover = await open([], true)
  expect(discover).toHaveBeenCalledOnce()
  expect(discover).toHaveBeenCalledWith(program.sourceCode, program.sourceProgramId, expect.any(AbortSignal), expect.any(String))
  // 한 번 판단하면 주소에서 지워 새로고침으로 다시 시작하지 않습니다.
  expect(screen.getByTestId('location').textContent).not.toContain('analyze')
})

it('does not analyze from the chip when a form is stored, nor when the page is opened without the chip', async () => {
  expect(await open([form], true)).not.toHaveBeenCalled()
  expect(screen.getByTestId('location').textContent).not.toContain('analyze')
  cleanup()
  vi.restoreAllMocks()
  expect(await open([], false)).not.toHaveBeenCalled()
})
