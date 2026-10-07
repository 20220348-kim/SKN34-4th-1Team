import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Linking } from 'react-native'
import type { programClient } from '../api/client'
import { ProgramAttachments } from './ProgramAttachments'

const identity = { sourceCode: 'KSTARTUP', sourceProgramId: '179431' }

function clientWith(getAttachments: jest.Mock) {
  return {
    getAttachments,
    attachmentDownloadUrl: (_: typeof identity, index: number) => `https://api.example.test/api/v1/support-programs/detail/attachments/download?index=${index}`,
  } as unknown as ReturnType<typeof programClient>
}

afterEach(() => jest.restoreAllMocks())

test('공식 첨부를 형식과 함께 보여 주고 누르면 Core 받기 주소를 브라우저로 연다', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  const getAttachments = jest.fn().mockResolvedValue([
    { index: 0, fileName: '[첨부파일] 서식1. 사업계획서.hwp', extension: 'hwp' },
    { index: 1, fileName: '서식 모음.zip', extension: 'zip' },
  ])

  render(<ProgramAttachments client={clientWith(getAttachments)} identity={identity} />)

  expect(await screen.findByText('[첨부파일] 서식1. 사업계획서.hwp')).toBeTruthy()
  expect(screen.getByText('ZIP')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('서식 모음.zip 받기'))
  expect(open).toHaveBeenCalledWith('https://api.example.test/api/v1/support-programs/detail/attachments/download?index=1')
  expect(getAttachments).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
})

test('원문을 읽지 못하면 원문 확인을 안내하고, 첨부가 없으면 카드를 그리지 않는다', async () => {
  const { unmount } = render(<ProgramAttachments client={clientWith(jest.fn().mockRejectedValue(new Error('private')))} identity={identity} />)
  expect(await screen.findByText('첨부파일을 불러오지 못했어요. 공식 공고 원문에서 확인해 주세요.')).toBeTruthy()
  expect(screen.queryByText('private')).toBeNull()
  unmount()

  const empty = jest.fn().mockResolvedValue([])
  render(<ProgramAttachments client={clientWith(empty)} identity={identity} />)
  await waitFor(() => expect(empty).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByText('첨부파일')).toBeNull())
})
