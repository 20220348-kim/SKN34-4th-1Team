import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { CatalogScreen } from './CatalogScreen'
import { programClient } from '../api/client'

jest.mock('../api/client', () => ({ programClient: jest.fn(), errorMessage: () => '검색 조건을 확인해 주세요.' }))

const emptyPage = { programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [],
  startupStages: [], applicantTypes: [], founderAges: [] }

describe('native catalog', () => {
  it('keeps draft input local until search and shows validation errors without crashing', async () => {
    const browseCatalog = jest.fn().mockResolvedValue(emptyPage)
    jest.mocked(programClient).mockReturnValue({ browseCatalog } as unknown as ReturnType<typeof programClient>)
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await screen.findByText('검색 결과 0건')
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), 'invalid\u200bkeyword')
    expect(browseCatalog).toHaveBeenCalledTimes(1)
    fireEvent.press(screen.getByText('공고 검색'))
    await screen.findByText('검색 조건을 확인해 주세요.')
    expect(browseCatalog).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('검색 결과 0건')).toBeNull()
  })

  it('does not let a late old response overwrite the latest search', async () => {
    let resolveOld: (value: typeof emptyPage) => void = () => undefined
    const browseCatalog = jest.fn()
      .mockImplementationOnce(() => new Promise<typeof emptyPage>((resolve) => { resolveOld = resolve }))
      .mockResolvedValue(emptyPage)
    jest.mocked(programClient).mockReturnValue({ browseCatalog } as unknown as ReturnType<typeof programClient>)
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '새 검색')
    fireEvent.press(screen.getByText('공고 검색'))
    await screen.findByText('검색 결과 0건')
    await act(async () => { resolveOld({ ...emptyPage, total: 999 }) })
    expect(screen.queryByText('검색 결과 999건')).toBeNull()
    expect(screen.getByText('검색 결과 0건')).toBeTruthy()
  })
})
