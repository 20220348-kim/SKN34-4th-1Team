import { Text } from 'react-native'
import { act, render, waitFor } from '@testing-library/react-native'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { useApplicationPreparationEditor } from './useApplicationPreparationEditor'
import { documentPreparation } from '../test/applicationDocumentFixtures'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => () => void) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(callback, [callback])
} }))
const mockInvalidateSession = jest.fn()
jest.mock('../auth/session', () => ({ useAuth: () => ({ invalidateSession: mockInvalidateSession }) }))
jest.mock('../api/applicationPreparation', () => ({ applicationPreparationUseCase: jest.fn() }))
const api = { get: jest.fn(), replaceInputs: jest.fn() }
let vm: ReturnType<typeof useApplicationPreparationEditor>
function Probe() { vm = useApplicationPreparationEditor(9, 'owned'); return <Text>{vm.preparation?.inputRevision}:{vm.pending['company:name'] ?? ''}</Text> }
function changed(revision: number, name: string, goal = '생산 개선') {
  return { ...documentPreparation, inputRevision: revision, form: { ...documentPreparation.form, sections: documentPreparation.form.sections.map(section => ({ ...section,
    facts: section.facts.map(fact => ({ ...fact, inputRevision: revision, value: fact.fieldKey === 'name' ? name : goal })),
  })) } }
}
beforeEach(() => {
  api.get.mockReset().mockResolvedValue(documentPreparation); api.replaceInputs.mockReset()
  jest.mocked(applicationPreparationUseCase).mockReturnValue(api as unknown as ReturnType<typeof applicationPreparationUseCase>)
})
test('a change made while saving is preserved and saved with the new producer revision', async () => {
  let finish!: (value: unknown) => void
  api.replaceInputs.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(changed(3, '두 번째 입력'))
  render(<Probe />); await waitFor(() => expect(vm.preparation).not.toBeNull())
  await act(async () => vm.change('company:name', '첫 번째 입력'))
  let saving!: Promise<boolean>
  await act(async () => { saving = vm.flush() })
  await waitFor(() => expect(api.replaceInputs).toHaveBeenCalledTimes(1))
  await act(async () => vm.change('company:name', '두 번째 입력'))
  await act(async () => { finish(changed(2, '첫 번째 입력')); await saving })
  expect(api.replaceInputs).toHaveBeenLastCalledWith(9, 'company', expect.objectContaining({ expectedRevision: 2, facts: expect.arrayContaining([expect.objectContaining({ fieldKey: 'name', value: '두 번째 입력' })]) }), expect.any(AbortSignal))
  expect(vm.pending).toEqual({}); expect(vm.preparation?.inputRevision).toBe(3)
})
test('revision conflict retains my input and preserves untouched values from latest server state on explicit approval', async () => {
  api.get.mockResolvedValueOnce(documentPreparation).mockResolvedValueOnce(changed(2, '서버 기업', '서버 목표'))
  api.replaceInputs.mockRejectedValueOnce(new ApplicationPreparationError(409, 'APPLICATION_PREPARATION_REVISION_CONFLICT')).mockResolvedValueOnce(changed(3, '내 기업', '서버 목표'))
  render(<Probe />); await waitFor(() => expect(vm.preparation).not.toBeNull())
  await act(async () => { vm.change('company:name', '내 기업'); await vm.flush() })
  expect(vm.conflict).toBe(true); expect(vm.pending['company:name']).toBe('내 기업')
  await act(async () => { await vm.resolveConflict(true) })
  expect(api.replaceInputs).toHaveBeenLastCalledWith(9, 'company', expect.objectContaining({ expectedRevision: 2, facts: expect.arrayContaining([
    expect.objectContaining({ fieldKey: 'name', value: '내 기업' }), expect.objectContaining({ fieldKey: 'goal', value: '서버 목표' }),
  ]) }), expect.any(AbortSignal))
})
test('failed saving leaves the answer pending and prevents a successful departure', async () => {
  api.replaceInputs.mockRejectedValue(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  render(<Probe />); await waitFor(() => expect(vm.preparation).not.toBeNull())
  let saved = true
  await act(async () => { vm.change('company:name', '잃으면 안 되는 입력'); saved = await vm.flush() })
  expect(saved).toBe(false); expect(vm.pending['company:name']).toBe('잃으면 안 되는 입력'); expect(vm.saveError).not.toBeNull()
})
